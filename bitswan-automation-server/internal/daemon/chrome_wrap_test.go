package daemon

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// wrappedHandler builds the middleware around a marker inner handler
// so tests can tell pass-through from wrap.
//
// These tests exercise the chrome wrap in isolation; the device-trust
// gate (enforceMFAGate) now sits in front of it inside the same
// middleware and would redirect every untrusted request before the wrap
// ran. The tests therefore present a TRUSTED device (see browserGet/trust)
// so they reach the wrap; gate behaviour is covered separately in
// mfa_gate_test.go.
func wrappedHandler(t *testing.T) http.Handler {
	t.Helper()
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Test-Inner", "1")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("inner content"))
	})
	return chromeWrapMiddleware(inner)
}

func browserGet(t *testing.T, host, path, email string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "https://"+host+path, nil)
	r.Host = host
	r.Header.Set("Accept", "text/html,application/xhtml+xml")
	if email != "" {
		r.Header.Set("X-Forwarded-Email", email)
	}
	return trust(t, r, email)
}

// trust pairs a device for email and attaches its signed cookie so the request
// clears the device-trust gate that now runs in front of the chrome wrap. The
// wrap/ACL tests rely on this to reach the wrap; the gate itself is covered in
// mfa_gate_test.go. No-op for the identity-less case (the gate passes those
// through anyway).
func trust(t *testing.T, r *http.Request, email string) *http.Request {
	t.Helper()
	if email == "" {
		return r
	}
	rec, err := addDevice(email, "wrap-test")
	if err != nil {
		t.Fatal(err)
	}
	cw := httptest.NewRecorder()
	if err := setDeviceCookie(cw, r, email, rec.ID); err != nil {
		t.Fatal(err)
	}
	for _, c := range cw.Result().Cookies() {
		r.AddCookie(c)
	}
	return r
}

func TestChromeWrap_OuterHostGetsWrap(t *testing.T) {
	host := "wrap-outer.example.com"
	w := httptest.NewRecorder()
	wrappedHandler(t).ServeHTTP(w, browserGet(t, host,"/some/page?x=1", "user@example.com"))

	if w.Header().Get("X-Test-Inner") == "1" {
		t.Fatal("outer browser GET reached the inner handler instead of the wrap")
	}
	body := w.Body.String()
	inner := toInnerHost(host)
	if !strings.Contains(body, `src="https://`+inner+`/some/page?x=1"`) {
		t.Errorf("wrap iframe doesn't carry the requested path:\n%s", body)
	}
	if !strings.Contains(body, "Protected by Bitswan") || !strings.Contains(body, "bailey-footer") {
		t.Error("wrap footer missing")
	}
	if !strings.Contains(body, "user@example.com") {
		t.Error("wrap doesn't show the signed-in identity")
	}
	csp := w.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "frame-src https://"+inner) {
		t.Errorf("wrap CSP doesn't pin the iframe to the inner host: %q", csp)
	}
}

func TestChromeWrap_InnerHostPassesThrough(t *testing.T) {
	host := "wrap-pass--inner.example.com"
	w := httptest.NewRecorder()
	wrappedHandler(t).ServeHTTP(w, browserGet(t, host,"/", "user@example.com"))
	if w.Header().Get("X-Test-Inner") != "1" {
		t.Error("inner-host request didn't reach the inner handler")
	}
}

func TestChromeWrap_NonHTMLOnOuterIs404(t *testing.T) {
	host := "wrap-nonhtml.example.com"
	r := httptest.NewRequest(http.MethodGet, "https://"+host+"/api/data", nil)
	r.Host = host
	r.Header.Set("Accept", "application/json")
	r.Header.Set("X-Forwarded-Email", "user@example.com")
	w := httptest.NewRecorder()
	wrappedHandler(t).ServeHTTP(w, trust(t, r, "user@example.com"))
	if w.Code != http.StatusNotFound {
		t.Errorf("non-HTML on outer host: status = %d, want 404 (the outer host has no app surface)", w.Code)
	}
}

func TestChromeWrap_PostOnOuterIs404(t *testing.T) {
	host := "wrap-post.example.com"
	r := httptest.NewRequest(http.MethodPost, "https://"+host+"/submit", strings.NewReader("x=1"))
	r.Host = host
	r.Header.Set("Accept", "text/html")
	r.Header.Set("X-Forwarded-Email", "user@example.com")
	w := httptest.NewRecorder()
	wrappedHandler(t).ServeHTTP(w, trust(t, r, "user@example.com"))
	if w.Code != http.StatusNotFound {
		t.Errorf("POST on outer host: status = %d, want 404", w.Code)
	}
}

func TestChromeWrap_GateAPIPassesThroughOnOuter(t *testing.T) {
	// The share modal fetches /2fa-gate/api/share/<host> on the outer
	// origin (its CSP only allows connect-src 'self'); the middleware
	// must hand those to the inner handler even on the outer host.
	host := "wrap-api.example.com"
	r := httptest.NewRequest(http.MethodPost, "https://"+host+gatePathPrefix+"/api/share/"+host, nil)
	r.Host = host
	r.Header.Set("X-Forwarded-Email", "user@example.com")
	w := httptest.NewRecorder()
	wrappedHandler(t).ServeHTTP(w, trust(t, r, "user@example.com"))
	if w.Header().Get("X-Test-Inner") != "1" {
		t.Error("gate API call on outer host didn't pass through")
	}
}

func TestChromeWrap_NoIdentityFallsThrough(t *testing.T) {
	host := "wrap-noident.example.com"
	w := httptest.NewRecorder()
	wrappedHandler(t).ServeHTTP(w, browserGet(t, host,"/", ""))
	if w.Header().Get("X-Test-Inner") != "1" {
		t.Error("identity-less request should fall through to the inner handler (upstream will reject)")
	}
}

func TestChromeWrap_OwnerSeesShareButton(t *testing.T) {
	host := "wrap-share-owner.example.com"
	if _, err := registerEndpoint(host, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}

	// Owner gets the Share button + modal.
	w := httptest.NewRecorder()
	wrappedHandler(t).ServeHTTP(w, browserGet(t, host,"/", "owner@example.com"))
	if !strings.Contains(w.Body.String(), "__baileyShareOpen") {
		t.Error("owner wrap missing the Share button")
	}

	// An access-role member passes the outer-host ACL and gets the wrap,
	// but without the Share button (only owners manage sharing).
	if err := addGrant(host, "email", "viewer@example.com", string(roleAccess), "owner@example.com"); err != nil {
		t.Fatal(err)
	}
	w2 := httptest.NewRecorder()
	wrappedHandler(t).ServeHTTP(w2, browserGet(t, host,"/", "viewer@example.com"))
	if !strings.Contains(w2.Body.String(), "bailey-footer") {
		t.Error("access-role member didn't get the wrap")
	}
	if strings.Contains(w2.Body.String(), "__baileyShareOpen") {
		t.Error("non-owner wrap shows the Share button")
	}

	// A user with no role at all is denied at the outer host — no wrap,
	// and the generic denial page (no leak of host/owner).
	w3 := httptest.NewRecorder()
	wrappedHandler(t).ServeHTTP(w3, browserGet(t, host,"/", "stranger@example.com"))
	if w3.Code != http.StatusForbidden {
		t.Errorf("stranger on outer host: status = %d, want 403", w3.Code)
	}
	if strings.Contains(w3.Body.String(), "bailey-footer") || strings.Contains(w3.Body.String(), host) {
		t.Errorf("stranger got the wrap or saw the endpoint host:\n%s", w3.Body.String())
	}
	if !strings.Contains(w3.Body.String(), "not a member of this organization") {
		t.Errorf("stranger denial page missing generic message:\n%s", w3.Body.String())
	}
}

func TestNavSyncInjection(t *testing.T) {
	html := []byte("<html><body><h1>App</h1></body></html>")
	out := string(appendNavSyncToHTML(html))
	if !strings.Contains(out, "bailey-nav") {
		t.Error("nav-sync script not injected")
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "</body></html>") {
		t.Errorf("script not inserted before </body>: %s", out)
	}

	// No </body> tag → appended at the end.
	out2 := string(appendNavSyncToHTML([]byte("plain fragment")))
	if !strings.Contains(out2, "bailey-nav") {
		t.Error("nav-sync script not appended to tagless body")
	}
}
