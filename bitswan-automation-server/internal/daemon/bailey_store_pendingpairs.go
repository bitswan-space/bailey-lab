package daemon

import "time"

// CRUD on the pending_pairs table. See mfa_pair.go for the
// in-memory shape (pairingEntry); these helpers translate to/from
// it. Time fields are RFC3339 in the DB; parsed back to time.Time
// at read time.

func dbUpsertPendingPair(e *pairingEntry) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	_, err = db.Exec(`INSERT INTO pending_pairs(email, code, issued_at, expires_at, approved_by, approver_info, user_agent)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(email) DO UPDATE SET
		  code          = excluded.code,
		  issued_at     = excluded.issued_at,
		  expires_at    = excluded.expires_at,
		  approved_by   = excluded.approved_by,
		  approver_info = excluded.approver_info,
		  -- Preserve a previously-captured UA when this refresh has none, so a
		  -- later no-UA re-mint of the same pending entry doesn't erase it.
		  user_agent    = COALESCE(NULLIF(excluded.user_agent, ''), pending_pairs.user_agent)`,
		e.Email, e.Code,
		e.IssuedAt.UTC().Format(time.RFC3339Nano),
		e.ExpiresAt.UTC().Format(time.RFC3339Nano),
		nullableString(e.ApprovedBy),
		nullableString(e.ApproverInfo),
		nullableString(e.UserAgent),
	)
	return err
}

func dbLoadPendingPairByCode(code string) (*pairingEntry, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	row := db.QueryRow(`SELECT email, code, issued_at, expires_at, COALESCE(approved_by,''), COALESCE(approver_info,''), COALESCE(user_agent,'')
		FROM pending_pairs WHERE code = ?`, code)
	return scanPendingPair(row)
}

func dbLoadPendingPairByEmail(email string) (*pairingEntry, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	row := db.QueryRow(`SELECT email, code, issued_at, expires_at, COALESCE(approved_by,''), COALESCE(approver_info,''), COALESCE(user_agent,'')
		FROM pending_pairs WHERE email = ? COLLATE NOCASE`, email)
	return scanPendingPair(row)
}

func dbDeletePendingPairByEmail(email string) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	_, err = db.Exec(`DELETE FROM pending_pairs WHERE email = ? COLLATE NOCASE`, email)
	return err
}

// dbPurgeExpiredPendingPairs drops rows past their TTL. Cheap to run
// any time we touch the table; keeps the table tiny.
func dbPurgeExpiredPendingPairs() error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	_, err = db.Exec(`DELETE FROM pending_pairs WHERE expires_at < ?`,
		time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

func dbListPendingPairs() ([]*pairingEntry, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(`SELECT email, code, issued_at, expires_at, COALESCE(approved_by,''), COALESCE(approver_info,''), COALESCE(user_agent,'')
		FROM pending_pairs`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*pairingEntry
	for rows.Next() {
		var e pairingEntry
		var issued, expires string
		if err := rows.Scan(&e.Email, &e.Code, &issued, &expires, &e.ApprovedBy, &e.ApproverInfo, &e.UserAgent); err != nil {
			return nil, err
		}
		e.IssuedAt, _ = time.Parse(time.RFC3339Nano, issued)
		e.ExpiresAt, _ = time.Parse(time.RFC3339Nano, expires)
		out = append(out, &e)
	}
	return out, rows.Err()
}

type pendingPairRow interface {
	Scan(dest ...any) error
}

func scanPendingPair(row pendingPairRow) (*pairingEntry, error) {
	var e pairingEntry
	var issued, expires string
	err := row.Scan(&e.Email, &e.Code, &issued, &expires, &e.ApprovedBy, &e.ApproverInfo, &e.UserAgent)
	if err != nil {
		return nil, nil // not found, no error — callers treat nil as "no row"
	}
	e.IssuedAt, _ = time.Parse(time.RFC3339Nano, issued)
	e.ExpiresAt, _ = time.Parse(time.RFC3339Nano, expires)
	return &e, nil
}

func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}
