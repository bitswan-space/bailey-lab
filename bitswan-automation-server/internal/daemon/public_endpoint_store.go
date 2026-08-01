package daemon

import (
	"database/sql"
	"errors"
	"time"
)

// CRUD on the public_endpoints table (issue #220). A row records that a
// PRODUCTION frontend endpoint has been published as a public URL: the
// gate serves public_host with NO auth and a fixed anon@example.com
// identity toward the app. endpoint_host is the endpoint's normal
// (protected) outer host; public_host is the AOC-allocated
// <slug>.public.<aoc-id>.bswn.io secondary host. Time is an RFC3339 UTC
// string in the DB, parsed back at read time.

type publicEndpointRecord struct {
	EndpointHost string
	PublicHost   string
	CreatedBy    string
	CreatedAt    time.Time
}

// pubEndpointScanner is satisfied by *sql.Row and *sql.Rows.
type pubEndpointScanner interface{ Scan(dest ...any) error }

func scanPublicEndpoint(s pubEndpointScanner) (*publicEndpointRecord, error) {
	var rec publicEndpointRecord
	var createdAt string
	if err := s.Scan(&rec.EndpointHost, &rec.PublicHost, &rec.CreatedBy, &createdAt); err != nil {
		return nil, err
	}
	rec.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	return &rec, nil
}

// dbUpsertPublicEndpoint records (or refreshes) the public host for an
// endpoint. Re-publishing the same endpoint replaces the row.
func dbUpsertPublicEndpoint(endpointHost, publicHost, createdBy string) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_, err = db.Exec(`INSERT INTO public_endpoints(endpoint_host, public_host, created_by, created_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(endpoint_host) DO UPDATE SET
			public_host = excluded.public_host,
			created_by  = excluded.created_by,
			created_at  = excluded.created_at`,
		endpointHost, publicHost, createdBy, now)
	return err
}

// dbGetPublicEndpoint returns the public record for endpointHost, or nil
// if the endpoint is not published.
func dbGetPublicEndpoint(endpointHost string) (*publicEndpointRecord, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	row := db.QueryRow(
		`SELECT endpoint_host, public_host, created_by, created_at
		   FROM public_endpoints WHERE endpoint_host = ? COLLATE NOCASE`, endpointHost)
	rec, err := scanPublicEndpoint(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return rec, err
}

// dbDeletePublicEndpoint removes the public record for endpointHost.
func dbDeletePublicEndpoint(endpointHost string) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	_, err = db.Exec(`DELETE FROM public_endpoints WHERE endpoint_host = ? COLLATE NOCASE`, endpointHost)
	return err
}

// dbListPublicEndpoints returns every published endpoint (used to warm
// the in-memory host cache the gate consults per request).
func dbListPublicEndpoints() ([]publicEndpointRecord, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(`SELECT endpoint_host, public_host, created_by, created_at FROM public_endpoints`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []publicEndpointRecord
	for rows.Next() {
		rec, err := scanPublicEndpoint(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *rec)
	}
	return out, rows.Err()
}
