package daemon

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"
)

// GET  /bailey/api/people          — admin-only roster + per-person stats
// POST /bailey/api/people/invite   — admin-only; see bailey_people_invites.go
//
// SOURCE OF PEOPLE — investigation result
// ----------------------------------------
// Roles/users on a Bitswan automation server live in Keycloak (the AOC
// realm); group membership is what isAdminGroups() keys off. BUT the
// daemon only ever sees identity as the per-request oauth2-proxy headers
// (X-Forwarded-Email / -Groups) — see identityFromHeaders. There is NO
// Keycloak admin-API client in this repo or in PR #340 (grepped the
// monorepo + the #340 tree for admin/realms / KeycloakAdmin / user
// listing — none exist), and the AOC client (internal/aoc) exposes
// workspace/cert operations only, no user enumeration. So a live
// "list every user in the realm and map their groups to roles" query is
// NOT feasible in this build without first adding that client.
//
// What the daemon CAN enumerate from real, persistent data is every
// person it has actually transacted with:
//   - the recorded root admin (the claim record);
//   - device owners (the devices store);
//   - endpoint owners and email grantees (the ACL store);
//   - TOTP enrollees.
// The roster is the union of those, with counts joined from the same
// stores. This is real data, not the hardcoded harmonum seed users.
//
// ROLE — without the Keycloak group→role mapping we can only assert the
// one role the daemon authoritatively knows: the recorded root admin is
// "admin". Everyone else is reported as "member". The auditor/viewer
// distinction, and admin status for users who haven't hit the daemon yet,
// require the Keycloak group query (TODO: wire a realm admin client and
// map groups → role here; the admin group is already known via
// isAdminGroups / adminGroupSuffix).
//
// LAST-ACTIVE — best available signal is the newest device last_seen
// (falling back to paired_at) for the person; "" when they have no
// device. There is no per-user request log to do better without the
// audit feed, and that only covers mutating actions.
//
// INVITED-STATE — outstanding invites live in the local invites store
// (bailey_people_invites.go): an invited-but-never-seen user appears in
// the roster as a synthetic InvitedOnly row until they redeem (which
// gives them a device) or the invite is revoked. Inviting doesn't need
// a Keycloak admin client — the AOC lists the org's members and sends
// the email; the daemon only pre-authorises the first device.

type personDTO struct {
	Name        string `json:"name"`
	Email       string `json:"email"`
	Role        string `json:"role"` // admin | auditor | member | viewer
	Workspaces  int    `json:"workspace_count"`
	Devices     int    `json:"device_count"`
	LastActive  string `json:"last_active,omitempty"` // RFC3339 ("" if unknown)
	InvitedOnly bool   `json:"invited"`               // true = live invite, user never seen on this server
}

const (
	roleAdmin   = "admin"
	roleAuditor = "auditor"
	roleMember  = "member"
	roleUser    = "user"
)

// validRole reports whether role is one we accept on a role-write.
func validRole(role string) bool {
	switch role {
	case roleAdmin, roleAuditor, roleMember, roleUser:
		return true
	}
	return false
}

// effectiveRole is the AUTHORITATIVE role for an email, resolved locally:
//   - an explicit role in user_roles (set by an admin) wins;
//   - otherwise the recorded root admin is "admin" (bootstrap, no lockout);
//   - otherwise "member".
//
// It is never derived from SSO groups — SSO only seeds the first admin via the
// one-time claim flow, after which roles live entirely in user_roles.
func effectiveRole(email string) string {
	email = strings.TrimSpace(email)
	if email == "" {
		return ""
	}
	if r, _ := dbGetUserRole(email); r != "" {
		return r
	}
	if strings.EqualFold(email, strings.TrimSpace(serverRootAdmin())) {
		return roleAdmin
	}
	return roleMember
}

// callerIsAdmin is the admin CAPABILITY check — true iff the email's effective
// role is admin. Replaces the old SSO-group check everywhere except the
// first-admin claim bootstrap.
func callerIsAdmin(email string) bool {
	return effectiveRole(email) == roleAdmin
}

// handleUserRole (GET /bailey/role?email=) returns the AUTHORITATIVE Bailey
// role for an email — the same effectiveRole the People & roles view shows,
// never derived from SSO groups. Mounted on the daemon's local socket mux
// (authMiddleware): only a caller holding the daemon token over the local
// socket reaches it — i.e. gitops resolving the role of an identity its
// upstream shim already verified (the dashboard validates the user's access
// token → email before asking). The lookup is by email and carries no
// authority of its own, so it is safe for that trusted backend channel.
func (s *Server) handleUserRole(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	email := strings.TrimSpace(r.URL.Query().Get("email"))
	if email == "" {
		writeJSONError(w, "email query parameter is required", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"email": email,
		"role":  effectiveRole(email),
	})
}

// handleSetUserRole assigns a user's role locally (admin-only; the caller is
// already gated in handleBailey). Stores it in user_roles, which is the
// authoritative source for the role and the admin capability.
func handleSetUserRole(w http.ResponseWriter, r *http.Request, by string) {
	var req struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "bad request", http.StatusBadRequest)
		return
	}
	email := strings.TrimSpace(req.Email)
	role := strings.TrimSpace(req.Role)
	if email == "" || !validRole(role) {
		writeJSONError(w, "email and a valid role (admin|auditor|member|user) are required", http.StatusBadRequest)
		return
	}
	// The recorded root admin is the bootstrap admin — never let them be
	// demoted from here, or the server could be left with no admin at all.
	if strings.EqualFold(email, strings.TrimSpace(serverRootAdmin())) && role != roleAdmin {
		writeJSONError(w, "the root admin's role can't be changed", http.StatusConflict)
		return
	}
	if err := dbSetUserRole(email, role, by); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "email": email, "role": role})
}

// gatherPeople builds the roster from every store the daemon can read.
// Returns the people sorted by email and the first error encountered
// (callers degrade gracefully: an empty/partial list plus the error,
// never a fabricated roster).
func gatherPeople(r *http.Request) ([]personDTO, error) {
	// Accumulator keyed by lowercased email; preserves the canonical
	// (first-seen) casing for display.
	type acc struct {
		email      string
		workspaces int
		devices    int
		lastActive string
	}
	byEmail := map[string]*acc{}
	get := func(email string) *acc {
		email = strings.TrimSpace(email)
		if email == "" {
			return nil
		}
		key := strings.ToLower(email)
		a, ok := byEmail[key]
		if !ok {
			a = &acc{email: email}
			byEmail[key] = a
		}
		return a
	}

	var firstErr error
	noteErr := func(e error) {
		if firstErr == nil && e != nil {
			firstErr = e
		}
	}

	// (1) Recorded root admin — always a person, even before any device.
	if root := serverRootAdmin(); root != "" {
		get(root)
	}

	// (2) Devices → device counts + last-active.
	devs, err := listAllDevices()
	noteErr(err)
	for _, d := range devs {
		a := get(d.Email)
		if a == nil {
			continue
		}
		a.devices++
		// last_seen is RFC3339 and lexicographically sortable; fall back
		// to paired_at for a never-touched device.
		seen := d.LastSeen
		if seen == "" {
			seen = d.PairedAt
		}
		if seen > a.lastActive {
			a.lastActive = seen
		}
	}

	// (3) Workspaces → per-person workspace counts. We attribute each
	// workspace to the people on its endpoints, using the SAME explicit
	// construction handleListAccessibleWorkspaces uses (workspace name +
	// known service suffix + domain) rather than reverse-parsing endpoint
	// hostnames. A person "has" a workspace if they are the recorded
	// owner of, or an email grantee on, any of its gitops/dashboard
	// endpoints. Group grants can't be expanded to individuals without the
	// Keycloak query, so they don't contribute to per-person counts.
	domain := configuredProtectedDomain()
	// person(lower) → set of workspace names
	personWorkspaces := map[string]map[string]struct{}{}
	addWS := func(email, ws string) {
		email = strings.ToLower(strings.TrimSpace(email))
		if email == "" {
			return
		}
		if personWorkspaces[email] == nil {
			personWorkspaces[email] = map[string]struct{}{}
		}
		personWorkspaces[email][ws] = struct{}{}
	}
	if domain != "" {
		full, wErr := GetWorkspaceList(false, false)
		noteErr(wErr)
		if full != nil {
			for _, ws := range full.Workspaces {
				for _, svc := range []string{"gitops", "dashboard"} {
					host := ws.Name + "-" + svc + "." + domain
					ep, epErr := getEndpoint(host)
					noteErr(epErr)
					if ep != nil {
						get(ep.OwnerEmail)
						addWS(ep.OwnerEmail, ws.Name)
					}
					grants, gErr := listGrants(host)
					noteErr(gErr)
					for _, g := range grants {
						if g.PrincipalType != "email" {
							continue
						}
						get(g.PrincipalValue)
						addWS(g.PrincipalValue, ws.Name)
					}
				}
			}
		}
	}
	for key, set := range personWorkspaces {
		if a, ok := byEmail[key]; ok {
			a.workspaces = len(set)
		}
	}

	// (4) TOTP enrollees — surface people who set up an authenticator even
	// if they have no device/endpoint yet.
	if totp, tErr := dbListTOTPEnrolledEmails(); tErr == nil {
		for emailLower := range totp {
			get(emailLower)
		}
	} else {
		noteErr(tErr)
	}

	// (5) Live invites → synthetic invited-but-never-seen rows. Someone
	// already in the roster from a real source above is NOT re-marked as
	// invited (they've transacted with the server; the invite pill would
	// lie). Their pending invite still shows in the invites strip.
	invitedRole := map[string]string{}
	if invites, iErr := dbListUnconsumedInvites(); iErr == nil {
		now := time.Now()
		for i := range invites {
			inv := &invites[i]
			if !inv.live(now) {
				continue
			}
			if _, seen := byEmail[strings.ToLower(inv.Email)]; seen {
				continue
			}
			get(inv.Email)
			// The role they'll receive on redemption — effectiveRole would
			// report the default until they actually join.
			invitedRole[strings.ToLower(inv.Email)] = inv.Role
		}
	} else {
		noteErr(iErr)
	}

	out := make([]personDTO, 0, len(byEmail))
	for key, a := range byEmail {
		// Role is the locally-stored, authoritative role (effectiveRole),
		// not an SSO-derived one; for an invited-but-never-seen row it is
		// the role the invite will grant.
		role := effectiveRole(a.email)
		invited := false
		if r, ok := invitedRole[key]; ok {
			invited = true
			// Show the invite's role only when no explicit user_roles entry
			// exists — an admin who set a role via the roster's role pill
			// must see it stick, and redemption preserves that explicit role
			// (dbGetUserRole != "" guard) rather than applying the invite's.
			if explicit, _ := dbGetUserRole(a.email); explicit == "" {
				role = r
			}
		}
		out = append(out, personDTO{
			// No real display-name source without the Keycloak profile
			// query (TODO), and we don't infer a name from the email
			// local-part — name is reported as the email until a real
			// profile source is wired.
			Name:        a.email,
			Email:       a.email,
			Role:        role,
			Workspaces:  a.workspaces,
			Devices:     a.devices,
			LastActive:  a.lastActive,
			InvitedOnly: invited,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i].Email) < strings.ToLower(out[j].Email)
	})
	return out, firstErr
}

func handleBaileyPeople(w http.ResponseWriter, r *http.Request) {
	people, err := gatherPeople(r)
	w.Header().Set("Content-Type", "application/json")
	resp := map[string]any{"people": people}
	if err != nil {
		// Degrade gracefully: return whatever we could enumerate plus a
		// surfaced error. Do NOT 500 — a partial roster is still useful.
		resp["error"] = err.Error()
	}
	_ = json.NewEncoder(w).Encode(resp)
}
