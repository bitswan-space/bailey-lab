package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestDeviceOrigin_IndependentOfCurrent locks the fix for the bug where the
// "root" badge followed whichever device you were viewing from: origin is
// recorded at creation (root vs linked) and is_current tracks the request's
// cookie — two independent axes. Viewing from the LINKED device must show the
// root device as origin=root yet NOT current, and the linked device as current.
func TestDeviceOrigin_IndependentOfCurrent(t *testing.T) {
	writeTestConfig(t)
	email := "origin-user@example.com"
	root, err := addDeviceWithOrigin(email, "Root browser", deviceOriginRoot)
	if err != nil {
		t.Fatal(err)
	}
	linked, err := addDevice(email, "Linked browser") // defaults to "linked"
	if err != nil {
		t.Fatal(err)
	}

	// Request as if from the LINKED device (its cookie).
	r := baileyReq(http.MethodGet, "/bailey/api/devices", email)
	w0 := httptest.NewRecorder()
	if err := setDeviceCookie(w0, r, email, linked.ID); err != nil {
		t.Fatal(err)
	}
	for _, c := range w0.Result().Cookies() {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	handleBaileyDevicesAPI(w, r, email)
	if w.Code != http.StatusOK {
		t.Fatalf("devices = %d", w.Code)
	}
	var resp struct {
		Devices []baileyDeviceDTO `json:"devices"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	byID := map[string]baileyDeviceDTO{}
	for _, d := range resp.Devices {
		byID[d.ID] = d
	}
	if byID[root.ID].Origin != deviceOriginRoot {
		t.Errorf("root device origin = %q, want root", byID[root.ID].Origin)
	}
	if byID[root.ID].IsCurrent {
		t.Error("root device wrongly marked current when viewing from the linked device")
	}
	if byID[linked.ID].Origin != deviceOriginLinked {
		t.Errorf("linked device origin = %q, want linked", byID[linked.ID].Origin)
	}
	if !byID[linked.ID].IsCurrent {
		t.Error("the device we're viewing from (linked) is not marked current")
	}
}
