package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// baileyReqBody builds a JSON-bodied request through handleBailey with
// the forwarded identity header set.
func baileyReqBody(method, path, email, body string) *http.Request {
	r := httptest.NewRequest(method, "https://bailey.example.com"+path, strings.NewReader(body))
	r.Host = "bailey.example.com"
	r.Header.Set("Content-Type", "application/json")
	if email != "" {
		r.Header.Set("X-Forwarded-Email", email)
	}
	return r
}

// withTrustedDevice attaches a valid trusted-device cookie for email to r so
// it clears handleBailey's device-trust backstop (every /bailey/api data
// endpoint requires a trusted device). Tests exercising data-endpoint logic
// must look like they came from a trusted browser.
func withTrustedDevice(t *testing.T, r *http.Request, email string) *http.Request {
	t.Helper()
	rec, err := addDevice(email, "test-trusted-device")
	if err != nil {
		t.Fatal(err)
	}
	w0 := httptest.NewRecorder()
	if err := setDeviceCookie(w0, httptest.NewRequest(http.MethodGet, "https://bailey.example.com/", nil), email, rec.ID); err != nil {
		t.Fatal(err)
	}
	for _, c := range w0.Result().Cookies() {
		r.AddCookie(c)
	}
	return r
}

// --- callerOwnsWorkspace (the auth check) -------------------------------

// There is no override. Owning the bailey.<domain> endpoint — the old
// "server owner" qualification, handed out to whoever first signed in to the
// console host — must confer no ownership of anyone's workspace. It used to
// grant trash, restore, update, upgrade and rollback on every workspace on
// the server, which contradicts Bailey's documented model (a role grants
// capabilities, never blanket reach; deliberately no god-mode admin).
func TestCallerOwnsWorkspace_OwningBaileyHostConfersNothing(t *testing.T) {
	domain := writeTestConfig(t)
	baileyHost := "bailey." + domain
	if err := deleteEndpoint(baileyHost); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint(baileyHost, "srvowner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	// A workspace owned by somebody else.
	ws := "notmine"
	if _, err := registerEndpoint(ws+"-dashboard."+domain, "someone@example.com", "", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	if callerOwnsWorkspace("srvowner@example.com", nil, ws) {
		t.Error("the bailey-host owner was treated as owner of someone else's workspace")
	}
	// And a workspace that does not exist at all is owned by nobody.
	if callerOwnsWorkspace("srvowner@example.com", nil, "anyworkspace") {
		t.Error("the bailey-host owner was treated as owner of an unregistered workspace")
	}
	// The real owner is unaffected.
	if !callerOwnsWorkspace("someone@example.com", nil, ws) {
		t.Error("the genuine workspace owner was denied")
	}
}

func TestCallerOwnsWorkspace_DirectGitopsOwner(t *testing.T) {
	domain := writeTestConfig(t)
	ws := "ownedws"
	if _, err := registerEndpoint(ws+"-gitops."+domain, "gitops-owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if !callerOwnsWorkspace("gitops-owner@example.com", nil, ws) {
		t.Error("direct gitops owner not recognised")
	}
	if callerOwnsWorkspace("stranger@example.com", nil, ws) {
		t.Error("stranger recognised as owner")
	}
}

// --- dispatcher validation + authz for per-workspace actions ------------

func TestWorkspaceAction_InvalidNameRejected(t *testing.T) {
	writeTestConfig(t)
	// Path-traversal / malformed name → 400 before any handler runs.
	for _, name := range []string{"..", "Bad_Name", "x", "has space"} {
		r := httptest.NewRequest(http.MethodPost, "https://bailey.example.com/", nil)
		r.Host = "bailey.example.com"
		r.URL.Path = "/bailey/api/workspaces/" + name + "/trash"
		r.Header.Set("X-Forwarded-Email", "u@example.com")
		w := httptest.NewRecorder()
		(&Server{}).handleBailey(w, withTrustedDevice(t, r, "u@example.com"))
		if w.Code != http.StatusBadRequest {
			t.Errorf("trash %q = %d, want 400", name, w.Code)
		}
	}
}

func TestWorkspaceAction_NonOwnerForbidden(t *testing.T) {
	domain := writeTestConfig(t)
	ws := "guardedws"
	// Owned by someone else so the caller is denied.
	if _, err := registerEndpoint(ws+"-gitops."+domain, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"trash", "restore", "update"} {
		w := dispatch(withTrustedDevice(t, baileyReq(http.MethodPost, "/bailey/api/workspaces/"+ws+"/"+action, "intruder@example.com"), "intruder@example.com"))
		if w.Code != http.StatusForbidden {
			t.Errorf("%s by non-owner = %d, want 403; body=%s", action, w.Code, w.Body.String())
		}
	}
}

// End to end at the dispatcher: owning the bailey.<domain> endpoint gets a
// 403 on EVERY write action against a workspace the caller doesn't own. This
// is the through-the-door version of
// TestCallerOwnsWorkspace_OwningBaileyHostConfersNothing — the override used
// to be resolved per handler, so each one needs its own guard against the
// two-line `serverOwner, _ := callerIsServerOwner(...)` idiom creeping back.
func TestWorkspaceAction_BaileyHostOwnerStillForbidden(t *testing.T) {
	domain := writeTestConfig(t)
	baileyHost := "bailey." + domain
	if err := deleteEndpoint(baileyHost); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint(baileyHost, "srvowner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	ws := "godmodews"
	if _, err := registerEndpoint(ws+"-dashboard."+domain, "realowner@example.com", "", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"trash", "restore", "update", "upgrade", "rollback"} {
		r := baileyReq(http.MethodPost, "/bailey/api/workspaces/"+ws+"/"+action, "srvowner@example.com")
		r.Host = baileyHost
		w := dispatch(withTrustedDevice(t, r, "srvowner@example.com"))
		if w.Code != http.StatusForbidden {
			t.Errorf("%s by the bailey-host owner = %d, want 403; body=%s", action, w.Code, w.Body.String())
		}
	}
}

func TestWorkspaceCreate_InvalidNameAndNoDomain(t *testing.T) {
	// Bad JSON body → 400.
	rBad := withTrustedDevice(t, baileyReqBody(http.MethodPost, "/bailey/api/workspaces", "u@example.com", "{not json"), "u@example.com")
	if w := dispatch(rBad); w.Code != http.StatusBadRequest {
		t.Errorf("bad body create = %d, want 400", w.Code)
	}
	// Valid JSON but invalid name → 400.
	writeTestConfig(t)
	rName := withTrustedDevice(t, baileyReqBody(http.MethodPost, "/bailey/api/workspaces", "u@example.com", `{"name":"Bad Name"}`), "u@example.com")
	if w := dispatch(rName); w.Code != http.StatusBadRequest {
		t.Errorf("invalid name create = %d, want 400", w.Code)
	}
}

func TestEmptyTrash_ConfirmationGuard(t *testing.T) {
	writeTestConfig(t)
	// Wrong confirmation → 400, no streaming.
	r := withTrustedDevice(t, baileyReqBody(http.MethodPost, "/bailey/api/workspaces/empty-trash", "u@example.com", `{"confirmation":"nope"}`), "u@example.com")
	if w := dispatch(r); w.Code != http.StatusBadRequest {
		t.Errorf("wrong confirmation = %d, want 400", w.Code)
	}
	// Bad body → 400.
	rBad := withTrustedDevice(t, baileyReqBody(http.MethodPost, "/bailey/api/workspaces/empty-trash", "u@example.com", "{"), "u@example.com")
	if w := dispatch(rBad); w.Code != http.StatusBadRequest {
		t.Errorf("bad body empty-trash = %d, want 400", w.Code)
	}
}

func TestListAccessibleWorkspaces_OKShape(t *testing.T) {
	writeTestConfig(t)
	w := dispatch(withTrustedDevice(t, baileyReq(http.MethodGet, "/bailey/api/workspaces", "lw@example.com"), "lw@example.com"))
	if w.Code != http.StatusOK {
		t.Fatalf("list workspaces = %d; body=%s", w.Code, w.Body.String())
	}
	var resp listAccessibleResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v\n%s", err, w.Body.String())
	}
	if resp.CallerEmail != "lw@example.com" {
		t.Errorf("caller_email = %q", resp.CallerEmail)
	}
}

func TestWorkspaces_MethodGuard(t *testing.T) {
	if w := dispatch(withTrustedDevice(t, baileyReq(http.MethodDelete, "/bailey/api/workspaces", "u@example.com"), "u@example.com")); w.Code != http.StatusMethodNotAllowed {
		t.Errorf("DELETE workspaces = %d, want 405", w.Code)
	}
	if w := dispatch(withTrustedDevice(t, baileyReq(http.MethodGet, "/bailey/api/workspaces/empty-trash", "u@example.com"), "u@example.com")); w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET empty-trash = %d, want 405", w.Code)
	}
}

func TestNameRe(t *testing.T) {
	good := []string{"abc", "a1", "my-workspace", "x9-y"}
	bad := []string{"", "1abc", "Abc", "ab_c", "..", "a b", strings.Repeat("a", 40)}
	for _, g := range good {
		if !nameRe.MatchString(g) {
			t.Errorf("nameRe rejected good name %q", g)
		}
	}
	for _, b := range bad {
		if nameRe.MatchString(b) {
			t.Errorf("nameRe accepted bad name %q", b)
		}
	}
}
