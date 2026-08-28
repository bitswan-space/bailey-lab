package daemon

import (
	"net/http"
	"net/http/httptest"
	"net/url"
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
	wrappedHandler(t).ServeHTTP(w, browserGet(t, host, "/some/page?x=1", "user@example.com"))

	if w.Header().Get("X-Test-Inner") == "1" {
		t.Fatal("outer browser GET reached the inner handler instead of the wrap")
	}
	body := w.Body.String()
	inner := toInnerHost(host)
	// The inner host holds its own host-only device cookie, so the wrap points
	// the iframe's first load at the inner device-claim (which sets that cookie)
	// carrying the requested path as ?return= — all on the inner host.
	if !strings.Contains(body, `src="https://`+inner+`/2fa-gate/api/device-claim?grant=`) {
		t.Errorf("wrap iframe should route the first load through the inner device-claim:\n%s", body)
	}
	if !strings.Contains(body, url.QueryEscape("/some/page?x=1")) {
		t.Errorf("wrap iframe device-claim doesn't carry the requested path as return:\n%s", body)
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

// TestChromeWrap_OnboardNeverServesConsoleToTrustedDevice: bailey-onboard is the
// device-trust ONBOARDING host only. A device that's already trusted has
// finished onboarding and must be bounced OFF the host — never shown the
// console/admin SPA there (regression: onboard rendered the /workspaces admin).
func TestChromeWrap_OnboardNeverServesConsoleToTrustedDevice(t *testing.T) {
	domain := writeTestConfig(t)
	onboard := serverConsoleOnboardHost(domain)
	w := httptest.NewRecorder()
	// browserGet → trust() attaches a valid device cookie, so this device is trusted.
	wrappedHandler(t).ServeHTTP(w, browserGet(t, onboard, "/workspaces", "admin@example.com"))
	if w.Code != http.StatusSeeOther {
		t.Fatalf("onboard + trusted device: status = %d, want 303 (bounced off the onboard host)", w.Code)
	}
	if loc := w.Header().Get("Location"); loc == "" || strings.Contains(loc, onboard) {
		t.Errorf("did not bounce the trusted device off the onboard host: Location = %q", loc)
	}
}

// A signed-in but UNtrusted device must still be served the onboarding SPA on
// the onboard host (so it can render the pairing scene) — not redirected.
func TestChromeWrap_OnboardServesOnboardingToUntrustedDevice(t *testing.T) {
	domain := writeTestConfig(t)
	onboard := serverConsoleOnboardHost(domain)
	// Signed in (identity header) but NO device cookie → untrusted.
	r := onboardGet(onboard, "/", "newbie@example.com")
	w := httptest.NewRecorder()
	wrappedHandler(t).ServeHTTP(w, r)
	if w.Code == http.StatusSeeOther {
		t.Fatalf("onboard bounced an UNtrusted device instead of serving the pairing scene (loc=%q)", w.Header().Get("Location"))
	}
}

// onboardGet builds a signed-in but UNTRUSTED top-level document request (no
// device cookie) — the shape a browser sends when it lands on the public
// onboarding host for the first time.
func onboardGet(host, path, email string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "https://"+host+path, nil)
	r.Host = host
	r.Header.Set("Accept", "text/html,application/xhtml+xml")
	if email != "" {
		r.Header.Set("X-Forwarded-Email", email)
	}
	return r
}

// consoleRoutes are the SPA's own client-side routes. Each is a real path a
// browser can be pointed at, and each names an admin surface.
var consoleRoutes = []string{
	"/workspaces", "/overview", "/people", "/devices", "/security",
	"/resources", "/updates", "/backups", "/handbook",
}

// TestChromeWrap_OnboardNeverDeliversAConsoleRouteDocument is the core #403
// assertion: the PUBLIC onboarding host has exactly ONE document — the
// device-trust scene at "/". Every console route must be sent there instead.
//
// This is what made the reported state reachable: serveServerConsole falls
// unknown paths back to index.html, so bailey-onboard/<anything> answered 200
// with the console shell. The shell then decides what to render client-side —
// and on a host with no chrome wrap that meant the bare admin page.
func TestChromeWrap_OnboardNeverDeliversAConsoleRouteDocument(t *testing.T) {
	domain := writeTestConfig(t)
	onboard := serverConsoleOnboardHost(domain)

	for _, route := range consoleRoutes {
		t.Run("untrusted"+route, func(t *testing.T) {
			w := httptest.NewRecorder()
			wrappedHandler(t).ServeHTTP(w, onboardGet(onboard, route, "newbie@example.com"))
			if w.Code != http.StatusSeeOther {
				t.Fatalf("%s: status = %d, want 303 to the one onboarding page (body=%.120q)",
					route, w.Code, w.Body.String())
			}
			if loc := w.Header().Get("Location"); loc != "/" {
				t.Errorf("%s: Location = %q, want %q", route, loc, "/")
			}
			if bodyLooksLikeSPA(w) {
				t.Errorf("%s: onboarding host delivered the console shell", route)
			}
		})

		t.Run("trusted"+route, func(t *testing.T) {
			w := httptest.NewRecorder()
			wrappedHandler(t).ServeHTTP(w, browserGet(t, onboard, route, "admin@example.com"))
			if w.Code != http.StatusSeeOther {
				t.Fatalf("%s: status = %d, want 303 off the onboarding host", route, w.Code)
			}
			if loc := w.Header().Get("Location"); strings.Contains(loc, onboard) {
				t.Errorf("%s: bounced back onto the onboarding host: %q", route, loc)
			}
			if bodyLooksLikeSPA(w) {
				t.Errorf("%s: onboarding host delivered the console shell to a trusted device", route)
			}
		})
	}
}

// The redirect to "/" must keep the query, because the query is what tells the
// SPA which scene to render (?return= after a gate bounce, ?invite=<token> from
// an invite link, ?recover for account recovery). Dropping it would strand the
// user on a generic scene — or silently void an invite.
func TestChromeWrap_OnboardRedirectKeepsTheSceneQuery(t *testing.T) {
	domain := writeTestConfig(t)
	onboard := serverConsoleOnboardHost(domain)
	w := httptest.NewRecorder()
	wrappedHandler(t).ServeHTTP(w, onboardGet(onboard, "/workspaces?invite=tok123&return=x", "newbie@example.com"))
	if got, want := w.Header().Get("Location"), "/?invite=tok123&return=x"; got != want {
		t.Errorf("Location = %q, want %q", got, want)
	}
}

// A non-document request (fetch/XHR/asset probe) for a path that is not a real
// file must 404, not fall back to index.html. Otherwise the console shell is
// still retrievable from the onboarding host — just through a different request
// shape than a navigation.
func TestChromeWrap_OnboardDoesNotSmuggleTheShellThroughAnAssetProbe(t *testing.T) {
	domain := writeTestConfig(t)
	onboard := serverConsoleOnboardHost(domain)

	for _, p := range []string{"/workspaces", "/assets/does-not-exist.js", "/some/deep/path"} {
		r := httptest.NewRequest(http.MethodGet, "https://"+onboard+p, nil)
		r.Host = onboard
		r.Header.Set("Accept", "*/*") // not a document navigation
		r.Header.Set("X-Forwarded-Email", "newbie@example.com")
		w := httptest.NewRecorder()
		wrappedHandler(t).ServeHTTP(w, r)
		if w.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", p, w.Code)
		}
		if bodyLooksLikeSPA(w) {
			t.Errorf("%s: asset probe got the console shell back", p)
		}
	}
}

// The gate/data APIs and the oauth2 endpoints must keep flowing to the daemon
// on the onboarding host — they are how an untrusted device becomes trusted, so
// the path restriction must not catch them.
func TestChromeWrap_OnboardStillRoutesTheGateAPIs(t *testing.T) {
	domain := writeTestConfig(t)
	onboard := serverConsoleOnboardHost(domain)

	for _, p := range []string{"/bailey/api/gate-state", "/bailey/api/claim", "/2fa-gate/pending-pair", "/oauth2/start"} {
		r := httptest.NewRequest(http.MethodGet, "https://"+onboard+p, nil)
		r.Host = onboard
		r.Header.Set("Accept", "application/json")
		r.Header.Set("X-Forwarded-Email", "newbie@example.com")
		w := httptest.NewRecorder()
		wrappedHandler(t).ServeHTTP(w, r)
		if w.Header().Get("X-Test-Inner") != "1" {
			t.Errorf("%s: did not reach the daemon (status=%d, loc=%q)", p, w.Code, w.Header().Get("Location"))
		}
	}
}

// onboardServableAsset decides what the onboarding host may answer directly.
// "/" is the one page; anything that isn't a real file in the bundle is not
// servable there (the SPA fallback is what leaked the shell).
func TestOnboardServableAsset(t *testing.T) {
	for _, p := range []string{"/", "", "/index.html"} {
		if !onboardServableAsset(p) {
			t.Errorf("onboardServableAsset(%q) = false, want true", p)
		}
	}
	for _, p := range []string{"/workspaces", "/assets/nope.js", "/../secret", "/people"} {
		if onboardServableAsset(p) {
			t.Errorf("onboardServableAsset(%q) = true, want false", p)
		}
	}
}

// The mode the shell is stamped with is decided by the host that serves it —
// including through the chrome wrap's inner hostname, which is what the SPA
// actually sees in window.location (so the SPA must not derive this itself).
func TestConsoleModeForHost(t *testing.T) {
	domain := writeTestConfig(t)
	onboard := serverConsoleOnboardHost(domain)
	cases := map[string]string{
		onboard:                          "onboarding",
		toInnerHost(onboard):             "onboarding",
		serverConsoleHost(domain):        "console",
		"someapp." + domain:              "console",
		toInnerHost("someapp." + domain): "console",
	}
	for host, want := range cases {
		if got := consoleModeForHost(host); got != want {
			t.Errorf("consoleModeForHost(%q) = %q, want %q", host, got, want)
		}
	}
}

// injectConsoleMode must always put the statement in the document. The SPA
// fails CLOSED on a missing meta (consoleMode() in console-app.jsx), so a
// silent no-op here would take the console down rather than leak it — but it
// would still be a bug, so both shapes are covered.
func TestInjectConsoleMode(t *testing.T) {
	withHead := []byte("<!doctype html><html><head><title>x</title></head><body></body></html>")
	got := string(injectConsoleMode(withHead, "onboarding"))
	if !strings.Contains(got, `<meta name="bitswan-console-mode" content="onboarding">`) {
		t.Errorf("mode meta missing:\n%s", got)
	}
	if strings.Index(got, "bitswan-console-mode") > strings.Index(got, "<title>") {
		t.Error("mode meta must come before the rest of <head>, so it is set before the bundle reads it")
	}
	noHead := []byte("<div id=\"root\"></div>")
	if !strings.Contains(string(injectConsoleMode(noHead, "console")), `content="console"`) {
		t.Error("injectConsoleMode dropped the statement when there was no <head>")
	}
}

func TestChromeWrap_InnerHostPassesThrough(t *testing.T) {
	host := "wrap-pass--inner.example.com"
	w := httptest.NewRecorder()
	wrappedHandler(t).ServeHTTP(w, browserGet(t, host, "/", "user@example.com"))
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
	wrappedHandler(t).ServeHTTP(w, browserGet(t, host, "/", ""))
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
	wrappedHandler(t).ServeHTTP(w, browserGet(t, host, "/", "owner@example.com"))
	if !strings.Contains(w.Body.String(), "__baileyShareOpen") {
		t.Error("owner wrap missing the Share button")
	}

	// An access-role member passes the outer-host ACL and gets the wrap,
	// but without the Share button (only owners manage sharing).
	if err := addGrant(host, "email", "viewer@example.com", string(roleAccess), "owner@example.com"); err != nil {
		t.Fatal(err)
	}
	w2 := httptest.NewRecorder()
	wrappedHandler(t).ServeHTTP(w2, browserGet(t, host, "/", "viewer@example.com"))
	if !strings.Contains(w2.Body.String(), "bailey-footer") {
		t.Error("access-role member didn't get the wrap")
	}
	if strings.Contains(w2.Body.String(), "__baileyShareOpen") {
		t.Error("non-owner wrap shows the Share button")
	}

	// A user with no role at all is denied at the outer host — no wrap,
	// and the generic denial page (no leak of host/owner).
	w3 := httptest.NewRecorder()
	wrappedHandler(t).ServeHTTP(w3, browserGet(t, host, "/", "stranger@example.com"))
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

// The bounce off the onboarding host must not land back on it. The origin
// cookie that supplies the target is scoped to the whole protected domain — the
// comment on rememberOrigin says so — which means any sibling app can plant it.
// Both shapes it can take are covered: an absolute same-site URL naming the
// onboarding host, and a bare path (which has no host and would therefore
// resolve against the host we are trying to leave).
func TestOriginRedirect_NeverReturnsToTheOnboardingHost(t *testing.T) {
	domain := writeTestConfig(t)
	onboard := serverConsoleOnboardHost(domain)
	console := "https://" + serverConsoleHost(domain) + "/"

	if got := safeOriginTarget("https://" + onboard + "/workspaces"); got != console {
		t.Errorf("safeOriginTarget(onboarding URL) = %q, want the console root %q", got, console)
	}
	// A legitimate same-site app target still survives.
	app := "https://someapp." + domain + "/page"
	if got := safeOriginTarget(app); got != app {
		t.Errorf("safeOriginTarget(%q) = %q, want it unchanged", app, got)
	}

	for _, planted := range []string{"https://" + onboard + "/workspaces", "/workspaces"} {
		r := onboardGet(onboard, "/", "admin@example.com")
		r.AddCookie(&http.Cookie{Name: gateOriginCookie, Value: planted})
		w := httptest.NewRecorder()
		originRedirect(w, r)
		loc := w.Header().Get("Location")
		if strings.Contains(loc, onboard) {
			t.Errorf("planted %q: bounced back to the onboarding host (%q)", planted, loc)
		}
		if !strings.HasPrefix(loc, "https://") {
			t.Errorf("planted %q: Location = %q, want an absolute URL naming another host", planted, loc)
		}
	}
}
