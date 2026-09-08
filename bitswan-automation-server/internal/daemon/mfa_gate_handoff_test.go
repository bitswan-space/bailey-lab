package daemon

import (
	"html"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

var metaRefreshTarget = regexp.MustCompile(`(?i)<meta http-equiv="refresh" content="0;url=([^"]*)"`)

func gateDestination(w *httptest.ResponseRecorder) string {
	if loc := w.Header().Get("Location"); loc != "" {
		return loc
	}
	if m := metaRefreshTarget.FindStringSubmatch(w.Body.String()); len(m) == 2 {
		return html.UnescapeString(m[1])
	}
	return ""
}

func untrustedConsoleGate(t *testing.T) (*httptest.ResponseRecorder, string) {
	t.Helper()
	markServerClaimed(t)
	domain := writeTestConfig(t)
	w := httptest.NewRecorder()
	if enforceMFAGate(w, gateReq(serverConsoleHost(domain), "/", "user@example.com", nil)) {
		t.Fatal("untrusted device passed the gate on the console host")
	}
	return w, domain
}

func TestGateHandoff_IsADocumentAndNotAServerRedirect(t *testing.T) {
	w, _ := untrustedConsoleGate(t)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
	if w.Code >= 300 && w.Code < 400 {
		t.Errorf("status = %d: the gate must not redirect an untrusted device", w.Code)
	}
	if loc := w.Header().Get("Location"); loc != "" {
		t.Errorf("Location = %q, want no redirect header", loc)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html", ct)
	}
}

func TestGateHandoff_TargetsTheOnboardDeviceGrant(t *testing.T) {
	w, domain := untrustedConsoleGate(t)

	got := gateDestination(w)
	want := "https://" + serverConsoleOnboardHost(domain) + "/2fa-gate/api/device-grant"
	if got != want {
		t.Errorf("handoff target = %q, want %q", got, want)
	}
}

func TestGateHandoff_WorksWithoutScript(t *testing.T) {
	w, domain := untrustedConsoleGate(t)

	body := w.Body.String()
	target := "https://" + serverConsoleOnboardHost(domain) + "/2fa-gate/api/device-grant"
	if !metaRefreshTarget.MatchString(body) {
		t.Error("handoff has no meta refresh; a browser with script disabled would stall")
	}
	if !strings.Contains(body, `<a href="`+target+`"`) {
		t.Error("handoff offers no plain link to continue")
	}
	if strings.Contains(strings.ToLower(body), "<script") {
		t.Error("handoff depends on script; want it to work with script disabled")
	}
}

func TestGateHandoff_IsNotCached(t *testing.T) {
	w, _ := untrustedConsoleGate(t)

	if cc := w.Header().Get("Cache-Control"); !strings.Contains(cc, "no-store") {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
}

func TestGateHandoff_StashesTheOriginAndPairsNothing(t *testing.T) {
	markServerClaimed(t)
	domain := writeTestConfig(t)
	w := httptest.NewRecorder()
	if enforceMFAGate(w, gateReq("app."+domain, "/secret", "user@example.com", nil)) {
		t.Fatal("untrusted app-host request passed the gate")
	}

	stashed := false
	for _, c := range w.Result().Cookies() {
		if c.Name == deviceCookieName && c.Value != "" {
			t.Error("gate silently paired a device; want the explicit dance")
		}
		if c.Name == gateOriginCookie && strings.Contains(c.Value, "/secret") {
			stashed = true
		}
	}
	if !stashed {
		t.Error("gate did not stash the /secret origin in _bailey_origin")
	}
}

func TestGateHandoff_TrustedDeviceIsNeverHandedOff(t *testing.T) {
	markServerClaimed(t)
	domain := writeTestConfig(t)
	w := httptest.NewRecorder()
	r := trustedGateReq(t, serverConsoleHost(domain), "/", "trusted@example.com")

	if !enforceMFAGate(w, r) {
		t.Fatalf("trusted device did not pass the gate (status=%d, dest=%q)", w.Code, gateDestination(w))
	}
	if dest := gateDestination(w); dest != "" {
		t.Errorf("trusted device was sent to %q; want no handoff", dest)
	}
}

func TestGateHandoff_LoopBackstopStillStopsTheDance(t *testing.T) {
	markServerClaimed(t)
	domain := writeTestConfig(t)
	r := gateReq(serverConsoleHost(domain), "/", "user@example.com", nil)
	r.AddCookie(&http.Cookie{Name: trustLoopCookie, Value: "3"})
	w := httptest.NewRecorder()

	if enforceMFAGate(w, r) {
		t.Fatal("an exhausted trust dance passed the gate")
	}
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403 once the dance is exhausted", w.Code)
	}
	if dest := gateDestination(w); dest != "" {
		t.Errorf("exhausted dance handed off to %q; want the explanation page", dest)
	}
	if !strings.Contains(w.Body.String(), "Couldn't establish device trust") {
		t.Error("exhausted dance did not render the trust-loop explanation")
	}
}

func TestGateHandoff_SubresourcesAndNonGETsStill401(t *testing.T) {
	markServerClaimed(t)
	domain := writeTestConfig(t)
	for _, r := range []*http.Request{
		func() *http.Request {
			req := gateReq(serverConsoleHost(domain), "/api/data", "user@example.com", nil)
			req.Method = http.MethodPost
			return req
		}(),
		func() *http.Request {
			req := gateReq(serverConsoleHost(domain), "/main.js", "user@example.com", nil)
			req.Header.Set("Accept", "*/*")
			return req
		}(),
	} {
		w := httptest.NewRecorder()
		if enforceMFAGate(w, r) {
			t.Errorf("%s %s passed the gate; want 401", r.Method, r.URL.Path)
		}
		if w.Code != http.StatusUnauthorized {
			t.Errorf("%s %s: status = %d, want 401", r.Method, r.URL.Path, w.Code)
		}
		if dest := gateDestination(w); dest != "" {
			t.Errorf("%s %s handed off to %q; a subresource cannot be navigated", r.Method, r.URL.Path, dest)
		}
	}
}

func TestDeviceCookieStaysStrictAndHostOnly(t *testing.T) {
	w := httptest.NewRecorder()
	r := gateReq(serverConsoleHost(writeTestConfig(t)), "/", "user@example.com", nil)
	r.Header.Set("X-Forwarded-Proto", "https")
	if err := setDeviceCookie(w, r, "user@example.com", "device-1"); err != nil {
		t.Fatal(err)
	}

	var c *http.Cookie
	for _, got := range w.Result().Cookies() {
		if got.Name == deviceCookieName {
			c = got
		}
	}
	if c == nil {
		t.Fatal("no device cookie was set")
	}
	if c.SameSite != http.SameSiteStrictMode {
		t.Errorf("SameSite = %v, want Strict", c.SameSite)
	}
	if c.Domain != "" {
		t.Errorf("Domain = %q, want host-only so one customer's host never receives another's cookie", c.Domain)
	}
	if !c.HttpOnly {
		t.Error("device cookie must be HttpOnly")
	}
	if !c.Secure {
		t.Error("device cookie must be Secure on an https request")
	}
}
