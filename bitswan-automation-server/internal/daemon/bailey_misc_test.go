package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// --- bailey_static.go ---------------------------------------------------

func TestStatic_ServesEmbeddedAssets(t *testing.T) {
	for _, name := range []string{"network-map.js", "network-map.css"} {
		r := httptest.NewRequest(http.MethodGet, "https://bailey.example.com/bailey/static/"+name, nil)
		w := httptest.NewRecorder()
		handleBaileyStatic(w, r)
		if w.Code != http.StatusOK {
			t.Errorf("%s: status = %d, want 200", name, w.Code)
		}
		ct := w.Header().Get("Content-Type")
		if strings.HasSuffix(name, ".js") && !strings.Contains(ct, "javascript") {
			t.Errorf("%s: content-type = %q", name, ct)
		}
		if strings.HasSuffix(name, ".css") && !strings.Contains(ct, "css") {
			t.Errorf("%s: content-type = %q", name, ct)
		}
		if w.Header().Get("Cache-Control") == "" {
			t.Errorf("%s: missing Cache-Control", name)
		}
	}
}

func TestStatic_NotFoundAndTraversal(t *testing.T) {
	for _, p := range []string{"", "..", "../secret", "nope.js"} {
		r := httptest.NewRequest(http.MethodGet, "https://bailey.example.com/bailey/static/"+p, nil)
		r.URL.Path = "/bailey/static/" + p
		w := httptest.NewRecorder()
		handleBaileyStatic(w, r)
		if w.Code != http.StatusNotFound {
			t.Errorf("static %q = %d, want 404", p, w.Code)
		}
	}
}

func TestStaticAssetVersion(t *testing.T) {
	v := staticAssetVersion("network-map.js")
	if len(v) != 8 {
		t.Errorf("version hash = %q, want 8 hex chars", v)
	}
	if staticAssetVersion("nonexistent.js") != "" {
		t.Error("version for missing asset should be empty")
	}
}

func TestStatic_RoutedThroughDispatch(t *testing.T) {
	w := dispatch(baileyReq(http.MethodGet, "/bailey/static/network-map.js", "u@example.com"))
	if w.Code != http.StatusOK {
		t.Errorf("dispatched static = %d, want 200", w.Code)
	}
}

// --- bailey_notifications.go -------------------------------------------

func TestNotifications_CountForPendingPair(t *testing.T) {
	email := "notif@example.com"
	_ = dbDeletePendingPairByEmail(email)
	if _, err := generatePendingPair(email); err != nil {
		t.Fatal(err)
	}
	// The user sees their own pending pair as a notification.
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/notifications-count", email))
	if w.Code != http.StatusOK {
		t.Fatalf("count = %d", w.Code)
	}
	var got struct {
		Count int `json:"count"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if got.Count < 1 {
		t.Errorf("count = %d, want >=1", got.Count)
	}
}

func TestNotifications_CountNoIdentity(t *testing.T) {
	w := httptest.NewRecorder()
	handleNotificationsCount(w, httptest.NewRequest(http.MethodGet, "https://bailey.example.com/x", nil))
	if !strings.Contains(w.Body.String(), `"count":0`) {
		t.Errorf("no-identity count = %s, want 0", w.Body.String())
	}
}

func TestNotificationsPageHTML(t *testing.T) {
	email := "notifpage@example.com"
	_ = dbDeletePendingPairByEmail(email)
	// Empty state.
	empty := notificationsPageHTML(email, nil, false)
	if !strings.Contains(empty, "Nothing waiting") {
		t.Error("empty notifications page missing copy")
	}
	// With a pending pair.
	if _, err := generatePendingPair(email); err != nil {
		t.Fatal(err)
	}
	withPair := notificationsPageHTML(email, nil, false)
	if !strings.Contains(withPair, "Device pairing") {
		t.Error("pending-pair notification not rendered")
	}
}

func TestGatherNotifications_AccessRequestForOwner(t *testing.T) {
	writeTestConfig(t)
	owner := "nreqowner@example.com"
	host := "nreq-endpoint.example.com"
	if _, err := registerEndpoint(host, owner, "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := addAccessRequest(host, "asker@example.com"); err != nil {
		t.Fatal(err)
	}
	ns, err := gatherNotifications(owner, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	var sawAccess bool
	for _, n := range ns {
		if n.Kind == "access" && strings.EqualFold(n.Hostname, host) {
			sawAccess = true
		}
	}
	if !sawAccess {
		t.Error("owner did not get the access-request notification")
	}
}

// --- bailey_admin_devices.go -------------------------------------------

func TestAdminDevices_API(t *testing.T) {
	// Seed a device + a pending pair (orphan: no device for that email).
	if _, err := addDevice("addev@example.com", "AD Device"); err != nil {
		t.Fatal(err)
	}
	orphanEmail := "adorphan@example.com"
	_ = dbDeletePendingPairByEmail(orphanEmail)
	if _, err := generatePendingPair(orphanEmail); err != nil {
		t.Fatal(err)
	}
	w := dispatchSrv(baileyReq(http.MethodGet, "/bailey/api/admin/devices", "boss@example.com", adminGrp))
	if w.Code != http.StatusOK {
		t.Fatalf("admin devices = %d; body=%s", w.Code, w.Body.String())
	}
	var resp adminDevicesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	var sawUser bool
	for _, u := range resp.Users {
		if strings.EqualFold(u.Email, "addev@example.com") && len(u.Devices) > 0 {
			sawUser = true
		}
	}
	if !sawUser {
		t.Error("device owner not in admin devices response")
	}
	var sawOrphan bool
	for _, o := range resp.PendingPairsOrphan {
		if strings.EqualFold(o.Email, orphanEmail) {
			sawOrphan = true
		}
	}
	if !sawOrphan {
		t.Error("orphan pending pair not surfaced")
	}
}

func TestAdminDevices_RemoveAPI(t *testing.T) {
	email := "adremove@example.com"
	rec, err := addDevice(email, "ToKill")
	if err != nil {
		t.Fatal(err)
	}
	form := "email=" + email + "&id=" + rec.ID
	r := baileyForm("/bailey/api/admin/devices/remove", "boss@example.com", parseFormVals(form), adminGrp)
	w := dispatchSrv(r)
	if w.Code != http.StatusOK {
		t.Fatalf("admin remove = %d; body=%s", w.Code, w.Body.String())
	}
	if got, _ := findDevice(email, rec.ID); got != nil {
		t.Error("device not removed by admin remove")
	}
}

func TestAdminDevices_RemoveAPI_MissingFields(t *testing.T) {
	r := baileyForm("/bailey/api/admin/devices/remove", "boss@example.com", parseFormVals("email=&id="), adminGrp)
	w := dispatchSrv(r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("missing fields = %d, want 400", w.Code)
	}
}

// --- bailey_network_map.go (pure helpers) ------------------------------

func TestNetworkMap_PureHelpers(t *testing.T) {
	if !isWorkspaceStageNet("acme-production") || !isWorkspaceStageNet("x-dev") || !isWorkspaceStageNet("y-staging") {
		t.Error("isWorkspaceStageNet missed a stage suffix")
	}
	if isWorkspaceStageNet("randomnet") {
		t.Error("isWorkspaceStageNet matched a non-stage net")
	}
	if !isInfraContainer("traefik") || !isInfraContainer("bitswan-protected-proxy") {
		t.Error("isInfraContainer missed an infra name")
	}
	if isInfraContainer("some-app") {
		t.Error("isInfraContainer matched an app")
	}

	nets := map[string][]string{"acme-production": {"c1"}, "acme-dev": {}, "notaworkspace": {"x"}}
	ws := workspacesFromNetworks(nets)
	var sawAcme bool
	for _, w := range ws {
		if w == "acme" {
			sawAcme = true
		}
	}
	if !sawAcme {
		t.Errorf("workspacesFromNetworks = %v, want acme present", ws)
	}

	if got := serviceLabelForEndpoint("acme-gitops.example.com", "acme"); got != "gitops" {
		t.Errorf("serviceLabel = %q, want gitops", got)
	}
	if got := serviceLabelForEndpoint("bailey.example.com", "acme"); got != "" {
		t.Errorf("serviceLabel no-match = %q, want empty", got)
	}

	known := map[string]string{"acme-gitops": "acme"}
	if got := workspaceForEndpoint("acme-gitops.example.com", known); got != "acme" {
		t.Errorf("workspaceForEndpoint exact = %q", got)
	}
	known2 := map[string]string{"somecontainer": "acme"}
	if got := workspaceForEndpoint("acme-editor.example.com", known2); got != "acme" {
		t.Errorf("workspaceForEndpoint fallback = %q", got)
	}

	nodes := []nmNode{{ID: "n1"}}
	if !containsNode(nodes, "n1") || containsNode(nodes, "n2") {
		t.Error("containsNode wrong")
	}
	eps := []endpointRecord{{Hostname: "h.example.com"}}
	if !endpointInList(eps, "H.example.com") || endpointInList(eps, "other") {
		t.Error("endpointInList wrong")
	}
}

func TestNetworkMap_APIBuildsGraph(t *testing.T) {
	writeTestConfig(t)
	// docker may be absent — buildNetworkMap degrades gracefully. We just
	// assert the handler returns a well-formed JSON graph.
	w := dispatchSrv(baileyReq(http.MethodGet, "/bailey/api/admin/network-map", "boss@example.com", adminGrp))
	if w.Code != http.StatusOK {
		t.Fatalf("network-map = %d", w.Code)
	}
	var g nmGraph
	if err := json.Unmarshal(w.Body.Bytes(), &g); err != nil {
		t.Fatalf("decode graph: %v\n%s", err, w.Body.String())
	}
	if len(g.Nodes) == 0 {
		t.Error("graph has no nodes (expected at least the cloud node)")
	}
}

// parseFormVals is a tiny helper to turn "a=b&c=d" into url.Values for
// baileyForm.
func parseFormVals(s string) url.Values {
	out := url.Values{}
	for _, kv := range strings.Split(s, "&") {
		k, v, _ := strings.Cut(kv, "=")
		out.Add(k, v)
	}
	return out
}
