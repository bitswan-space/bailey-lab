package daemon

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStripBaileyAuthCookies_AppNeverSeesCredential(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "https://app.example.com/", nil)
	r.AddCookie(&http.Cookie{Name: deviceCookieName, Value: "secret-device-cred"})
	r.AddCookie(&http.Cookie{Name: gateOriginCookie, Value: "/somewhere"})
	r.AddCookie(&http.Cookie{Name: "app_session", Value: "keep-me"})

	stripBaileyAuthCookies(r)

	if _, err := r.Cookie(deviceCookieName); err == nil {
		t.Error("device-trust cookie leaked to the app upstream")
	}
	if _, err := r.Cookie(gateOriginCookie); err == nil {
		t.Error("gate origin cookie leaked to the app upstream")
	}
	if c, err := r.Cookie("app_session"); err != nil || c.Value != "keep-me" {
		t.Errorf("app's own cookie was dropped: %v", err)
	}
}
