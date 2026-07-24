package daemon

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func hasSetCookie(w *httptest.ResponseRecorder, name string) bool {
	for _, c := range w.Result().Cookies() {
		if c.Name == name && c.Value != "" {
			return true
		}
	}
	return false
}

// Device trust must NEVER lapse for an active device: browsers clamp cookie
// lifetime to ~400 days, so the gate rolls the device cookie's expiry forward
// on use. An aged cookie is re-issued (keeping trust alive indefinitely); a
// fresh one is left alone (so we don't Set-Cookie on every single request).
func TestDeviceTrust_RollsCookieForwardOnActiveUse(t *testing.T) {
	resetClaimState(t)
	markServerClaimed(t)
	domain := writeTestConfig(t)
	email := "user@example.com"
	dev, err := addDevice(email, "laptop")
	if err != nil {
		t.Fatal(err)
	}

	// Aged cookie (issued 48h ago) → gate passes AND re-issues it.
	aged, err := signedDeviceCookie(email, dev.ID, time.Now().Add(-48*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	r := gateReq(serverConsoleHost(domain), "/", email, nil)
	r.AddCookie(&http.Cookie{Name: deviceCookieName, Value: aged})
	w := httptest.NewRecorder()
	if !enforceMFAGate(w, r) {
		t.Fatalf("trusted device with an aged cookie must pass the gate (got redirect %d)", w.Code)
	}
	if !hasSetCookie(w, deviceCookieName) {
		t.Error("gate did not roll the aged device cookie forward — trust would eventually lapse")
	}

	// Fresh cookie (issued now) → passes but is NOT re-issued.
	fresh, err := signedDeviceCookie(email, dev.ID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	r2 := gateReq(serverConsoleHost(domain), "/", email, nil)
	r2.AddCookie(&http.Cookie{Name: deviceCookieName, Value: fresh})
	w2 := httptest.NewRecorder()
	if !enforceMFAGate(w2, r2) {
		t.Fatal("trusted device with a fresh cookie must pass the gate")
	}
	if hasSetCookie(w2, deviceCookieName) {
		t.Error("gate re-issued a fresh cookie; it should only roll aged ones")
	}
}
