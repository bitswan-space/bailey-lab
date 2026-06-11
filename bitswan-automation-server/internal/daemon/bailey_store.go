package daemon

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	_ "modernc.org/sqlite"
)

// bailey_store.go owns the daemon's persistent SQLite database at
// ~/.config/bitswan/bailey.db. Today the schema holds the per-endpoint
// ACL (see acl.go); later stages add MFA state (TOTP records, paired
// devices) and server-wide settings to the same file.
//
// One file, one bind-mount; survives daemon container restarts because
// the parent ~/.config/bitswan is already a persistent volume.

var (
	baileyDBOnce sync.Once
	baileyDB     *sql.DB
	baileyDBErr  error
)

const baileySchema = `
-- Per-endpoint ACL. One row per protected (outer) hostname; owner is
-- the user whose action created the endpoint (the workspace creator
-- for editor/gitops/dashboard, the deployer for automations, the
-- first signed-in user for the bailey management surface).
CREATE TABLE IF NOT EXISTS endpoints (
  hostname     TEXT PRIMARY KEY COLLATE NOCASE,
  owner_email  TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT,
  created_at   TEXT NOT NULL
);

-- Grants attached to an endpoint. principal_type is 'email' or 'group';
-- principal_value is the email address or Keycloak group path. role is
-- 'owner' or 'access'. The endpoint row records the original owner
-- directly; additional owners go here.
CREATE TABLE IF NOT EXISTS endpoint_grants (
  endpoint_host   TEXT NOT NULL COLLATE NOCASE,
  principal_type  TEXT NOT NULL CHECK (principal_type IN ('email','group')),
  principal_value TEXT NOT NULL COLLATE NOCASE,
  role            TEXT NOT NULL CHECK (role IN ('owner','access')),
  granted_at      TEXT NOT NULL,
  granted_by      TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (endpoint_host, principal_type, principal_value, role),
  FOREIGN KEY (endpoint_host) REFERENCES endpoints(hostname) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS endpoint_grants_host_idx ON endpoint_grants(endpoint_host);

-- Pending access requests from users who hit an endpoint they don't
-- have access to. Owners see these in the share dialog and can approve.
CREATE TABLE IF NOT EXISTS access_requests (
  endpoint_host TEXT NOT NULL COLLATE NOCASE,
  email         TEXT NOT NULL COLLATE NOCASE,
  requested_at  TEXT NOT NULL,
  PRIMARY KEY (endpoint_host, email),
  FOREIGN KEY (endpoint_host) REFERENCES endpoints(hostname) ON DELETE CASCADE
);
`

// baileyDBPath returns the absolute on-disk location of the daemon's
// SQLite database.
func baileyDBPath() string {
	return filepath.Join(os.Getenv("HOME"), ".config", "bitswan", "bailey.db")
}

// openBaileyDB lazily opens (and on first call, creates) the DB.
// Safe to call from multiple goroutines.
//
// SetMaxOpenConns(1): SQLite allows one writer at a time and the
// daemon's access patterns are tiny; serialising on a single
// connection sidesteps SQLITE_BUSY entirely. The trade-off is that a
// still-open rows handle holds the only connection — never run a
// second query inside a rows.Next() loop (it would deadlock waiting
// for itself).
func openBaileyDB() (*sql.DB, error) {
	baileyDBOnce.Do(func() {
		if err := os.MkdirAll(filepath.Dir(baileyDBPath()), 0o755); err != nil {
			baileyDBErr = fmt.Errorf("mkdir bailey config dir: %w", err)
			return
		}
		dsn := baileyDBPath() + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(on)"
		db, err := sql.Open("sqlite", dsn)
		if err != nil {
			baileyDBErr = fmt.Errorf("open sqlite: %w", err)
			return
		}
		db.SetMaxOpenConns(1)
		if _, err := db.Exec(baileySchema); err != nil {
			db.Close()
			baileyDBErr = fmt.Errorf("apply schema: %w", err)
			return
		}
		baileyDB = db
	})
	return baileyDB, baileyDBErr
}
