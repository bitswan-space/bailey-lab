package daemon

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"time"
)

// CRUD on the invites table. An invite pre-authorises one AOC-org
// member's FIRST device: the admin-facing lifecycle lives in
// bailey_people_invites.go and redemption in the invite-redeem gate
// API. Tokens are stored as SHA-256 hex digests (see hashInviteToken);
// the raw token exists only in the emailed/copied link. Time fields
// are RFC3339 UTC strings in the DB, parsed back at read time.

// inviteRecord is one invites row.
type inviteRecord struct {
	Email      string
	TokenHash  string
	Role       string
	CreatedBy  string
	CreatedAt  time.Time
	ExpiresAt  time.Time
	ConsumedAt string // RFC3339 ("" = unconsumed)
	EmailSent  bool
}

// inviteTTL is how long an invite link stays redeemable.
const inviteTTL = 48 * time.Hour

func (inv *inviteRecord) consumed() bool { return inv.ConsumedAt != "" }

func (inv *inviteRecord) expired(now time.Time) bool { return now.After(inv.ExpiresAt) }

// live = still redeemable: neither consumed nor past its TTL.
func (inv *inviteRecord) live(now time.Time) bool { return !inv.consumed() && !inv.expired(now) }

// generateInviteToken mints a fresh invite token (32 bytes of
// crypto/rand, URL-safe base64 — it rides a link query param) and its
// storage hash.
func generateInviteToken() (token, hashHex string, err error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	token = base64.RawURLEncoding.EncodeToString(buf)
	return token, hashInviteToken(token), nil
}

func hashInviteToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// dbUpsertInvite creates or replaces the invite for inv.Email.
// Re-inviting deliberately replaces the whole row (fresh token, fresh
// expiry, possibly a different role) — there is at most one
// outstanding invite per email.
func dbUpsertInvite(inv *inviteRecord) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	_, err = db.Exec(`INSERT INTO invites(email, token_hash, role, created_by, created_at, expires_at, consumed_at, email_sent)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(email) DO UPDATE SET
		  token_hash  = excluded.token_hash,
		  role        = excluded.role,
		  created_by  = excluded.created_by,
		  created_at  = excluded.created_at,
		  expires_at  = excluded.expires_at,
		  consumed_at = excluded.consumed_at,
		  email_sent  = excluded.email_sent`,
		inv.Email, inv.TokenHash, inv.Role, inv.CreatedBy,
		inv.CreatedAt.UTC().Format(time.RFC3339Nano),
		inv.ExpiresAt.UTC().Format(time.RFC3339Nano),
		nullableString(inv.ConsumedAt),
		inv.EmailSent,
	)
	return err
}

const inviteColumns = `email, token_hash, role, created_by, created_at, expires_at, COALESCE(consumed_at,''), email_sent`

func dbLoadInviteByTokenHash(hash string) (*inviteRecord, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	row := db.QueryRow(`SELECT `+inviteColumns+` FROM invites WHERE token_hash = ?`, hash)
	return scanInvite(row)
}

func dbLoadInviteByEmail(email string) (*inviteRecord, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	row := db.QueryRow(`SELECT `+inviteColumns+` FROM invites WHERE email = ? COLLATE NOCASE`, email)
	return scanInvite(row)
}

// dbListUnconsumedInvites returns every not-yet-redeemed invite,
// including expired ones — the People view shows those as "expired" so
// the admin can resend or revoke them.
func dbListUnconsumedInvites() ([]inviteRecord, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(`SELECT ` + inviteColumns + ` FROM invites WHERE consumed_at IS NULL ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []inviteRecord{}
	for rows.Next() {
		var inv inviteRecord
		var created, expires string
		if err := rows.Scan(&inv.Email, &inv.TokenHash, &inv.Role, &inv.CreatedBy,
			&created, &expires, &inv.ConsumedAt, &inv.EmailSent); err != nil {
			return nil, err
		}
		inv.CreatedAt, _ = time.Parse(time.RFC3339Nano, created)
		inv.ExpiresAt, _ = time.Parse(time.RFC3339Nano, expires)
		out = append(out, inv)
	}
	return out, rows.Err()
}

// dbConsumeInviteAtomic burns the invite with the given token hash.
// The guard (unconsumed AND unexpired) lives inside the single UPDATE
// so two concurrent redeems can't both succeed — exactly one caller
// sees true (the dbConsumeBackupCode pattern). Callers mint the device
// only after winning this claim.
func dbConsumeInviteAtomic(tokenHash string, now time.Time) (bool, error) {
	db, err := openBaileyDB()
	if err != nil {
		return false, err
	}
	res, err := db.Exec(
		`UPDATE invites SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
		now.UTC().Format(time.RFC3339Nano), tokenHash, now.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// dbDeleteInvite removes the invite for email (revoke). Returns true
// iff a row was actually deleted.
func dbDeleteInvite(email string) (bool, error) {
	db, err := openBaileyDB()
	if err != nil {
		return false, err
	}
	res, err := db.Exec(`DELETE FROM invites WHERE email = ? COLLATE NOCASE`, email)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

func dbSetInviteEmailSent(email string, sent bool) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	_, err = db.Exec(`UPDATE invites SET email_sent = ? WHERE email = ? COLLATE NOCASE`, sent, email)
	return err
}

type inviteRow interface {
	Scan(dest ...any) error
}

func scanInvite(row inviteRow) (*inviteRecord, error) {
	var inv inviteRecord
	var created, expires string
	err := row.Scan(&inv.Email, &inv.TokenHash, &inv.Role, &inv.CreatedBy,
		&created, &expires, &inv.ConsumedAt, &inv.EmailSent)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil // genuinely no row — callers treat (nil, nil) as "not found"
	}
	if err != nil {
		// A real error (locked DB, corrupt row) must NOT masquerade as
		// "no invite": that would turn a transient failure into a
		// terminal "invalid/revoked" 404 with no retry for the invitee.
		return nil, err
	}
	inv.CreatedAt, _ = time.Parse(time.RFC3339Nano, created)
	inv.ExpiresAt, _ = time.Parse(time.RFC3339Nano, expires)
	return &inv, nil
}
