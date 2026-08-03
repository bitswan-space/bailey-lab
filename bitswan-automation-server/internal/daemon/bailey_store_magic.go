package daemon

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"time"
)

// magicLink is one reusable, endpoint-scoped device-trust invite (issue #240).
// Only TokenHash is stored; the raw token lives only in the URL.
type magicLink struct {
	ID           string
	EndpointHost string
	CreatedBy    string
	CreatedAt    time.Time
	ExpiresAt    time.Time
	RevokedAt    string // "" when live
}

func (m *magicLink) revoked() bool              { return m.RevokedAt != "" }
func (m *magicLink) expired(now time.Time) bool { return now.After(m.ExpiresAt) }
func (m *magicLink) live(now time.Time) bool    { return !m.revoked() && !m.expired(now) }

// generateMagicToken mints a fresh link token (32 bytes, base64url) and returns
// it alongside the SHA-256 hex stored at rest. The raw token is returned once
// (to embed in the URL) and never persisted.
func generateMagicToken() (token, hashHex string, err error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	token = base64.RawURLEncoding.EncodeToString(buf)
	return token, hashMagicToken(token), nil
}

func hashMagicToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// newMagicLinkID returns a short random id used to reference a link for revoke.
func newMagicLinkID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// dbCreateMagicLink persists a new link and returns the raw token to embed in
// the URL (stored only as a hash).
func dbCreateMagicLink(host, createdBy string, ttl time.Duration) (token string, m *magicLink, err error) {
	db, err := openBaileyDB()
	if err != nil {
		return "", nil, err
	}
	id, err := newMagicLinkID()
	if err != nil {
		return "", nil, err
	}
	token, hashHex, err := generateMagicToken()
	if err != nil {
		return "", nil, err
	}
	now := time.Now().UTC()
	exp := now.Add(ttl)
	if _, err := db.Exec(
		`INSERT INTO magic_links(id, token_hash, endpoint_host, created_by, created_at, expires_at, revoked_at)
		 VALUES (?, ?, ?, ?, ?, ?, NULL)`,
		id, hashHex, host, createdBy, now.Format(time.RFC3339), exp.Format(time.RFC3339),
	); err != nil {
		return "", nil, err
	}
	return token, &magicLink{ID: id, EndpointHost: host, CreatedBy: createdBy, CreatedAt: now, ExpiresAt: exp}, nil
}

const magicLinkColumns = `id, endpoint_host, created_by, created_at, expires_at, COALESCE(revoked_at,'')`

func scanMagicLink(scan func(...any) error) (*magicLink, error) {
	var m magicLink
	var createdAt, expiresAt string
	if err := scan(&m.ID, &m.EndpointHost, &m.CreatedBy, &createdAt, &expiresAt, &m.RevokedAt); err != nil {
		return nil, err
	}
	m.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	m.ExpiresAt, _ = time.Parse(time.RFC3339, expiresAt)
	return &m, nil
}

// dbMagicLinkByTokenHash returns the link for a token hash, or (nil,nil) if none.
func dbMagicLinkByTokenHash(hash string) (*magicLink, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	row := db.QueryRow(`SELECT `+magicLinkColumns+` FROM magic_links WHERE token_hash = ?`, hash)
	m, err := scanMagicLink(row.Scan)
	if err != nil {
		return nil, nil // no rows (or scan error) → treat as "not found"
	}
	return m, nil
}

// dbListMagicLinks returns the LIVE (unrevoked, unexpired) links for a host,
// newest first — for the Share modal.
func dbListMagicLinks(host string) ([]*magicLink, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(`SELECT `+magicLinkColumns+` FROM magic_links
		WHERE endpoint_host = ? COLLATE NOCASE AND revoked_at IS NULL
		ORDER BY created_at DESC`, host)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	now := time.Now().UTC()
	var out []*magicLink
	for rows.Next() {
		m, err := scanMagicLink(rows.Scan)
		if err != nil {
			return nil, err
		}
		if m.live(now) {
			out = append(out, m)
		}
	}
	return out, rows.Err()
}

// dbRevokeMagicLink marks a link revoked. Scoped by host so an owner can only
// revoke links on an endpoint they manage. Returns whether a row changed.
func dbRevokeMagicLink(id, host string) (bool, error) {
	db, err := openBaileyDB()
	if err != nil {
		return false, err
	}
	res, err := db.Exec(`UPDATE magic_links SET revoked_at = ?
		WHERE id = ? AND endpoint_host = ? COLLATE NOCASE AND revoked_at IS NULL`,
		time.Now().UTC().Format(time.RFC3339), id, host)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// dbAddEndpointDeviceTrust records that a device is trusted for one endpoint
// (the magic-link tier). Idempotent (INSERT OR REPLACE refreshes trusted_at).
func dbAddEndpointDeviceTrust(deviceID, host, email string) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	_, err = db.Exec(`INSERT OR REPLACE INTO endpoint_device_trust(device_id, endpoint_host, email, trusted_at)
		VALUES (?, ?, ?, ?)`,
		deviceID, host, email, time.Now().UTC().Format(time.RFC3339))
	return err
}

// dbEndpointDeviceTrusted reports whether device is scoped-trusted for host.
func dbEndpointDeviceTrusted(deviceID, host string) bool {
	db, err := openBaileyDB()
	if err != nil {
		return false
	}
	var one int
	err = db.QueryRow(`SELECT 1 FROM endpoint_device_trust
		WHERE device_id = ? AND endpoint_host = ? COLLATE NOCASE`, deviceID, host).Scan(&one)
	return err == nil
}
