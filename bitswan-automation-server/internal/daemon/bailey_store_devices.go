package daemon

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

// CRUD on the devices table. One row per paired device; owner is the
// email of the user who paired it. Extracted from bailey_store.go so
// the device helpers live alongside the rest of the bailey store CRUD.

// dbListAllDevices returns every paired device on the server,
// ordered first by email and then by paired_at. Used by the admin
// Devices page to render the per-user device tree.
func dbListAllDevices() ([]deviceRecord, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(
		`SELECT email, id, name, paired_at, COALESCE(last_seen, ''), COALESCE(origin, '') FROM devices ORDER BY email COLLATE NOCASE, paired_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []deviceRecord
	for rows.Next() {
		var d deviceRecord
		if err := rows.Scan(&d.Email, &d.ID, &d.Name, &d.PairedAt, &d.LastSeen, &d.Origin); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func dbListDevices(email string) ([]deviceRecord, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(
		`SELECT id, name, paired_at, COALESCE(last_seen, ''), COALESCE(origin, '') FROM devices WHERE email = ? COLLATE NOCASE ORDER BY paired_at`,
		email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []deviceRecord
	for rows.Next() {
		var d deviceRecord
		if err := rows.Scan(&d.ID, &d.Name, &d.PairedAt, &d.LastSeen, &d.Origin); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func dbAddDevice(email, name, origin string) (*deviceRecord, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	idBytes := make([]byte, deviceIDLen/2)
	if _, err := rand.Read(idBytes); err != nil {
		return nil, err
	}
	if strings.TrimSpace(name) == "" {
		name = "Device added " + time.Now().UTC().Format("2006-01-02")
	}
	rec := deviceRecord{
		ID:       hex.EncodeToString(idBytes),
		Name:     name,
		PairedAt: time.Now().UTC().Format(time.RFC3339),
		Origin:   origin,
	}
	if _, err := db.Exec(
		`INSERT INTO devices(id, email, name, paired_at, origin) VALUES (?, ?, ?, ?, ?)`,
		rec.ID, email, rec.Name, rec.PairedAt, rec.Origin); err != nil {
		return nil, err
	}
	return &rec, nil
}

// dbRenameDevice sets a device's display name. The WHERE clause is scoped to
// the owner's email exactly like dbRemoveDevice, so a caller can only ever
// rename their own device — the id alone never authorises the write.
//
// Reports whether a row actually changed, so the caller can answer 404 for an
// id that isn't the caller's rather than a silent 200 that renamed nothing.
func dbRenameDevice(email, id, name string) (bool, error) {
	db, err := openBaileyDB()
	if err != nil {
		return false, err
	}
	res, err := db.Exec(`UPDATE devices SET name = ? WHERE id = ? AND email = ? COLLATE NOCASE`,
		name, id, email)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

func dbRemoveDevice(email, id string) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	_, err = db.Exec(`DELETE FROM devices WHERE id = ? AND email = ? COLLATE NOCASE`, id, email)
	return err
}

func dbFindDevice(email, id string) (*deviceRecord, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	var d deviceRecord
	row := db.QueryRow(
		`SELECT id, name, paired_at, COALESCE(last_seen, '') FROM devices WHERE id = ? AND email = ? COLLATE NOCASE`,
		id, email)
	if err := row.Scan(&d.ID, &d.Name, &d.PairedAt, &d.LastSeen); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &d, nil
}

func dbTouchDevice(email, id string) {
	db, err := openBaileyDB()
	if err != nil {
		return
	}
	_, _ = db.Exec(`UPDATE devices SET last_seen = ? WHERE id = ? AND email = ? COLLATE NOCASE`,
		time.Now().UTC().Format(time.RFC3339), id, email)
}

func dbAnyDevicesExist() bool {
	db, err := openBaileyDB()
	if err != nil {
		return false
	}
	var n int
	_ = db.QueryRow(`SELECT COUNT(*) FROM devices`).Scan(&n)
	return n > 0
}
