package daemon

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
)

// --- bailey_gate_api.go self-trust success via form (decodeGateBody) ----

func TestGateSelfTrust_FormCodeFallbackSuccess(t *testing.T) {
	markServerClaimed(t)
	email := "selftrustformok@example.com"
	secret := enrolTOTP(t, email)
	code, _ := totp.GenerateCode(secret, time.Now())
	// Send the authenticator code as form field "code" (not "totp"): the
	// decodeGateBody form branch maps code→TOTP when TOTP is empty.
	r := httptest.NewRequest(http.MethodPost, "https://bailey.example.com/bailey/api/self-trust",
		strings.NewReader("code="+code))
	r.Host = "bailey.example.com"
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.Header.Set("X-Forwarded-Email", email)
	w := httptest.NewRecorder()
	(&Server{}).handleBailey(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("self-trust form success = %d; body=%s", w.Code, w.Body.String())
	}
	var sawDevice bool
	for _, c := range w.Result().Cookies() {
		if c.Name == deviceCookieName && c.Value != "" {
			sawDevice = true
		}
	}
	if !sawDevice {
		t.Error("self-trust form success did not set a device cookie")
	}
}

// --- mfa_gate.go query-string branches ---------------------------------

func TestRememberOrigin_WithQuery(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "https://app.example.com/deep/link?x=y", nil)
	w := httptest.NewRecorder()
	rememberOrigin(w, r)
	var found bool
	for _, c := range w.Result().Cookies() {
		if c.Name == gateOriginCookie && strings.Contains(c.Value, "?x=y") {
			found = true
		}
	}
	if !found {
		t.Error("rememberOrigin did not stash the path+query")
	}
}

// --- mfa_devices.go setDeviceCookie domain attribute -------------------

func TestSetDeviceCookie_HostOnlyStrict(t *testing.T) {
	domain := writeTestConfig(t)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "https://bailey."+domain+"/", nil)
	if err := setDeviceCookie(w, r, "dom@example.com", "devid123"); err != nil {
		t.Fatal(err)
	}
	var dev *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == deviceCookieName {
			dev = c
		}
	}
	if dev == nil {
		t.Fatal("no device cookie")
	}
	// Host-only: NO Domain attribute, so the credential is scoped to exactly the
	// host that set it — never shared with sibling workspace/BP subdomains.
	if dev.Domain != "" {
		t.Errorf("cookie domain = %q, want host-only (no Domain)", dev.Domain)
	}
	if dev.SameSite != http.SameSiteStrictMode {
		t.Errorf("cookie SameSite = %v, want Strict", dev.SameSite)
	}
}

// --- acl_endpoints_page.go access-role grants --------------------------

func TestBuildEndpointListing_AccessRoleEntry(t *testing.T) {
	writeTestConfig(t)
	host := "access-listing.example.com"
	if _, err := registerEndpoint(host, "ep-owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	// Grant a teammate plain access — their listing entry has role "access"
	// and (per the code) no grants slice.
	if err := addGrant(host, "email", "member@example.com", string(roleAccess), "ep-owner@example.com"); err != nil {
		t.Fatal(err)
	}
	listing, err := buildEndpointListing("member@example.com", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	var entry *endpointListEntry
	for i := range listing.Endpoints {
		if strings.EqualFold(listing.Endpoints[i].Hostname, host) {
			entry = &listing.Endpoints[i]
		}
	}
	if entry == nil {
		t.Fatalf("access-role endpoint not listed")
	}
	if entry.CallerRole != "access" {
		t.Errorf("caller role = %q, want access", entry.CallerRole)
	}
	if len(entry.Grants) != 0 {
		t.Error("access-role view should not include grants")
	}
}
