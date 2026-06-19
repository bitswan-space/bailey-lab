package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newRecorder() *httptest.ResponseRecorder { return httptest.NewRecorder() }

func TestAdminDefaultImages_NonAdminForbidden(t *testing.T) {
	if w := dispatch(baileyReq(http.MethodGet, "/bailey/api/admin/default-images", "user@example.com")); w.Code != http.StatusForbidden {
		t.Errorf("GET non-admin = %d, want 403", w.Code)
	}
	if w := dispatch(baileyReqBody(http.MethodPost, "/bailey/api/admin/default-images", "user@example.com", "{}")); w.Code != http.StatusForbidden {
		t.Errorf("POST non-admin = %d, want 403", w.Code)
	}
}

func TestAdminDefaultImages_GetReturnsBothKeys(t *testing.T) {
	// Seed a configured override for gitops so the Configured branch runs.
	if err := dbSetSetting(settingDefaultGitopsImage, "bitswan/gitops:custom", "admin@example.com"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbDeleteSetting(settingDefaultGitopsImage) })

	w := dispatchSrv(baileyReq(http.MethodGet, "/bailey/api/admin/default-images", "boss@example.com", adminGrp))
	if w.Code != http.StatusOK {
		t.Fatalf("GET status = %d; body=%s", w.Code, w.Body.String())
	}
	var out map[string]imageSettingResponse
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v\n%s", err, w.Body.String())
	}
	gitops, ok := out[settingDefaultGitopsImage]
	if !ok {
		t.Fatal("gitops key missing from response")
	}
	if gitops.Configured == nil || gitops.Configured.Value != "bitswan/gitops:custom" {
		t.Errorf("configured gitops = %+v", gitops.Configured)
	}
	if gitops.Effective != "bitswan/gitops:custom" {
		t.Errorf("effective = %q, want the override", gitops.Effective)
	}
	if _, ok := out[settingDefaultDashboardImage]; !ok {
		t.Error("dashboard key missing from response")
	}
}

func TestAdminDefaultImages_PostSetAndClear_DirectHandler(t *testing.T) {
	_ = dbDeleteSetting(settingDefaultGitopsImage)
	srv := &Server{}

	// Set.
	r := baileyReqBody(http.MethodPost, "/bailey/api/admin/default-images", "admin@example.com",
		`{"gitops_image":"bitswan/gitops:v9"}`)
	w := newRecorder()
	srv.handleAdminDefaultImagesPost(w, r, "admin@example.com")
	if w.Code != http.StatusOK {
		t.Fatalf("set status = %d; body=%s", w.Code, w.Body.String())
	}
	if v, _ := dbGetSetting(settingDefaultGitopsImage); v != "bitswan/gitops:v9" {
		t.Errorf("setting not written: %q", v)
	}

	// Clear with empty string.
	r2 := baileyReqBody(http.MethodPost, "/bailey/api/admin/default-images", "admin@example.com",
		`{"gitops_image":""}`)
	w2 := newRecorder()
	srv.handleAdminDefaultImagesPost(w2, r2, "admin@example.com")
	if w2.Code != http.StatusOK {
		t.Fatalf("clear status = %d", w2.Code)
	}
	if v, _ := dbGetSetting(settingDefaultGitopsImage); v != "" {
		t.Errorf("setting not cleared: %q", v)
	}

	// Bad body → 400.
	rBad := baileyReqBody(http.MethodPost, "/bailey/api/admin/default-images", "admin@example.com", "{")
	wBad := newRecorder()
	srv.handleAdminDefaultImagesPost(wBad, rBad, "admin@example.com")
	if wBad.Code != http.StatusBadRequest {
		t.Errorf("bad body = %d, want 400", wBad.Code)
	}
}

func TestImageKindToRepoMapping(t *testing.T) {
	if imageKindToRepo[settingDefaultGitopsImage] != "bitswan/gitops" {
		t.Error("gitops repo mapping wrong")
	}
	if imageKindToRepo[settingDefaultDashboardImage] != "bitswan/workspace-dashboard" {
		t.Error("dashboard repo mapping wrong")
	}
}

func TestUpdateWorkspace_ValidationAndAuthz(t *testing.T) {
	domain := writeTestConfig(t)
	srv := &Server{}

	// Invalid name → 400 (direct handler call).
	wBad := newRecorder()
	srv.handleUpdateWorkspace(wBad, baileyReq(http.MethodPost, "/x", "u@example.com"), "u@example.com", "Bad Name")
	if wBad.Code != http.StatusBadRequest {
		t.Errorf("invalid name = %d, want 400", wBad.Code)
	}

	// Non-owner → 403.
	ws := "updws"
	if _, err := registerEndpoint(ws+"-gitops."+domain, "real@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	wForbid := newRecorder()
	r := baileyReq(http.MethodPost, "/x", "intruder@example.com")
	srv.handleUpdateWorkspace(wForbid, r, "intruder@example.com", ws)
	if wForbid.Code != http.StatusForbidden {
		t.Errorf("non-owner update = %d, want 403", wForbid.Code)
	}

	// Owner but missing deployment dir → NDJSON stream with an error event.
	wsOwned := "updwsowned"
	if _, err := registerEndpoint(wsOwned+"-gitops."+domain, "owner2@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	wErr := newRecorder()
	srv.handleUpdateWorkspace(wErr, baileyReq(http.MethodPost, "/x", "owner2@example.com"), "owner2@example.com", wsOwned)
	if wErr.Code != http.StatusOK {
		t.Fatalf("owner update stream status = %d", wErr.Code)
	}
	if !strings.Contains(wErr.Body.String(), "deployment directory not found") {
		t.Errorf("expected missing-deployment error event; got: %s", wErr.Body.String())
	}
}

func TestUpdateWorkspace_OwnerWithDeploymentStreams(t *testing.T) {
	domain := writeTestConfig(t)
	owner := "updownerdep@example.com"
	ws := "updwsdep"
	// Own the gitops endpoint + create a deployment dir (no compose file,
	// so `docker compose pull/up` fails fast — best-effort, safe).
	if _, err := registerEndpoint(ws+"-gitops."+domain, owner, "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	mkWorkspaceDir(t, ws, true)
	srv := &Server{}
	w := newRecorder()
	srv.handleUpdateWorkspace(w, baileyReq(http.MethodPost, "/x", owner), owner, ws)
	if w.Code != http.StatusOK {
		t.Fatalf("update stream status = %d", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, `"event":"start"`) {
		t.Errorf("update stream missing start event: %s", body)
	}
	// Either a done or an error event must terminate the stream.
	if !strings.Contains(body, `"event":"done"`) && !strings.Contains(body, `"event":"error"`) {
		t.Errorf("update stream did not terminate: %s", body)
	}
}

func TestFetchDockerHubTags_BadRepo(t *testing.T) {
	// A clearly bogus repo path should surface an error (HTTP non-200 or a
	// network failure), never a panic.
	if _, err := fetchDockerHubTags("definitely/not-a-real-repo-xyz-123456", 1); err == nil {
		t.Skip("docker hub reachable and returned a result for the bogus repo")
	}
}
