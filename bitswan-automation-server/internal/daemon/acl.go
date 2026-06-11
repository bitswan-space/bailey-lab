package daemon

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Per-endpoint ACL. Every protected hostname has at most one row in
// the `endpoints` table recording its original owner; everything else
// is a grant in `endpoint_grants` (additional owners, accessors,
// group access).
//
// Resolution order on every request:
//  1. Endpoint exists?             → if not, treat as "not yet
//     registered" (open until a route registration sets an owner)
//  2. Caller is original owner?    → access granted as 'owner'
//  3. Caller email has any grant?  → access granted at that role
//  4. Caller in any granted group? → access granted at that role
//  5. Otherwise                    → deny (caller can request access)
//
// ACL state is keyed by the OUTER hostname; inner-subdomain requests
// look up against the same row (see enforceEndpointACL).

type endpointRecord struct {
	Hostname    string
	OwnerEmail  string
	DisplayName string
	CreatedAt   string
}

// endpointRole is "owner", "access", or "" (no access).
type endpointRole string

const (
	roleOwner  endpointRole = "owner"
	roleAccess endpointRole = "access"
	roleNone   endpointRole = ""
)

// endpointGrant describes a single ACL row, used by the share UI.
// JSON tags use snake_case because the share modal JS reads them
// directly (g.principal_value, g.role, etc.).
type endpointGrant struct {
	Hostname       string       `json:"hostname"`
	PrincipalType  string       `json:"principal_type"` // "email" | "group"
	PrincipalValue string       `json:"principal_value"`
	Role           endpointRole `json:"role"`
	GrantedAt      string       `json:"granted_at"`
	GrantedBy      string       `json:"granted_by"`
}

// accessRequest is one pending "Request access" submission.
type accessRequest struct {
	Email       string `json:"email"`
	RequestedAt string `json:"requested_at"`
}

// getEndpoint returns the registered endpoint or nil if unknown.
func getEndpoint(hostname string) (*endpointRecord, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	row := db.QueryRow(`SELECT hostname, owner_email, COALESCE(display_name,''), created_at
	                    FROM endpoints WHERE hostname = ? COLLATE NOCASE`, hostname)
	var e endpointRecord
	if err := row.Scan(&e.Hostname, &e.OwnerEmail, &e.DisplayName, &e.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &e, nil
}

// registerEndpoint creates the endpoint row. Idempotent: if it already
// exists, returns the existing record without overwriting — the
// original owner is preserved.
func registerEndpoint(hostname, ownerEmail, displayName string) (*endpointRecord, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	hostname = strings.TrimSpace(hostname)
	ownerEmail = strings.TrimSpace(ownerEmail)
	if hostname == "" || ownerEmail == "" {
		return nil, fmt.Errorf("hostname and owner are required")
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_, err = db.Exec(`INSERT OR IGNORE INTO endpoints (hostname, owner_email, display_name, created_at)
	                  VALUES (?, ?, ?, ?)`,
		hostname, ownerEmail, displayName, now)
	if err != nil {
		return nil, err
	}
	return getEndpoint(hostname)
}

// deleteEndpoint removes an endpoint and (via ON DELETE CASCADE) all
// its grants and access requests. Used by workspace remove.
func deleteEndpoint(hostname string) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	_, err = db.Exec(`DELETE FROM endpoints WHERE hostname = ? COLLATE NOCASE`, hostname)
	return err
}

// addGrant records a new principal → role grant. Idempotent (the
// primary key is composite over all identifying columns).
func addGrant(hostname, principalType, principalValue, role, grantedBy string) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	if principalType != "email" && principalType != "group" {
		return fmt.Errorf("invalid principal_type %q", principalType)
	}
	if role != string(roleOwner) && role != string(roleAccess) {
		return fmt.Errorf("invalid role %q", role)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_, err = db.Exec(`INSERT OR IGNORE INTO endpoint_grants
	    (endpoint_host, principal_type, principal_value, role, granted_at, granted_by)
	    VALUES (?, ?, ?, ?, ?, ?)`,
		hostname, principalType, principalValue, role, now, grantedBy)
	return err
}

// removeGrant drops a specific grant.
func removeGrant(hostname, principalType, principalValue, role string) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	_, err = db.Exec(`DELETE FROM endpoint_grants
	    WHERE endpoint_host = ? COLLATE NOCASE
	      AND principal_type = ?
	      AND principal_value = ? COLLATE NOCASE
	      AND role = ?`,
		hostname, principalType, principalValue, role)
	return err
}

// listGrants returns every grant for an endpoint, newest first.
func listGrants(hostname string) ([]endpointGrant, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(`SELECT endpoint_host, principal_type, principal_value, role,
	                              granted_at, granted_by
	                       FROM endpoint_grants
	                       WHERE endpoint_host = ? COLLATE NOCASE
	                       ORDER BY granted_at DESC`, hostname)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []endpointGrant{}
	for rows.Next() {
		var g endpointGrant
		var role string
		if err := rows.Scan(&g.Hostname, &g.PrincipalType, &g.PrincipalValue,
			&role, &g.GrantedAt, &g.GrantedBy); err != nil {
			return nil, err
		}
		g.Role = endpointRole(role)
		out = append(out, g)
	}
	return out, rows.Err()
}

// roleFor returns the highest role the caller has on the endpoint.
// Resolution: original owner ⇒ owner. Otherwise, the highest role
// across any matching email or group grant (owner > access). No
// grant ⇒ "". An unregistered endpoint also yields "" — callers that
// want "unregistered means open" must check getEndpoint themselves.
//
// groups is the caller's Keycloak groups (X-Forwarded-Groups split).
func roleFor(hostname, email string, groups []string) (endpointRole, error) {
	ep, err := getEndpoint(hostname)
	if err != nil {
		return roleNone, err
	}
	if ep == nil {
		return roleNone, nil
	}
	if strings.EqualFold(ep.OwnerEmail, email) {
		return roleOwner, nil
	}
	grants, err := listGrants(hostname)
	if err != nil {
		return roleNone, err
	}
	best := roleNone
	for _, g := range grants {
		matched := false
		switch g.PrincipalType {
		case "email":
			matched = strings.EqualFold(g.PrincipalValue, email)
		case "group":
			for _, gg := range groups {
				if strings.EqualFold(strings.TrimSpace(gg), g.PrincipalValue) {
					matched = true
					break
				}
			}
		}
		if !matched {
			continue
		}
		if g.Role == roleOwner {
			return roleOwner, nil // owner short-circuits
		}
		if g.Role == roleAccess {
			best = roleAccess
		}
	}
	return best, nil
}

// addAccessRequest records that a user has asked for access. Idempotent
// — repeated requests just refresh requested_at.
func addAccessRequest(hostname, email string) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_, err = db.Exec(`INSERT INTO access_requests (endpoint_host, email, requested_at)
	    VALUES (?, ?, ?)
	    ON CONFLICT(endpoint_host, email) DO UPDATE SET requested_at = excluded.requested_at`,
		hostname, email, now)
	return err
}

// listAccessRequests returns pending requests for an endpoint, newest
// first.
func listAccessRequests(hostname string) ([]accessRequest, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(`SELECT email, requested_at FROM access_requests
	                       WHERE endpoint_host = ? COLLATE NOCASE
	                       ORDER BY requested_at DESC`, hostname)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []accessRequest{}
	for rows.Next() {
		var item accessRequest
		if err := rows.Scan(&item.Email, &item.RequestedAt); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// removeAccessRequest drops a request (after approval or denial).
func removeAccessRequest(hostname, email string) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	_, err = db.Exec(`DELETE FROM access_requests
	    WHERE endpoint_host = ? COLLATE NOCASE AND email = ? COLLATE NOCASE`,
		hostname, email)
	return err
}

// listAllEndpoints returns every endpoint row. Filtering by caller
// role happens in memory because doing it in SQL would require
// joining grants per row, and we'd still need the per-row group-match
// logic in Go.
//
// All rows are read into a slice before returning — don't call other
// DB helpers inside a rows.Next() loop (see openBaileyDB on why).
func listAllEndpoints() ([]endpointRecord, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(`SELECT hostname, owner_email, COALESCE(display_name,''), created_at FROM endpoints`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []endpointRecord
	for rows.Next() {
		var e endpointRecord
		if err := rows.Scan(&e.Hostname, &e.OwnerEmail, &e.DisplayName, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// listEndpointsWhereUserCanShare returns the endpoints where the
// caller is the original owner OR has an owner-role grant via email
// or group. Used for the share index page.
func listEndpointsWhereUserCanShare(email string, groups []string) ([]endpointRecord, error) {
	endpoints, err := listAllEndpoints()
	if err != nil {
		return nil, err
	}
	var out []endpointRecord
	for _, e := range endpoints {
		role, _ := roleFor(e.Hostname, email, groups)
		if role == roleOwner {
			out = append(out, e)
		}
	}
	return out, nil
}
