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
	// ParentEndpoint is the hostname of the endpoint this one delegates
	// membership to (the workspace dashboard for workspace-spawned
	// endpoints). Empty for top-level endpoints.
	ParentEndpoint string
	// Kind classifies the endpoint for the Bailey launcher and admin UIs:
	// "workspace" (a workspace dashboard — a top-level entry), "frontend"
	// (an exposed business-process app under a workspace), or "service"
	// (gitops/editor and other infrastructure). Empty when unknown (e.g.
	// pre-migration rows or routes registered without a kind). It is
	// explicit data set at registration — never inferred from the hostname.
	Kind string
	// Stage is the deployment stage of the backing automation ("production",
	// "staging", "dev", "live-dev", ...). Explicit data set at registration;
	// launcher/admin views filter on it (e.g. only production frontends).
	// Empty for endpoints with no stage (workspace dashboards, services).
	Stage string
	// Source is the route's provenance: "gitops" (registered by gitops
	// reconcile from bitswan.yaml — prunable) or "manual" (added by a human /
	// workspace init — never pruned by reconcile). Defaults to "manual".
	Source string
	// SourceBP is the business process a gitops route belongs to (see
	// setEndpointSourceBP). Empty for manual routes and legacy gitops rows.
	SourceBP  string
	CreatedAt string
}

// Endpoint kinds. Stored verbatim in endpoints.kind.
const (
	endpointKindWorkspace = "workspace"
	endpointKindFrontend  = "frontend"
	endpointKindService   = "service"
)

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
	// Hostname is the endpoint the request is against. Empty on rows
	// from the per-host listAccessRequests (the caller already knows
	// the host); populated by listAllAccessRequests, which spans hosts.
	Hostname string `json:"hostname,omitempty"`
}

// getEndpoint returns the registered endpoint or nil if unknown.
func getEndpoint(hostname string) (*endpointRecord, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	row := db.QueryRow(`SELECT hostname, owner_email, COALESCE(display_name,''), COALESCE(parent_endpoint,''), COALESCE(kind,''), COALESCE(stage,''), COALESCE(source,'manual'), COALESCE(source_bp,''), created_at
	                    FROM endpoints WHERE hostname = ? COLLATE NOCASE`, hostname)
	var e endpointRecord
	if err := row.Scan(&e.Hostname, &e.OwnerEmail, &e.DisplayName, &e.ParentEndpoint, &e.Kind, &e.Stage, &e.Source, &e.SourceBP, &e.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &e, nil
}

// registerEndpoint creates the endpoint row. parentEndpoint (may be
// empty) is the hostname whose membership this endpoint delegates to —
// the workspace dashboard for workspace-spawned endpoints. Idempotent:
// if the row already exists, returns the existing record without
// overwriting — the original owner and parent are preserved.
func registerEndpoint(hostname, ownerEmail, displayName, parentEndpoint, kind, stage string) (*endpointRecord, error) {
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
	// `source` is intentionally omitted — the column default ('manual')
	// applies. Routes gitops manages are promoted to 'gitops' afterwards via
	// setEndpointSource (only the ingress reconcile does that), so existing
	// callers stay unchanged and a manual route is never auto-captured.
	_, err = db.Exec(`INSERT OR IGNORE INTO endpoints (hostname, owner_email, display_name, parent_endpoint, kind, stage, created_at)
	                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
		hostname, ownerEmail, displayName, parentEndpoint, kind, stage, now)
	if err != nil {
		return nil, err
	}
	// A row registered earlier without a kind/stage (or as a plain route,
	// before its workspace context was known) should pick up the explicit
	// values once supplied — INSERT OR IGNORE won't update the existing row,
	// so fill empty columns in place. Never downgrade a known value.
	if kind != "" {
		if _, err := db.Exec(`UPDATE endpoints SET kind = ? WHERE hostname = ? COLLATE NOCASE AND COALESCE(kind,'') = ''`,
			kind, hostname); err != nil {
			return nil, err
		}
	}
	if stage != "" {
		if _, err := db.Exec(`UPDATE endpoints SET stage = ? WHERE hostname = ? COLLATE NOCASE AND COALESCE(stage,'') = ''`,
			stage, hostname); err != nil {
			return nil, err
		}
	}
	return getEndpoint(hostname)
}

// setEndpointOwner rewrites the endpoint's recorded owner_email. owner_email is
// just "one of the owners" — the one surfaced for display and inherited by
// child endpoints — and is kept pointing at a current owner as owners come and
// go (see revokeOwnership). There is no immovable "primary" owner.
func setEndpointOwner(hostname, ownerEmail string) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	hostname = strings.TrimSpace(hostname)
	if hostname == "" {
		return fmt.Errorf("hostname is required")
	}
	_, err = db.Exec(`UPDATE endpoints SET owner_email = ? WHERE hostname = ? COLLATE NOCASE`,
		strings.TrimSpace(ownerEmail), hostname)
	return err
}

// endpointOwners returns every email that owns the endpoint — the recorded
// owner_email (if any) plus every email grant with role=owner — deduped,
// owner_email first. Owner is a role, not an exclusive property.
func endpointOwners(hostname string) []string {
	out := []string{}
	seen := map[string]bool{}
	add := func(e string) {
		e = strings.TrimSpace(e)
		if e == "" || seen[strings.ToLower(e)] {
			return
		}
		seen[strings.ToLower(e)] = true
		out = append(out, e)
	}
	if ep, _ := getEndpoint(hostname); ep != nil {
		add(ep.OwnerEmail)
	}
	if grants, err := listGrants(hostname); err == nil {
		for _, g := range grants {
			if g.PrincipalType == "email" && g.Role == roleOwner {
				add(g.PrincipalValue)
			}
		}
	}
	return out
}

// revokeOwnership removes email as an owner of the endpoint: it drops any owner
// grant and, if email is the recorded owner_email, hands that slot to another
// current owner. It refuses to remove the LAST owner — the one invariant the
// old immovable "primary owner" really protected. A no-op if email isn't an
// owner. Child endpoints inherit workspace owners via parent delegation in
// roleFor, so nothing needs to cascade.
func revokeOwnership(hostname, email string) error {
	email = strings.TrimSpace(email)
	var remaining []string
	isOwner := false
	for _, o := range endpointOwners(hostname) {
		if strings.EqualFold(o, email) {
			isOwner = true
		} else {
			remaining = append(remaining, o)
		}
	}
	if !isOwner {
		return nil
	}
	if len(remaining) == 0 {
		return fmt.Errorf("a workspace must keep at least one owner")
	}
	if err := removeGrant(hostname, "email", email, string(roleOwner)); err != nil {
		return err
	}
	if ep, _ := getEndpoint(hostname); ep != nil && strings.EqualFold(ep.OwnerEmail, email) {
		return setEndpointOwner(hostname, remaining[0])
	}
	return nil
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
//
// roleFor includes parent delegation: an endpoint registered with a
// parent endpoint (the workspace dashboard, recorded explicitly at
// registration time — see addRouteToIngress) inherits membership from
// it AT THE ROLE the caller holds on the parent, never higher. An
// owner of the dashboard is owner of everything spawned under the
// workspace (they administer it); an access-role member can OPEN those
// endpoints but does not own them — sharing a child requires an
// explicit owner grant on the child (or owner on the dashboard).
//
// SECURITY (#129): delegation must never upgrade access→owner. The
// dashboard `access` grant is the routine way to let a teammate into a
// workspace; promoting it to owner of every child endpoint would let
// any member share (re-grant, including to arbitrary external emails)
// the automations and frontends other members created. The parent's
// own ACL is unchanged either way — delegation only flows parent→child.
func roleFor(hostname, email string, groups []string) (endpointRole, error) {
	role, err := directRoleFor(hostname, email, groups)
	if err != nil || role == roleOwner {
		return role, err
	}
	ep, err := getEndpoint(hostname)
	if err != nil || ep == nil {
		return role, err
	}
	if ep.ParentEndpoint != "" && !strings.EqualFold(ep.ParentEndpoint, ep.Hostname) {
		parentRole, err := directRoleFor(ep.ParentEndpoint, email, groups)
		if err != nil {
			return role, err
		}
		// The direct role here is at most `access` (owner short-circuited
		// above), so taking the parent's role can only widen, never
		// downgrade: owner on the parent ⇒ owner of the child; access on
		// the parent ⇒ access on the child.
		if parentRole != roleNone {
			return parentRole, nil
		}
	}
	return role, nil
}

// directRoleFor resolves the caller's role from the endpoint's own
// rows only — no parent delegation. Original owner ⇒ owner; otherwise
// the highest role across matching email/group grants.
func directRoleFor(hostname, email string, groups []string) (endpointRole, error) {
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

// listAllAccessRequests returns every pending access request across all
// endpoints, newest first. The notifications surface filters these down
// to the ones the caller can grant on (per-row roleFor); the Hostname
// field is populated so it can.
func listAllAccessRequests() ([]accessRequest, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(`SELECT endpoint_host, email, requested_at FROM access_requests
	                       ORDER BY requested_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []accessRequest{}
	for rows.Next() {
		var item accessRequest
		if err := rows.Scan(&item.Hostname, &item.Email, &item.RequestedAt); err != nil {
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
	rows, err := db.Query(`SELECT hostname, owner_email, COALESCE(display_name,''), COALESCE(parent_endpoint,''), COALESCE(kind,''), COALESCE(stage,''), COALESCE(source,'manual'), COALESCE(source_bp,''), created_at FROM endpoints`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []endpointRecord
	for rows.Next() {
		var e endpointRecord
		if err := rows.Scan(&e.Hostname, &e.OwnerEmail, &e.DisplayName, &e.ParentEndpoint, &e.Kind, &e.Stage, &e.Source, &e.SourceBP, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// setEndpointSource promotes (or sets) a registered endpoint's provenance —
// used by the ingress reconcile to mark a route 'gitops' (declarative, prunable)
// after registering it. No-op if the endpoint row doesn't exist yet.
func setEndpointSource(hostname, source string) error {
	return setEndpointSourceBP(hostname, source, "")
}

// setEndpointSourceBP also records the business process a gitops route belongs
// to, so a per-BP ingress reconcile prunes only its own bp's routes. A non-empty
// bp always overwrites (backfills an untagged route on its next upsert); an empty
// bp leaves any existing tag intact (legacy whole-workspace reconcile).
func setEndpointSourceBP(hostname, source, bp string) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	if bp != "" {
		_, err = db.Exec(`UPDATE endpoints SET source = ?, source_bp = ? WHERE hostname = ? COLLATE NOCASE`,
			source, bp, strings.TrimSpace(hostname))
	} else {
		_, err = db.Exec(`UPDATE endpoints SET source = ? WHERE hostname = ? COLLATE NOCASE`,
			source, strings.TrimSpace(hostname))
	}
	return err
}

// listGitopsManagedHosts returns the outer hostnames of every endpoint with
// source='gitops' that belongs to a workspace (its hostname starts with
// "<workspace>-"). The ingress reconcile uses this to find which managed
// routes to prune — those no longer in the desired set. Manual routes are
// never returned, so reconcile can never remove a human-added route.
//
// When bp is non-empty (a per-BP deploy), only routes tagged with that bp are
// returned — so a per-BP reconcile prunes only its own routes and can never
// remove a sibling BP's route, nor an untagged (legacy) route. bp="" is the
// legacy whole-workspace reconcile (every gitops route is prunable).
func listGitopsManagedHosts(workspaceName, bp string) ([]string, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	query := `SELECT hostname FROM endpoints WHERE source = 'gitops' AND hostname LIKE ? COLLATE NOCASE`
	args := []any{workspaceName + "-%"}
	if bp != "" {
		query += ` AND source_bp = ?`
		args = append(args, bp)
	}
	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var h string
		if err := rows.Scan(&h); err != nil {
			return nil, err
		}
		out = append(out, h)
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

// listAccessibleEndpoints returns every registered endpoint the caller can
// reach (owner OR access, via email or group), used to build the Bailey
// launcher. Filtering is the same authority check the gate enforces, so the
// menu only ever shows endpoints the user could actually open.
func listAccessibleEndpoints(email string, groups []string) ([]endpointRecord, error) {
	endpoints, err := listAllEndpoints()
	if err != nil {
		return nil, err
	}
	var out []endpointRecord
	for _, e := range endpoints {
		if role, _ := roleFor(e.Hostname, email, groups); role != roleNone {
			out = append(out, e)
		}
	}
	return out, nil
}
