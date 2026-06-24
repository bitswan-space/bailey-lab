package daemon

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"time"
)

// CRUD on the backup_codes table. Backup codes are an opt-in recovery
// shortcut (set up in the console's Security & recovery alongside the
// authenticator). They are single-use: consuming a code deletes its row.
//
// Codes are stored hashed (SHA-256 of the normalised code) so a database
// leak doesn't hand an attacker live recovery codes. Normalisation
// uppercases and strips everything but [A-Z0-9] so formatting (dashes,
// spaces, case) doesn't matter on entry.

func normalizeBackupCode(code string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(code) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func hashBackupCode(code string) string {
	sum := sha256.Sum256([]byte(normalizeBackupCode(code)))
	return hex.EncodeToString(sum[:])
}

// dbBackupCodesExist reports whether the user has any unused backup codes.
func dbBackupCodesExist(email string) bool {
	db, err := openBaileyDB()
	if err != nil {
		return false
	}
	var n int
	_ = db.QueryRow(`SELECT COUNT(*) FROM backup_codes WHERE email = ? COLLATE NOCASE`, email).Scan(&n)
	return n > 0
}

// dbSaveBackupCodes replaces the user's backup codes with the given set
// (plaintext in, hashed on disk). Called by the opt-in Security & recovery
// enrolment when (re)generating codes.
func dbSaveBackupCodes(email string, codes []string) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM backup_codes WHERE email = ? COLLATE NOCASE`, email); err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	for _, c := range codes {
		if normalizeBackupCode(c) == "" {
			continue
		}
		if _, err := tx.Exec(
			`INSERT OR IGNORE INTO backup_codes(email, code_hash, created_at) VALUES (?, ?, ?)`,
			email, hashBackupCode(c), now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// dbConsumeBackupCode validates and burns a single backup code. Returns
// true iff the code matched an unused row (which is then deleted).
func dbConsumeBackupCode(email, code string) (bool, error) {
	if normalizeBackupCode(code) == "" {
		return false, nil
	}
	db, err := openBaileyDB()
	if err != nil {
		return false, err
	}
	res, err := db.Exec(
		`DELETE FROM backup_codes WHERE email = ? COLLATE NOCASE AND code_hash = ?`,
		email, hashBackupCode(code))
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}
