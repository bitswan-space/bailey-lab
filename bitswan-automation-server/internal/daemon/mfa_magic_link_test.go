package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestMagicLinkStore_CreateLookupRevoke(t *testing.T) {
	writeTestConfig(t)
	host := "demo1.test.example.com"
	if _, err := registerEndpoint(host, "o@example.com", "", "", "frontend", "production"); err != nil {
		t.Fatal(err)
	}
	token, m, err := dbCreateMagicLink(host, "o@example.com", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	got, err := dbMagicLinkByTokenHash(hashMagicToken(token))
	if err != nil || got == nil {
		t.Fatalf("lookup by token failed: %v", err)
	}
	if got.EndpointHost != host || !got.live(time.Now().UTC()) {
		t.Fatalf("link wrong/host not live: %+v", got)
	}
	// A wrong token doesn't resolve.
	if bad, _ := dbMagicLinkByTokenHash(hashMagicToken("nope")); bad != nil {
		t.Error("a bad token resolved to a link")
	}
	// Revoke ends it.
	changed, err := dbRevokeMagicLink(m.ID, host)
	if err != nil || !changed {
		t.Fatalf("revoke failed: changed=%v err=%v", changed, err)
	}
	if after, _ := dbMagicLinkByTokenHash(hashMagicToken(token)); after != nil && after.live(time.Now().UTC()) {
		t.Error("link still live after revoke")
	}
}

func TestEndpointDeviceTrust_ScopedToHost(t *testing.T) {
	writeTestConfig(t)
	host := "demo2.test.example.com"
	if _, err := registerEndpoint(host, "o@example.com", "", "", "frontend", "production"); err != nil {
		t.Fatal(err)
	}
	if endpointDeviceTrusted("devX", host) {
		t.Fatal("device trusted before any grant")
	}
	if err := dbAddEndpointDeviceTrust("devX", host, "u@example.com"); err != nil {
		t.Fatal(err)
	}
	if !endpointDeviceTrusted("devX", host) {
		t.Fatal("device not trusted after grant")
	}
	if endpointDeviceTrusted("devX", "other.test.example.com") {
		t.Fatal("scoped trust leaked to a different endpoint")
	}
}

func TestCanMintMagicLink_Rules(t *testing.T) {
	domain := writeTestConfig(t)
	owner := "owner@example.com"
	host := "mint." + domain
	if _, err := registerEndpoint(host, owner, "", "", "frontend", "production"); err != nil {
		t.Fatal(err)
	}
	if err := dbSetUserRole(owner, "admin", "test"); err != nil {
		t.Fatal(err)
	}
	// owner + admin + production → allowed.
	if ok, reason := canMintMagicLink(owner, nil, host); !ok {
		t.Fatalf("owner+admin+production denied: %s", reason)
	}
	// admin but NOT owner → denied.
	if err := dbSetUserRole("bob@example.com", "admin", "test"); err != nil {
		t.Fatal(err)
	}
	if ok, _ := canMintMagicLink("bob@example.com", nil, host); ok {
		t.Error("a non-owner admin was allowed to mint")
	}
	// owner but NOT admin/auditor → denied.
	if _, err := registerEndpoint("plain."+domain, "plain@example.com", "", "", "frontend", "production"); err != nil {
		t.Fatal(err)
	}
	if ok, _ := canMintMagicLink("plain@example.com", nil, "plain."+domain); ok {
		t.Error("a non-admin owner was allowed to mint")
	}
	// owner + admin but STAGING (not production) → denied.
	if _, err := registerEndpoint("stg."+domain, owner, "", "", "frontend", "staging"); err != nil {
		t.Fatal(err)
	}
	if ok := func() bool { ok, _ := canMintMagicLink(owner, nil, "stg."+domain); return ok }(); ok {
		t.Error("a staging endpoint was allowed to mint")
	}
}

func TestHandleMagicLink_CreateThenRedeem(t *testing.T) {
	domain := writeTestConfig(t)
	owner := "owner@example.com"
	host := "flow." + domain
	if _, err := registerEndpoint(host, owner, "", "", "frontend", "production"); err != nil {
		t.Fatal(err)
	}
	if err := dbSetUserRole(owner, "admin", "test"); err != nil {
		t.Fatal(err)
	}

	// CREATE
	rc := gateReq(host, magicLinkCreatePath, owner, nil)
	rc.Method = http.MethodPost
	wc := httptest.NewRecorder()
	handleMagicLinkCreate(wc, rc, owner, nil)
	if wc.Code != http.StatusOK {
		t.Fatalf("create code=%d body=%s", wc.Code, wc.Body.String())
	}
	var created struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(wc.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	i := strings.Index(created.URL, "token=")
	if i < 0 || !strings.Contains(created.URL, host+magicLinkRedeemPath) {
		t.Fatalf("create URL malformed: %q", created.URL)
	}
	token, _ := url.QueryUnescape(created.URL[i+len("token="):])

	// REDEEM as a DIFFERENT user with no device cookie.
	redeemer := "guest@example.com"
	rr := gateReq(host, magicLinkRedeemPath+"?token="+url.QueryEscape(token), redeemer, nil)
	wr := httptest.NewRecorder()
	handleMagicLinkRedeem(wr, rr, redeemer)
	if wr.Code != http.StatusSeeOther {
		t.Fatalf("redeem code=%d body=%s", wr.Code, wr.Body.String())
	}
	if loc := wr.Header().Get("Location"); loc != "https://"+host+"/" {
		t.Fatalf("redeem redirect = %q, want the endpoint", loc)
	}
	var devCookie string
	for _, c := range wr.Result().Cookies() {
		if c.Name == deviceCookieName {
			devCookie = c.Value
		}
	}
	if devCookie == "" {
		t.Fatal("redeem did not set a device cookie")
	}
	id, ok := verifyDeviceCookie(redeemer, devCookie)
	if !ok {
		t.Fatal("redeem device cookie doesn't verify")
	}
	if !endpointDeviceTrusted(id, host) {
		t.Fatal("redeem did not record endpoint-scoped trust")
	}
	// Endpoint-scoped, NOT full trust: the device must not be in the devices table.
	if rec, _ := findDevice(redeemer, id); rec != nil {
		t.Error("redeem added a FULL-trust device row (should be endpoint-scoped only)")
	}
}

func TestHandleMagicLink_RedeemInvalidToken(t *testing.T) {
	domain := writeTestConfig(t)
	host := "bad." + domain
	if _, err := registerEndpoint(host, "o@example.com", "", "", "frontend", "production"); err != nil {
		t.Fatal(err)
	}
	rr := gateReq(host, magicLinkRedeemPath+"?token=not-a-real-token", "guest@example.com", nil)
	wr := httptest.NewRecorder()
	handleMagicLinkRedeem(wr, rr, "guest@example.com")
	if wr.Code != http.StatusForbidden {
		t.Fatalf("invalid-token redeem code=%d, want 403", wr.Code)
	}
}

func TestHandleMagicLink_ListAndRevoke(t *testing.T) {
	domain := writeTestConfig(t)
	owner := "owner2@example.com"
	host := "lr." + domain
	if _, err := registerEndpoint(host, owner, "", "", "frontend", "production"); err != nil {
		t.Fatal(err)
	}
	if err := dbSetUserRole(owner, "admin", "test"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := dbCreateMagicLink(host, owner, time.Hour); err != nil {
		t.Fatal(err)
	}
	_, m2, err := dbCreateMagicLink(host, owner, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	// LIST (owner) → 2 links.
	wl := httptest.NewRecorder()
	handleMagicLinkList(wl, gateReq(host, magicLinkListPath, owner, nil), owner, nil)
	if wl.Code != http.StatusOK {
		t.Fatalf("list code=%d body=%s", wl.Code, wl.Body.String())
	}
	var listed struct {
		Links []map[string]any `json:"links"`
	}
	_ = json.Unmarshal(wl.Body.Bytes(), &listed)
	if len(listed.Links) != 2 {
		t.Fatalf("listed %d links, want 2", len(listed.Links))
	}

	// LIST as a non-owner → 403.
	wl2 := httptest.NewRecorder()
	handleMagicLinkList(wl2, gateReq(host, magicLinkListPath, "stranger@example.com", nil), "stranger@example.com", nil)
	if wl2.Code != http.StatusForbidden {
		t.Errorf("non-owner list code=%d, want 403", wl2.Code)
	}

	// REVOKE the second link.
	rr := httptest.NewRequest(http.MethodPost, "https://"+host+magicLinkRevokePath, strings.NewReader(`{"id":"`+m2.ID+`"}`))
	rr.Host = host
	rr.Header.Set("X-Forwarded-Email", owner)
	wr := httptest.NewRecorder()
	handleMagicLinkRevoke(wr, rr, owner, nil)
	if wr.Code != http.StatusOK {
		t.Fatalf("revoke code=%d body=%s", wr.Code, wr.Body.String())
	}
	if links, _ := dbListMagicLinks(host); len(links) != 1 {
		t.Fatalf("after revoke %d live links, want 1", len(links))
	}
}

func TestHandleMagicLink_CreateDeniedForNonAdminOwner(t *testing.T) {
	domain := writeTestConfig(t)
	host := "deny." + domain
	if _, err := registerEndpoint(host, "plain@example.com", "", "", "frontend", "production"); err != nil {
		t.Fatal(err)
	}
	rc := gateReq(host, magicLinkCreatePath, "plain@example.com", nil)
	rc.Method = http.MethodPost
	wc := httptest.NewRecorder()
	handleMagicLinkCreate(wc, rc, "plain@example.com", nil)
	if wc.Code != http.StatusForbidden {
		t.Fatalf("non-admin owner create code=%d, want 403", wc.Code)
	}
	// No identity → 401.
	wn := httptest.NewRecorder()
	handleMagicLinkCreate(wn, gateReq(host, magicLinkCreatePath, "", nil), "", nil)
	if wn.Code != http.StatusUnauthorized {
		t.Errorf("no-identity create code=%d, want 401", wn.Code)
	}
}

func TestHandleMagicLink_RedeemWrongHostRedirects(t *testing.T) {
	domain := writeTestConfig(t)
	host := "wh." + domain
	if _, err := registerEndpoint(host, "o@example.com", "", "", "frontend", "production"); err != nil {
		t.Fatal(err)
	}
	token, _, err := dbCreateMagicLink(host, "o@example.com", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	// Redeem on a DIFFERENT host → bounce to the link's real endpoint host.
	rr := gateReq("elsewhere."+domain, magicLinkRedeemPath+"?token="+url.QueryEscape(token), "guest@example.com", nil)
	wr := httptest.NewRecorder()
	handleMagicLinkRedeem(wr, rr, "guest@example.com")
	if wr.Code != http.StatusSeeOther {
		t.Fatalf("wrong-host redeem code=%d, want 303", wr.Code)
	}
	if loc := wr.Header().Get("Location"); !strings.Contains(loc, host+magicLinkRedeemPath) {
		t.Errorf("wrong-host redeem didn't bounce to the endpoint host: %q", loc)
	}
}

func TestHandleMagicLink_RedeemReusesExistingDevice(t *testing.T) {
	domain := writeTestConfig(t)
	host := "reuse." + domain
	if _, err := registerEndpoint(host, "o@example.com", "", "", "frontend", "production"); err != nil {
		t.Fatal(err)
	}
	token, _, err := dbCreateMagicLink(host, "o@example.com", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	email := "guest@example.com"
	existing, err := newDeviceID()
	if err != nil {
		t.Fatal(err)
	}
	cookieVal, err := signedDeviceCookie(email, existing, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	rr := gateReq(host, magicLinkRedeemPath+"?token="+url.QueryEscape(token), email, nil)
	rr.AddCookie(&http.Cookie{Name: deviceCookieName, Value: cookieVal})
	wr := httptest.NewRecorder()
	handleMagicLinkRedeem(wr, rr, email)
	if wr.Code != http.StatusSeeOther {
		t.Fatalf("redeem-reuse code=%d", wr.Code)
	}
	// Scoped trust must be recorded under the EXISTING device id...
	if !endpointDeviceTrusted(existing, host) {
		t.Fatal("redeem did not reuse the existing device identity")
	}
	// ...and no new device cookie should be set.
	for _, c := range wr.Result().Cookies() {
		if c.Name == deviceCookieName {
			t.Error("redeem minted a new device instead of reusing the existing one")
		}
	}
}

func TestHandleMagicLink_RedeemGuards(t *testing.T) {
	domain := writeTestConfig(t)
	host := "g." + domain
	if _, err := registerEndpoint(host, "o@example.com", "", "", "frontend", "production"); err != nil {
		t.Fatal(err)
	}
	// No identity → 401.
	w1 := httptest.NewRecorder()
	handleMagicLinkRedeem(w1, gateReq(host, magicLinkRedeemPath, "", nil), "")
	if w1.Code != http.StatusUnauthorized {
		t.Errorf("no-identity redeem code=%d, want 401", w1.Code)
	}
	// Missing token → 400.
	w2 := httptest.NewRecorder()
	handleMagicLinkRedeem(w2, gateReq(host, magicLinkRedeemPath, "u@example.com", nil), "u@example.com")
	if w2.Code != http.StatusBadRequest {
		t.Errorf("no-token redeem code=%d, want 400", w2.Code)
	}
}

func TestGate_ScopedTrustPassesOnlyItsEndpoint(t *testing.T) {
	markServerClaimed(t)
	domain := writeTestConfig(t)
	host := "scoped." + domain
	if _, err := registerEndpoint(host, "o@example.com", "", "", "frontend", "production"); err != nil {
		t.Fatal(err)
	}
	email := "guest@example.com"
	id, err := newDeviceID()
	if err != nil {
		t.Fatal(err)
	}
	if err := dbAddEndpointDeviceTrust(id, host, email); err != nil {
		t.Fatal(err)
	}
	cookieVal, err := signedDeviceCookie(email, id, time.Now())
	if err != nil {
		t.Fatal(err)
	}

	// Scoped device on ITS endpoint → passes the device-trust gate.
	r := gateReq(host, "/", email, nil)
	r.AddCookie(&http.Cookie{Name: deviceCookieName, Value: cookieVal})
	w := httptest.NewRecorder()
	if !enforceMFAGate(w, r) {
		t.Fatalf("scoped device blocked on its own endpoint (code=%d loc=%q)", w.Code, w.Header().Get("Location"))
	}

	// Same device on a DIFFERENT endpoint → blocked (trust must not leak).
	r2 := gateReq("other."+domain, "/", email, nil)
	r2.AddCookie(&http.Cookie{Name: deviceCookieName, Value: cookieVal})
	w2 := httptest.NewRecorder()
	if enforceMFAGate(w2, r2) {
		t.Fatal("scoped device passed on a DIFFERENT endpoint — trust leaked")
	}
}
