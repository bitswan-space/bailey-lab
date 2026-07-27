package daemon

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

// trustedGateReq builds a request to `host` carrying a valid device cookie for a
// freshly-created device owned by email, so currentDeviceForRequest returns it.
func trustedGateReq(t *testing.T, host, path, email string) *http.Request {
	t.Helper()
	dev, err := addDevice(email, "test device")
	if err != nil {
		t.Fatal(err)
	}
	cookie, err := signedDeviceCookie(email, dev.ID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	r := gateReq(host, path, email, nil)
	r.AddCookie(&http.Cookie{Name: deviceCookieName, Value: cookie})
	return r
}

func setCookieValue(w *httptest.ResponseRecorder, name string) string {
	for _, c := range w.Result().Cookies() {
		if c.Name == name {
			return c.Value
		}
	}
	return ""
}

func TestGrantStore(t *testing.T) {
	gs := &grantStore{outstanding: map[string]time.Time{}}
	gs.register("n1", time.Now().Add(time.Minute))
	if !gs.consume("n1") {
		t.Fatal("a fresh nonce should consume as true")
	}
	if gs.consume("n1") {
		t.Fatal("a nonce must be single-use (second consume false)")
	}
	if gs.consume("never-registered") {
		t.Fatal("an unknown nonce must be false")
	}
	gs.register("n2", time.Now().Add(-time.Second)) // already expired
	if gs.consume("n2") {
		t.Fatal("an expired nonce must be false")
	}
	// register() evicts already-lapsed entries so the map can't grow unbounded.
	gs2 := &grantStore{outstanding: map[string]time.Time{}}
	gs2.outstanding["stale"] = time.Now().Add(-time.Minute)
	gs2.register("fresh", time.Now().Add(time.Minute))
	if _, present := gs2.outstanding["stale"]; present {
		t.Fatal("register should evict expired nonces")
	}
}

func TestMintVerifyGrant(t *testing.T) {
	writeTestConfig(t)
	tok, err := mintGrant("u@example.com", "app.test.example.com", "devidABC")
	if err != nil {
		t.Fatal(err)
	}
	g, ok := verifyGrant(tok)
	if !ok {
		t.Fatal("a freshly minted grant should verify")
	}
	if g.email != "u@example.com" || g.host != "app.test.example.com" || g.deviceID != "devidABC" {
		t.Fatalf("grant fields = %+v", g)
	}
	if !deviceGrants.consume(g.nonce) {
		t.Fatal("a minted nonce should be outstanding (single-use registered)")
	}
	// Tamper: appending to the signature field breaks the HMAC.
	if _, ok := verifyGrant(tok + "z"); ok {
		t.Fatal("a tampered grant must not verify")
	}
}

func TestVerifyGrant_BadFormatAndExpiry(t *testing.T) {
	writeTestConfig(t)
	if _, ok := verifyGrant("too.few.parts.here"); ok {
		t.Fatal("wrong field count must fail")
	}
	if _, ok := verifyGrant("a.b.c.d.e.f"); ok {
		t.Fatal("a bad MAC must fail")
	}
	// Correctly signed but older than grantTTL.
	key, err := signingKey()
	if err != nil {
		t.Fatal(err)
	}
	body := grantBody("u@example.com", "app.test.example.com", "dev1", time.Now().Add(-3*time.Minute).Unix(), "abcd")
	tok := body + "." + grantMAC(key, body)
	if _, ok := verifyGrant(tok); ok {
		t.Fatal("an expired grant must fail")
	}
	// A correctly-MAC'd token whose email field isn't valid base64 must be
	// rejected at the decode step (not just the signature check).
	badBody := "!!!not-b64.YXBw.dev1." + itoa(time.Now().Unix()) + ".abcd"
	badTok := badBody + "." + grantMAC(key, badBody)
	if _, ok := verifyGrant(badTok); ok {
		t.Fatal("a grant with an undecodable field must fail")
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func TestTrustDanceExhausted(t *testing.T) {
	count := ""
	for i := 0; i < maxTrustDanceRounds; i++ {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "https://app.example.com/", nil)
		if count != "" {
			r.AddCookie(&http.Cookie{Name: trustLoopCookie, Value: count})
		}
		if trustDanceExhausted(w, r) {
			t.Fatalf("exhausted too early at round %d", i)
		}
		count = setCookieValue(w, trustLoopCookie)
	}
	// The counter is now at the cap → the next round is refused.
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "https://app.example.com/", nil)
	r.AddCookie(&http.Cookie{Name: trustLoopCookie, Value: count})
	if !trustDanceExhausted(w, r) {
		t.Fatal("expected exhausted once the counter reached maxTrustDanceRounds")
	}
}

func TestOriginHostFromRequest(t *testing.T) {
	domain := writeTestConfig(t)
	r := httptest.NewRequest(http.MethodGet, "https://"+serverConsoleOnboardHost(domain)+"/bailey/api/device-grant", nil)
	r.AddCookie(&http.Cookie{Name: gateOriginCookie, Value: "https://app." + domain + "/secret"})
	if h := originHostFromRequest(r); h != "app."+domain {
		t.Fatalf("host = %q, want app.%s", h, domain)
	}
	r2 := httptest.NewRequest(http.MethodGet, "https://"+serverConsoleOnboardHost(domain)+"/x", nil)
	if h := originHostFromRequest(r2); h != "" {
		t.Fatalf("host = %q, want empty (no origin cookie)", h)
	}
	// A bare-path origin (no scheme://host) carries no host to trust.
	r3 := httptest.NewRequest(http.MethodGet, "https://"+serverConsoleOnboardHost(domain)+"/x", nil)
	r3.AddCookie(&http.Cookie{Name: gateOriginCookie, Value: "/just/a/path"})
	if h := originHostFromRequest(r3); h != "" {
		t.Fatalf("host = %q, want empty for a bare-path origin", h)
	}
}

func TestOnboardHelperURLs(t *testing.T) {
	domain := writeTestConfig(t)
	if got, want := onboardSPARoot(), "https://"+serverConsoleOnboardHost(domain)+"/"; got != want {
		t.Fatalf("onboardSPARoot = %q, want %q", got, want)
	}
	if got, want := onboardDeviceGrantURL(), "https://"+serverConsoleOnboardHost(domain)+"/bailey/api/device-grant"; got != want {
		t.Fatalf("onboardDeviceGrantURL = %q, want %q", got, want)
	}
}

func TestOnboardHelperURLs_NoDomain(t *testing.T) {
	// With no protected domain configured, both fall back to "/".
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	if got := onboardSPARoot(); got != "/" {
		t.Fatalf("onboardSPARoot no-domain = %q, want /", got)
	}
	if got := onboardDeviceGrantURL(); got != "/" {
		t.Fatalf("onboardDeviceGrantURL no-domain = %q, want /", got)
	}
}

func TestHandleDeviceGrant_Trusted(t *testing.T) {
	domain := writeTestConfig(t)
	email := "grantme@example.com"
	r := trustedGateReq(t, serverConsoleOnboardHost(domain), "/bailey/api/device-grant", email)
	r.AddCookie(&http.Cookie{Name: gateOriginCookie, Value: "https://app." + domain + "/secret"})
	w := httptest.NewRecorder()
	(&Server{}).handleDeviceGrant(w, r, email)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("code = %d, want 303", w.Code)
	}
	loc := w.Header().Get("Location")
	if !strings.HasPrefix(loc, "https://app."+domain+"/bailey/api/device-claim?grant=") {
		t.Fatalf("Location = %q, want a device-claim on the origin host with a grant", loc)
	}
}

func TestHandleDeviceGrant_Untrusted(t *testing.T) {
	domain := writeTestConfig(t)
	email := "notrust@example.com"
	r := gateReq(serverConsoleOnboardHost(domain), "/bailey/api/device-grant", email, nil)
	r.AddCookie(&http.Cookie{Name: gateOriginCookie, Value: "https://app." + domain + "/x"})
	w := httptest.NewRecorder()
	(&Server{}).handleDeviceGrant(w, r, email)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("code = %d, want 303", w.Code)
	}
	if loc := w.Header().Get("Location"); loc != onboardSPARoot() {
		t.Fatalf("Location = %q, want the onboarding SPA root for pairing", loc)
	}
}

func TestHandleDeviceGrant_NoOrigin(t *testing.T) {
	domain := writeTestConfig(t)
	email := "noorigin@example.com"
	r := trustedGateReq(t, serverConsoleOnboardHost(domain), "/bailey/api/device-grant", email)
	w := httptest.NewRecorder()
	(&Server{}).handleDeviceGrant(w, r, email)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("code = %d, want 303", w.Code)
	}
	if loc := w.Header().Get("Location"); !strings.Contains(loc, serverConsoleHost(domain)) {
		t.Fatalf("Location = %q, want the console-root fallback", loc)
	}
}

func TestHandleDeviceClaim_Success(t *testing.T) {
	domain := writeTestConfig(t)
	email := "claim@example.com"
	host := "app." + domain
	dev, err := addDevice(email, "dev")
	if err != nil {
		t.Fatal(err)
	}
	grant, err := mintGrant(email, host, dev.ID)
	if err != nil {
		t.Fatal(err)
	}
	r := gateReq(host, "/bailey/api/device-claim?grant="+url.QueryEscape(grant), email, nil)
	r.AddCookie(&http.Cookie{Name: gateOriginCookie, Value: "https://" + host + "/secret"})
	w := httptest.NewRecorder()
	(&Server{}).handleDeviceClaim(w, r, email)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("code = %d, want 303", w.Code)
	}
	var ok bool
	for _, c := range w.Result().Cookies() {
		if c.Name == deviceCookieName && c.Value != "" && c.Domain == "" && c.SameSite == http.SameSiteStrictMode {
			ok = true
		}
	}
	if !ok {
		t.Fatal("claim did not set a host-only, Strict device cookie")
	}
	if loc := w.Header().Get("Location"); !strings.Contains(loc, "/secret") {
		t.Fatalf("Location = %q, want the stashed origin path", loc)
	}
}

func TestHandleDeviceClaim_InvalidGrant(t *testing.T) {
	domain := writeTestConfig(t)
	email := "bad@example.com"
	r := gateReq("app."+domain, "/bailey/api/device-claim?grant=not-a-grant", email, nil)
	w := httptest.NewRecorder()
	(&Server{}).handleDeviceClaim(w, r, email)
	if w.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403", w.Code)
	}
}

func TestHandleDeviceClaim_HostMismatch(t *testing.T) {
	domain := writeTestConfig(t)
	email := "mismatch@example.com"
	dev, _ := addDevice(email, "dev")
	grant, _ := mintGrant(email, "other."+domain, dev.ID) // grant bound to a DIFFERENT host
	r := gateReq("app."+domain, "/bailey/api/device-claim?grant="+url.QueryEscape(grant), email, nil)
	w := httptest.NewRecorder()
	(&Server{}).handleDeviceClaim(w, r, email)
	if w.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403 (grant host != request host)", w.Code)
	}
}

func TestHandleDeviceClaim_ReusedGrant(t *testing.T) {
	domain := writeTestConfig(t)
	email := "reuse@example.com"
	host := "app." + domain
	dev, _ := addDevice(email, "dev")
	grant, _ := mintGrant(email, host, dev.ID)
	r1 := gateReq(host, "/bailey/api/device-claim?grant="+url.QueryEscape(grant), email, nil)
	r1.AddCookie(&http.Cookie{Name: gateOriginCookie, Value: "https://" + host + "/"})
	(&Server{}).handleDeviceClaim(httptest.NewRecorder(), r1, email) // consumes it
	r2 := gateReq(host, "/bailey/api/device-claim?grant="+url.QueryEscape(grant), email, nil)
	w2 := httptest.NewRecorder()
	(&Server{}).handleDeviceClaim(w2, r2, email)
	if w2.Code != http.StatusForbidden {
		t.Fatalf("reused grant code = %d, want 403 (single-use)", w2.Code)
	}
}

func TestHandleDeviceClaim_AlreadyTrusted(t *testing.T) {
	domain := writeTestConfig(t)
	email := "already@example.com"
	host := "app." + domain
	r := trustedGateReq(t, host, "/bailey/api/device-claim?grant=whatever", email)
	r.AddCookie(&http.Cookie{Name: gateOriginCookie, Value: "https://" + host + "/home"})
	w := httptest.NewRecorder()
	(&Server{}).handleDeviceClaim(w, r, email)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("code = %d, want 303 (idempotent when already trusted)", w.Code)
	}
}

func TestDeviceHandlers_NoIdentity(t *testing.T) {
	wg := httptest.NewRecorder()
	(&Server{}).handleDeviceGrant(wg, httptest.NewRequest(http.MethodGet, "https://x/", nil), "")
	if wg.Code != http.StatusUnauthorized {
		t.Fatalf("device-grant no-identity code = %d, want 401", wg.Code)
	}
	wc := httptest.NewRecorder()
	(&Server{}).handleDeviceClaim(wc, httptest.NewRequest(http.MethodGet, "https://x/", nil), "")
	if wc.Code != http.StatusUnauthorized {
		t.Fatalf("device-claim no-identity code = %d, want 401", wc.Code)
	}
}

func TestWriteTrustLoopError(t *testing.T) {
	w := httptest.NewRecorder()
	writeTrustLoopError(w)
	if w.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403", w.Code)
	}
	if !strings.Contains(strings.ToLower(w.Body.String()), "device trust") {
		t.Fatal("error body missing the device-trust explanation")
	}
}
