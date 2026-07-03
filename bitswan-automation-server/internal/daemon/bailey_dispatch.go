package daemon

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// isBaileyDataPath reports whether a path on the Server Console host is
// a backend data/asset path that must reach the daemon's handleBailey
// (and the gate's MFA pages) rather than the SPA's index.html fallback.
// Without this, the console's own fetch() calls would resolve to
// index.html (the SPA catch-all) and never hit the JSON handlers.
func isBaileyDataPath(p string) bool {
	return strings.HasPrefix(p, "/bailey/api/") ||
		strings.HasPrefix(p, "/bailey/static/") ||
		p == "/bailey/favicon.svg" ||
		p == "/bailey/signout" ||
		strings.HasPrefix(p, gatePathPrefix+"/")
}

// handleBailey is the JSON/API dispatcher for the Bailey management
// surface, mounted at /bailey/* on the daemon's TCP server. The HTML
// pages are served by the React Server Console (serveServerConsole,
// wired in chromeWrapMiddleware); this handler carries only the
// data/JSON endpoints the console fetches, plus the favicon, static
// asset bundle, and sign-out.
//
// Identity is the oauth2-proxy-forwarded header set. /bailey/api/* and
// /bailey/static/* bypass the chrome wrap (see chromeWrapMiddleware) so
// a fetch() gets JSON, not the wrap HTML or a gate redirect. Admin-only
// routes enforce isAdmin (403) here, since the underlying handlers
// don't self-gate.
//
// Routes from #340's server-rendered admin pages that the React console
// either replaces or that depend on subsystems not present in this
// build (SIEM, the VPN CA download, cert-authority management) are
// intentionally NOT wired here.
func (s *Server) handleBailey(w http.ResponseWriter, r *http.Request) {
	// Favicon — public to any authenticated caller; referenced by every
	// Bailey-served HTML head (bitswanFavicon).
	if r.URL.Path == "/bailey/favicon.svg" {
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		fmt.Fprint(w, bitswanLogoSVG)
		return
	}

	email, groups := identityFromHeaders(r)

	// Whoami: diagnostic available to any authenticated user.
	if r.URL.Path == "/bailey/api/whoami" {
		handleWhoami(w, r)
		return
	}

	// Static asset bundle — public to any authenticated caller.
	if strings.HasPrefix(r.URL.Path, "/bailey/static/") {
		handleBaileyStatic(w, r)
		return
	}

	// Sign-out works for any authenticated identity; never gated.
	if r.URL.Path == "/bailey/signout" {
		signoutRedirect(w, r, "/")
		return
	}

	// --- Device-trust GATE API (pre-trust flow) ---
	// These power the React gate scenes (Bootstrap/Approval/Recovery) and
	// MUST be reachable by an OAuth-authenticated but UNtrusted user — they
	// are how a user becomes trusted. They live under /bailey/api/* (chrome
	// wrap bypass) and are exempt from enforceMFAGate. Their own per-route
	// rules (eligibleToClaim, totp.Validate, approverIsTrusted on the
	// approver side) carry the security; do NOT add an isAdmin/trusted gate
	// in front of them or the gate becomes un-clearable.
	if s.handleGateAPI(w, r, email, groups) {
		return
	}

	// DEVICE-TRUST BACKSTOP (security-critical). Every /bailey/api route
	// below this point exposes or mutates management data, so it requires a
	// TRUSTED device — a valid OAuth login is never sufficient on its own.
	// That is the entire point of the device-trust gate: a phished credential
	// or a stolen-but-signed-in browser must not reach the console's data.
	//
	// enforceMFAGate exempts /bailey/api wholesale so the pre-trust bootstrap
	// flow (handleGateAPI, above) can run on an untrusted device; this is
	// where the data endpoints earn their gate back. The ONLY things an
	// untrusted device may touch are the gate/bootstrap APIs above (how a
	// device becomes trusted) and the public favicon/static/whoami/signout
	// handled earlier. Enforcing it HERE — at the data handler, not at a host-
	// or SPA-dependent layer — means the data is unreachable from an untrusted
	// device no matter which host the request hit or what the client renders.
	if currentDeviceForRequest(r, email) == nil {
		writeJSONError(w, "device not trusted", http.StatusUnauthorized)
		return
	}

	// --- Routes open to any signed-in user (on a trusted device) ---
	switch r.URL.Path {
	case "/bailey/api/notifications-count":
		if r.Method == http.MethodGet {
			handleNotificationsCount(w, r)
			return
		}
	case "/bailey/api/devices":
		if r.Method == http.MethodGet {
			handleBaileyDevicesAPI(w, r, email)
			return
		}
	case "/bailey/api/devices/remove":
		if r.Method == http.MethodPost {
			handleBaileyDevicesRemoveAPI(w, r, email)
			return
		}
	case "/bailey/api/totp/remove":
		// Remove THIS user's authenticator. A trusted-device account action
		// (it's past the device-trust backstop), distinct from the untrusted
		// enroll/verify gate APIs. After this the user keeps device trust but
		// loses the authenticator recovery factor until they re-enrol.
		if r.Method == http.MethodPost {
			if email == "" {
				writeJSONError(w, "no identity", http.StatusUnauthorized)
				return
			}
			if err := dbDeleteTOTP(email); err != nil {
				writeJSONError(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
	case "/bailey/api/approvals":
		if r.Method == http.MethodGet {
			handleBaileyApprovalsAPI(w, r, email, callerIsAdmin(email))
			return
		}
	case "/bailey/api/endpoints":
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		listing, err := buildEndpointListing(email, groups, r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(listing)
		return
	case "/bailey/api/workspaces":
		switch r.Method {
		case http.MethodGet:
			handleListAccessibleWorkspaces(w, r, email)
			return
		case http.MethodPost:
			s.handleCreateWorkspaceFromBaileyAdmin(w, r, email)
			return
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
	case "/bailey/api/workspaces/empty-trash":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		s.handleEmptyTrash(w, r, email)
		return
	}

	// Per-workspace trash/restore/update — path:
	// /bailey/api/workspaces/{name}/{action}. Exact-match switch can't
	// express the variable segment, so prefix-match here (mirrors #340).
	if strings.HasPrefix(r.URL.Path, "/bailey/api/workspaces/") && r.Method == http.MethodPost {
		rest := strings.TrimPrefix(r.URL.Path, "/bailey/api/workspaces/")
		parts := strings.Split(rest, "/")
		if len(parts) == 2 {
			workspaceName, action := parts[0], parts[1]
			// SECURITY (path traversal): the {name} segment is taken
			// straight off the URL and flows into filesystem paths
			// (filepath.Join under ~/.config/bitswan/workspaces) and
			// docker compose project names. Go's http.ServeMux does NOT
			// clean percent-encoded dot segments, so /%2e%2e/restore
			// arrives here as workspaceName=="..". Validate against the
			// same regex the create path uses and 400 anything that
			// isn't a well-formed workspace name.
			if !nameRe.MatchString(workspaceName) {
				http.Error(w, `{"error":"invalid workspace name"}`, http.StatusBadRequest)
				return
			}
			switch action {
			case "trash":
				s.handleTrashWorkspace(w, r, email, workspaceName)
				return
			case "restore":
				s.handleRestoreWorkspace(w, r, email, workspaceName)
				return
			case "update":
				s.handleUpdateWorkspace(w, r, email, workspaceName)
				return
			}
		}
	}

	// --- Admin-only routes below ---
	if !isAdmin(r) {
		http.Error(w, `{"error":"admin only"}`, http.StatusForbidden)
		return
	}

	switch r.URL.Path {
	case "/bailey/api/overview":
		if r.Method == http.MethodGet {
			s.handleBaileyOverview(w, r)
			return
		}
	case "/bailey/api/people":
		if r.Method == http.MethodGet {
			handleBaileyPeople(w, r)
			return
		}
	case "/bailey/api/people/org-users":
		if r.Method == http.MethodGet {
			handleBaileyOrgUsers(w, r)
			return
		}
	case "/bailey/api/people/invite":
		if r.Method == http.MethodPost {
			handleBaileyPeopleInvite(w, r, email)
			return
		}
	case "/bailey/api/people/invites":
		if r.Method == http.MethodGet {
			handleBaileyInvitesList(w, r)
			return
		}
	case "/bailey/api/people/invites/revoke":
		if r.Method == http.MethodPost {
			handleBaileyInviteRevoke(w, r, email)
			return
		}
	case "/bailey/api/people/invites/resend":
		if r.Method == http.MethodPost {
			handleBaileyInviteResend(w, r, email)
			return
		}
	case "/bailey/api/people/role":
		if r.Method == http.MethodPost {
			handleSetUserRole(w, r, email)
			return
		}
	case "/bailey/api/admin/region":
		if r.Method == http.MethodPost {
			handleSetRegion(w, r, email)
			return
		}
	case "/bailey/api/admin/siem":
		switch r.Method {
		case http.MethodGet:
			handleSIEMGet(w, r)
			return
		case http.MethodPost:
			handleSIEMSet(w, r, email)
			return
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
	case "/bailey/api/admin/devices":
		if r.Method == http.MethodGet {
			handleAdminDevicesAPI(w, r)
			return
		}
	case "/bailey/api/admin/devices/remove":
		if r.Method == http.MethodPost {
			handleAdminDeviceRemoveAPI(w, r)
			return
		}
	case "/bailey/api/admin/network-map":
		if r.Method == http.MethodGet {
			handleNetworkMapAPI(w, r)
			return
		}
	case "/bailey/api/admin/acl":
		if r.Method == http.MethodGet {
			handleAdminACLTree(w, r)
			return
		}
	case "/bailey/api/admin/default-images":
		switch r.Method {
		case http.MethodGet:
			s.handleAdminDefaultImagesGet(w, r)
			return
		case http.MethodPost:
			s.handleAdminDefaultImagesPost(w, r, email)
			return
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
	}

	http.NotFound(w, r)
}
