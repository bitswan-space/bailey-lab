package daemon

import (
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// Sharing surfaces, all served under the gate path prefix (/2fa-gate):
//
//   /2fa-gate/share                  index of endpoints the caller owns
//   /2fa-gate/share/<host>           standalone share page (the modal,
//                                    pre-opened on its own URL)
//   /2fa-gate/api/share/<host>       JSON API the modal talks to
//   /2fa-gate/request-access/<host>  POST from the denied page
//
// Writes are owner-only everywhere; the request-access POST is open to
// any signed-in user (that's its whole point).

// handleShareEndpoint renders the share index or a per-endpoint share
// page, and accepts the form POSTs from the no-JS fallback.
func handleShareEndpoint(w http.ResponseWriter, r *http.Request, email string, groups []string) {
	host := strings.TrimPrefix(r.URL.Path, gatePathPrefix+"/share")
	host = strings.Trim(host, "/")
	host, _ = url.PathUnescape(host)
	if host == "" {
		handleShareIndex(w, email, groups)
		return
	}

	ep, err := getEndpoint(host)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if ep == nil {
		http.Error(w, "no such endpoint: "+host, http.StatusNotFound)
		return
	}
	role, err := roleFor(host, email, groups)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if role != roleOwner {
		http.Error(w, "owners only", http.StatusForbidden)
		return
	}

	if r.Method == http.MethodPost {
		if err := r.ParseForm(); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := applyShareAction(host, email, r); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		http.Redirect(w, r, gatePathPrefix+"/share/"+url.PathEscape(host), http.StatusSeeOther)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, sharePageHTML(ep, email))
}

// applyShareAction executes one form-encoded mutation against an
// endpoint's ACL. Shared between the HTML form handler and the JSON
// API. The caller must already have verified owner role.
func applyShareAction(host, callerEmail string, r *http.Request) error {
	switch action := strings.TrimSpace(r.FormValue("action")); action {
	case "", "grant":
		pType := strings.TrimSpace(r.FormValue("principal_type"))
		pVal := strings.TrimSpace(r.FormValue("principal_value"))
		role := strings.TrimSpace(r.FormValue("role"))
		if role == "" {
			role = string(roleAccess)
		}
		if pVal == "" {
			return fmt.Errorf("principal_value required")
		}
		if err := addGrant(host, pType, pVal, role, callerEmail); err != nil {
			return err
		}
		// A fresh grant satisfies any pending request from that email.
		if pType == "email" {
			_ = removeAccessRequest(host, pVal)
		}
		return nil
	case "revoke":
		return removeGrant(host,
			strings.TrimSpace(r.FormValue("principal_type")),
			strings.TrimSpace(r.FormValue("principal_value")),
			strings.TrimSpace(r.FormValue("role")))
	case "deny-request":
		target := strings.TrimSpace(r.FormValue("email"))
		if target == "" {
			return fmt.Errorf("email required to deny request")
		}
		return removeAccessRequest(host, target)
	default:
		return fmt.Errorf("unknown action %q", action)
	}
}

func handleShareIndex(w http.ResponseWriter, email string, groups []string) {
	endpoints, _ := listEndpointsWhereUserCanShare(email, groups)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, shareIndexHTML(email, endpoints))
}

// handleShareAPI is the JSON sibling of handleShareEndpoint — what the
// in-wrap modal calls so the user can manage grants without leaving
// the page.
//
//	GET    /2fa-gate/api/share/<host> → {owner_email, grants, requests}
//	POST   /2fa-gate/api/share/<host> → add grant / deny-request
//	       (form-encoded: principal_type, principal_value, role —
//	        or action=deny-request&email=...) → returns updated GET
//	DELETE /2fa-gate/api/share/<host> → revoke grant (same form fields)
//	       → returns updated GET
//
// Only owners may use it — same rule as the HTML share page.
func handleShareAPI(w http.ResponseWriter, r *http.Request, email string, groups []string) {
	host := strings.TrimPrefix(r.URL.Path, gatePathPrefix+"/api/share/")
	host = strings.TrimRight(host, "/")
	host, _ = url.PathUnescape(host)
	if host == "" {
		writeJSONErrorStatus(w, "host required", http.StatusBadRequest)
		return
	}

	ep, err := getEndpoint(host)
	if err != nil {
		writeJSONErrorStatus(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if ep == nil {
		writeJSONErrorStatus(w, "endpoint not registered", http.StatusNotFound)
		return
	}
	role, err := roleFor(host, email, groups)
	if err != nil {
		writeJSONErrorStatus(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if role != roleOwner {
		writeJSONErrorStatus(w, "owners only", http.StatusForbidden)
		return
	}

	writeListing := func() {
		grants, _ := listGrants(host)
		requests, _ := listAccessRequests(host)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"hostname":     ep.Hostname,
			"owner_email":  ep.OwnerEmail,
			"display_name": ep.DisplayName,
			"grants":       grants,
			"requests":     requests,
		})
	}

	switch r.Method {
	case http.MethodGet:
		writeListing()
	case http.MethodPost, http.MethodDelete:
		if err := r.ParseForm(); err != nil {
			writeJSONErrorStatus(w, err.Error(), http.StatusBadRequest)
			return
		}
		if r.Method == http.MethodDelete {
			// ParseForm only reads the body for POST/PUT/PATCH, but the
			// modal sends revokes as DELETE with a form-encoded body —
			// parse it explicitly or the principal fields come up empty
			// and the revoke silently matches nothing.
			body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<16))
			if err != nil {
				writeJSONErrorStatus(w, err.Error(), http.StatusBadRequest)
				return
			}
			vals, err := url.ParseQuery(string(body))
			if err != nil {
				writeJSONErrorStatus(w, err.Error(), http.StatusBadRequest)
				return
			}
			for k, vv := range vals {
				for _, v := range vv {
					r.Form.Add(k, v)
				}
			}
			// DELETE has no action field — it's always a revoke.
			r.Form.Set("action", "revoke")
		}
		if err := applyShareAction(host, email, r); err != nil {
			writeJSONErrorStatus(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeListing()
	default:
		writeJSONErrorStatus(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// writeJSONErrorStatus writes {"error": msg} with the given status.
func writeJSONErrorStatus(w http.ResponseWriter, msg string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// handleRequestAccess records an access request via POST. Used by the
// denied page's "Request access" button. Any signed-in user may call
// it; it only ever appends to the owner-visible request list.
func handleRequestAccess(w http.ResponseWriter, r *http.Request, email string) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	host := strings.TrimPrefix(r.URL.Path, gatePathPrefix+"/request-access/")
	host = strings.TrimRight(host, "/")
	host, _ = url.PathUnescape(host)
	if host == "" {
		http.Error(w, "host required", http.StatusBadRequest)
		return
	}
	ep, err := getEndpoint(host)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if ep == nil {
		// Requests against unregistered endpoints have no owner to show
		// them to; the FK on access_requests would reject the row anyway.
		http.Error(w, "no such endpoint: "+host, http.StatusNotFound)
		return
	}
	if err := addAccessRequest(host, email); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<!doctype html><html><head><meta charset="utf-8"><style>%s</style><title>Access requested</title></head><body>
<div class="header">%s<h1>Access requested</h1></div>
<div class="card">
  <p>Your request to access <code>%s</code> has been sent to the endpoint owner.</p>
  <p class="note">They'll see it in their share dialog. You'll be able to reach the endpoint as soon as they grant access.</p>
</div></body></html>`,
		bitswanPageCSS, bitswanLogoSVG, html.EscapeString(host))
}

// --- HTML ---

// accessDeniedHTML is the page the gate renders when a signed-in user
// has no role on a registered endpoint.
func accessDeniedHTML(host string, ep *endpointRecord, email string) string {
	ownerLine := "unknown"
	if ep != nil && ep.OwnerEmail != "" {
		ownerLine = ep.OwnerEmail
	}
	requestPath := gatePathPrefix + "/request-access/" + url.PathEscape(host)
	body := fmt.Sprintf(`
<div class="header">%s<h1>Access required</h1></div>
<div class="card">
  <p>You're signed in as <code>%s</code>, but you don't have access to <code>%s</code>.</p>
  <p class="note">This endpoint is owned by <code>%s</code>. They can grant you access from their share dialog.</p>
  <form method="POST" action="%s">
    <button type="submit">Request access</button>
  </form>
</div>`,
		bitswanLogoSVG, html.EscapeString(email), html.EscapeString(host),
		html.EscapeString(ownerLine), html.EscapeString(requestPath))
	return fmt.Sprintf(`<!doctype html><html><head><meta charset="utf-8"><title>Access required</title><style>%s</style></head><body>%s</body></html>`,
		bitswanPageCSS, body)
}

func shareIndexHTML(email string, endpoints []endpointRecord) string {
	rows := ""
	if len(endpoints) == 0 {
		rows = `<p class="note">You don't own any endpoints yet. When you create a workspace or deploy an automation, you'll be its owner and can manage sharing here.</p>`
	} else {
		var b strings.Builder
		b.WriteString(`<table><thead><tr><th>Endpoint</th><th>Created</th><th></th></tr></thead><tbody>`)
		for _, e := range endpoints {
			fmt.Fprintf(&b, `<tr>
  <td><b>%s</b><br><span class="note">%s</span></td>
  <td class="note">%s</td>
  <td style="text-align:right;"><a href="%s/share/%s" style="color:#093DF5;text-decoration:none;">Manage sharing →</a></td>
</tr>`,
				html.EscapeString(e.Hostname),
				html.EscapeString(e.DisplayName),
				html.EscapeString(e.CreatedAt),
				gatePathPrefix, url.PathEscape(e.Hostname))
		}
		b.WriteString(`</tbody></table>`)
		rows = b.String()
	}
	body := fmt.Sprintf(`
<div class="header">%s<h1>Endpoints you can share</h1></div>
<div class="card">
  <p>Signed in as <code>%s</code>. These are the endpoints where you're an owner — you can grant access, view who has it, and approve pending requests.</p>
  %s
</div>`, bitswanLogoSVG, html.EscapeString(email), rows)
	return fmt.Sprintf(`<!doctype html><html><head><meta charset="utf-8"><title>Share endpoints</title><style>%s</style></head><body>%s</body></html>`,
		bitswanPageCSS, body)
}

// sharePageHTML renders the standalone share page using the same
// modal-card component that lives inside the chrome wrap. Same look,
// same JS, same API — this page is just the modal pre-opened on a
// dedicated URL. The JS fetches all state from the share API.
func sharePageHTML(ep *endpointRecord, callerEmail string) string {
	apiURL := gatePathPrefix + "/api/share/" + url.PathEscape(ep.Hostname)
	pageCSS := `
body { margin:0; background:#F4F4F5; min-height:100vh; font:14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#18181B; }
.share-page-topbar { background:#fff; border-bottom:1px solid #E4E4E7; padding:14px 24px; display:flex; align-items:center; gap:16px; }
.share-page-topbar a.back { color:#71717A; text-decoration:none; font-size:13px; }
.share-page-topbar a.back:hover { color:#18181B; }
.share-page-topbar h1 { margin:0; font-size:15px; font-weight:600; color:#18181B; }
.share-page-topbar .sub { color:#71717A; font-size:13px; }
.share-page-wrap { padding:48px 16px; display:flex; justify-content:center; }
/* Reuse the modal card directly — drop the backdrop so it's just the card on the page. */
.bailey-share-backdrop { position:static; background:none; display:flex !important; padding:0; }
.bailey-share-card { box-shadow:0 4px 12px rgba(0,0,0,0.06); }
`
	return fmt.Sprintf(`<!doctype html><html><head><meta charset="utf-8"><title>Share %s</title>
<style>%s
%s
</style></head><body>
<div class="share-page-topbar">
  <a class="back" href="%s/share">← Endpoints you can share</a>
  <div>
    <h1>Sharing</h1>
    <div class="sub"><code>%s</code></div>
  </div>
</div>
<div class="share-page-wrap">%s</div>
<script>%s
// Auto-open: this page IS the modal, opened.
document.addEventListener('DOMContentLoaded', function(){ window.__baileyShareOpen(); });
</script>
</body></html>`,
		html.EscapeString(ep.Hostname),
		shareModalCSS, pageCSS,
		gatePathPrefix,
		html.EscapeString(ep.Hostname),
		shareModalHTML(),
		shareModalJS(ep.Hostname, callerEmail, apiURL))
}
