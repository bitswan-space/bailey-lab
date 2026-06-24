package daemon

import (
	"crypto/rand"
	"database/sql"
	"errors"
	"os"
	"strings"
)

// CRUD on the totp_records table plus the per-server HMAC signing key
// stored in singletons. Ported from #340's bailey_store.go; kept in its
// own file so the MFA store helpers live together. Schema for both
// tables lives in baileySchema (bailey_store.go).

// dbLoadTOTP returns the TOTP record for email, or os.ErrNotExist when
// the user has not enrolled. Callers in mfa_*.go treat a nil record as
// "not enrolled" (they ignore the returned error), so the sentinel just
// lets store-level callers distinguish missing from a real read error.
func dbLoadTOTP(email string) (*totpRecord, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	var rec totpRecord
	row := db.QueryRow(
		`SELECT email, secret, created_at FROM totp_records WHERE email = ? COLLATE NOCASE`, email)
	if err := row.Scan(&rec.Email, &rec.Secret, &rec.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, os.ErrNotExist
		}
		return nil, err
	}
	return &rec, nil
}

func dbSaveTOTP(rec *totpRecord) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	_, err = db.Exec(
		`INSERT INTO totp_records(email, secret, created_at) VALUES (?, ?, ?)
		 ON CONFLICT(email) DO UPDATE SET secret = excluded.secret, created_at = excluded.created_at`,
		rec.Email, rec.Secret, rec.CreatedAt)
	return err
}

func dbDeleteTOTP(email string) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	_, err = db.Exec(`DELETE FROM totp_records WHERE email = ? COLLATE NOCASE`, email)
	return err
}

// dbListTOTPEnrolledEmails returns the set of emails with TOTP set up.
func dbListTOTPEnrolledEmails() (map[string]bool, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(`SELECT email FROM totp_records`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return nil, err
		}
		out[strings.ToLower(e)] = true
	}
	return out, rows.Err()
}

// dbSigningKey returns the per-server HMAC key used to sign session
// cookies, generating and persisting a fresh 32-byte key on first use.
func dbSigningKey() ([]byte, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	var key []byte
	row := db.QueryRow(`SELECT value FROM singletons WHERE key = 'signing_key'`)
	if err := row.Scan(&key); err == nil && len(key) >= 32 {
		return key, nil
	} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return nil, err
	}
	if _, err := db.Exec(
		`INSERT INTO singletons(key, value) VALUES ('signing_key', ?) ON CONFLICT(key) DO NOTHING`,
		buf); err != nil {
		return nil, err
	}
	if err := db.QueryRow(`SELECT value FROM singletons WHERE key = 'signing_key'`).Scan(&key); err != nil {
		return nil, err
	}
	return key, nil
}
