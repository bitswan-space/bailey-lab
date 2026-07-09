package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// shareAPIRequest performs one call against handleShareAPI as the
// given user and returns the recorder. When trusted is set, a paired
// device cookie for email is attached — required for write methods,
// which now demand a trusted device (callerHasTrustedDevice).
func shareAPIRequest(t *testing.T, method, host, email string, form url.Values, trusted bool) *httptest.ResponseRecorder {
	t.Helper()
	var body *strings.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	} else {
		body = strings.NewReader("")
	}
	r := httptest.NewRequest(method, "https://"+host+gatePathPrefix+"/api/share/"+url.PathEscape(host), body)
	r.Host = host
	r.Header.Set("X-Forwarded-Email", email)
	if form != nil {
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if trusted {
		r = withTrustedDevice(t, r, email)
	}
	w := httptest.NewRecorder()
	handleShareAPI(w, r, email, nil)
	return w
}

type shareListing struct {
	Hostname   string          `json:"hostname"`
	OwnerEmail string          `json:"owner_email"`
	Grants     []endpointGrant `json:"grants"`
	Requests   []accessRequest `json:"requests"`
}

func decodeListing(t *testing.T, w *httptest.ResponseRecorder) shareListing {
	t.Helper()
	var l shareListing
	if err := json.Unmarshal(w.Body.Bytes(), &l); err != nil {
		t.Fatalf("decode listing: %v\n%s", err, w.Body.String())
	}
	return l
}

func TestShareAPI_OwnerOnly(t *testing.T) {
	host := "share-ownersonly.example.com"
	if _, err := registerEndpoint(host, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if w := shareAPIRequest(t, http.MethodGet, host, "stranger@example.com", nil, false); w.Code != http.StatusForbidden {
		t.Errorf("non-owner GET status = %d, want 403", w.Code)
	}
	if w := shareAPIRequest(t, http.MethodGet, host, "owner@example.com", nil, false); w.Code != http.StatusOK {
		t.Errorf("owner GET status = %d, want 200", w.Code)
	}
}

func TestShareAPI_UnknownEndpoint(t *testing.T) {
	if w := shareAPIRequest(t, http.MethodGet, "share-nosuch.example.com", "x@example.com", nil, false); w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

func TestShareAPI_GrantRevokeLifecycle(t *testing.T) {
	host := "share-lifecycle.example.com"
	if _, err := registerEndpoint(host, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}

	// Grant access to a friend.
	w := shareAPIRequest(t, http.MethodPost, host, "owner@example.com", url.Values{
		"principal_type":  {"email"},
		"principal_value": {"friend@example.com"},
		"role":            {"access"},
	}, true)
	if w.Code != http.StatusOK {
		t.Fatalf("grant status = %d: %s", w.Code, w.Body.String())
	}
	l := decodeListing(t, w)
	if len(l.Grants) != 1 || l.Grants[0].PrincipalValue != "friend@example.com" {
		t.Fatalf("grants after add: %+v", l.Grants)
	}
	if role, _ := roleFor(host, "friend@example.com", nil); role != roleAccess {
		t.Errorf("grant not effective, role = %q", role)
	}

	// Revoke it.
	w = shareAPIRequest(t, http.MethodDelete, host, "owner@example.com", url.Values{
		"principal_type":  {"email"},
		"principal_value": {"friend@example.com"},
		"role":            {"access"},
	}, true)
	if w.Code != http.StatusOK {
		t.Fatalf("revoke status = %d: %s", w.Code, w.Body.String())
	}
	l = decodeListing(t, w)
	if len(l.Grants) != 0 {
		t.Fatalf("grants after revoke: %+v", l.Grants)
	}
	if role, _ := roleFor(host, "friend@example.com", nil); role != roleNone {
		t.Errorf("revoke not effective, role = %q", role)
	}
}

func TestShareAPI_GrantClearsPendingRequest(t *testing.T) {
	host := "share-clears-request.example.com"
	if _, err := registerEndpoint(host, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := addAccessRequest(host, "wantsin@example.com"); err != nil {
		t.Fatal(err)
	}

	w := shareAPIRequest(t, http.MethodGet, host, "owner@example.com", nil, false)
	if l := decodeListing(t, w); len(l.Requests) != 1 {
		t.Fatalf("pending request not listed: %+v", l.Requests)
	}

	// Approving = granting access to the requester's email; the pending
	// request must disappear in the same response.
	w = shareAPIRequest(t, http.MethodPost, host, "owner@example.com", url.Values{
		"principal_type":  {"email"},
		"principal_value": {"wantsin@example.com"},
		"role":            {"access"},
	}, true)
	l := decodeListing(t, w)
	if len(l.Requests) != 0 {
		t.Errorf("request not cleared by grant: %+v", l.Requests)
	}
	if len(l.Grants) != 1 {
		t.Errorf("grant missing after approve: %+v", l.Grants)
	}
}

func TestShareAPI_DenyRequest(t *testing.T) {
	host := "share-deny.example.com"
	if _, err := registerEndpoint(host, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := addAccessRequest(host, "nope@example.com"); err != nil {
		t.Fatal(err)
	}
	w := shareAPIRequest(t, http.MethodPost, host, "owner@example.com", url.Values{
		"action": {"deny-request"},
		"email":  {"nope@example.com"},
	}, true)
	if w.Code != http.StatusOK {
		t.Fatalf("deny status = %d: %s", w.Code, w.Body.String())
	}
	l := decodeListing(t, w)
	if len(l.Requests) != 0 {
		t.Errorf("request survived deny: %+v", l.Requests)
	}
	if len(l.Grants) != 0 {
		t.Errorf("deny must not grant anything: %+v", l.Grants)
	}
}

// TestShareAPI_WriteRequiresTrustedDevice pins the defense-in-depth rule:
// the owner can READ the ACL from any device, but a WRITE (grant) from an
// untrusted device is refused and leaves the ACL unchanged. The same write
// from a trusted device succeeds. This is the factor that survives a Keycloak
// takeover: owner role comes from the (forgeable) identity headers, so a
// mutation must also prove a paired device.
func TestShareAPI_WriteRequiresTrustedDevice(t *testing.T) {
	host := "share-devicetrust.example.com"
	if _, err := registerEndpoint(host, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	grant := url.Values{
		"principal_type":  {"email"},
		"principal_value": {"intruder@example.com"},
		"role":            {"access"},
	}

	// Read is allowed without a trusted device.
	if w := shareAPIRequest(t, http.MethodGet, host, "owner@example.com", nil, false); w.Code != http.StatusOK {
		t.Fatalf("owner GET (untrusted device) status = %d, want 200", w.Code)
	}

	// Write from an UNTRUSTED device is refused with 403 and must not mutate.
	w := shareAPIRequest(t, http.MethodPost, host, "owner@example.com", grant, false)
	if w.Code != http.StatusForbidden {
		t.Fatalf("owner grant from untrusted device status = %d, want 403", w.Code)
	}
	if role, _ := roleFor(host, "intruder@example.com", nil); role != roleNone {
		t.Fatalf("grant took effect from an untrusted device (role=%q) — device-trust gate bypassed", role)
	}

	// The identical write from a TRUSTED device succeeds.
	w = shareAPIRequest(t, http.MethodPost, host, "owner@example.com", grant, true)
	if w.Code != http.StatusOK {
		t.Fatalf("owner grant from trusted device status = %d: %s", w.Code, w.Body.String())
	}
	if role, _ := roleFor(host, "intruder@example.com", nil); role != roleAccess {
		t.Fatalf("grant from trusted device not effective, role = %q", role)
	}
}

// TestShareEndpoint_FormWriteRequiresTrustedDevice is the same rule for the
// no-JS HTML form handler (handleShareEndpoint).
func TestShareEndpoint_FormWriteRequiresTrustedDevice(t *testing.T) {
	host := "share-form-devicetrust.example.com"
	if _, err := registerEndpoint(host, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	form := url.Values{
		"action":          {"grant"},
		"principal_type":  {"email"},
		"principal_value": {"intruder@example.com"},
		"role":            {"access"},
	}
	post := func(trusted bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "https://"+host+gatePathPrefix+"/share/"+url.PathEscape(host),
			strings.NewReader(form.Encode()))
		r.Host = host
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		if trusted {
			r = withTrustedDevice(t, r, "owner@example.com")
		}
		w := httptest.NewRecorder()
		handleShareEndpoint(w, r, "owner@example.com", nil)
		return w
	}

	if w := post(false); w.Code != http.StatusForbidden {
		t.Fatalf("form grant from untrusted device status = %d, want 403", w.Code)
	}
	if role, _ := roleFor(host, "intruder@example.com", nil); role != roleNone {
		t.Fatalf("form grant took effect from an untrusted device (role=%q)", role)
	}
	if w := post(true); w.Code != http.StatusSeeOther {
		t.Fatalf("form grant from trusted device status = %d, want 303", w.Code)
	}
	if role, _ := roleFor(host, "intruder@example.com", nil); role != roleAccess {
		t.Fatalf("form grant from trusted device not effective, role = %q", role)
	}
}

func TestHandleRequestAccess(t *testing.T) {
	host := "share-reqaccess.example.com"
	if _, err := registerEndpoint(host, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "https://"+host+gatePathPrefix+"/request-access/"+url.PathEscape(host), nil)
	r.Host = host
	w := httptest.NewRecorder()
	handleRequestAccess(w, r, "wantsin@example.com")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	reqs, _ := listAccessRequests(host)
	if len(reqs) != 1 || !strings.EqualFold(reqs[0].Email, "wantsin@example.com") {
		t.Errorf("request not recorded: %+v", reqs)
	}

	// GET is not allowed.
	rGet := httptest.NewRequest(http.MethodGet, "https://"+host+gatePathPrefix+"/request-access/"+url.PathEscape(host), nil)
	rGet.Host = host
	wGet := httptest.NewRecorder()
	handleRequestAccess(wGet, rGet, "wantsin@example.com")
	if wGet.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET status = %d, want 405", wGet.Code)
	}
}

func TestSharePageHTML_EmbedsModal(t *testing.T) {
	host := "share-page.example.com"
	ep, err := registerEndpoint(host, "owner@example.com", "Share Page", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	page := sharePageHTML(ep, "owner@example.com")
	for _, want := range []string{
		"bailey-share-modal",
		gatePathPrefix + "/api/share/" + url.PathEscape(host),
		"__baileyShareOpen",
	} {
		if !strings.Contains(page, want) {
			t.Errorf("share page missing %q", want)
		}
	}
}
