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
		`SELECT email, id, name, paired_at, COALESCE(last_seen, '') FROM devices ORDER BY email COLLATE NOCASE, paired_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []deviceRecord
	for rows.Next() {
		var d deviceRecord
		if err := rows.Scan(&d.Email, &d.ID, &d.Name, &d.PairedAt, &d.LastSeen); err != nil {
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
		`SELECT id, name, paired_at, COALESCE(last_seen, '') FROM devices WHERE email = ? COLLATE NOCASE ORDER BY paired_at`,
		email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []deviceRecord
	for rows.Next() {
		var d deviceRecord
		if err := rows.Scan(&d.ID, &d.Name, &d.PairedAt, &d.LastSeen); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func dbAddDevice(email, name string) (*deviceRecord, error) {
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
	}
	if _, err := db.Exec(
		`INSERT INTO devices(id, email, name, paired_at) VALUES (?, ?, ?, ?)`,
		rec.ID, email, rec.Name, rec.PairedAt); err != nil {
		return nil, err
	}
	return &rec, nil
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
