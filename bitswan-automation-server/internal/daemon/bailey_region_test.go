package daemon

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestServerRegion_SetGetClear(t *testing.T) {
	t.Setenv("BITSWAN_REGION", "")
	t.Cleanup(func() { _ = setServerRegion("", "test") })

	if err := setServerRegion("eu-west-1", "test"); err != nil {
		t.Fatal(err)
	}
	if got := serverRegion(); got != "eu-west-1" {
		t.Errorf("serverRegion() = %q; want eu-west-1", got)
	}
	// Exported CLI wrappers operate on the same store.
	if Region() != "eu-west-1" {
		t.Errorf("Region() = %q; want eu-west-1", Region())
	}

	// Clearing reverts to the env-var fallback.
	t.Setenv("BITSWAN_REGION", "env-region")
	if err := SetRegion(""); err != nil {
		t.Fatal(err)
	}
	if got := serverRegion(); got != "env-region" {
		t.Errorf("after clear, serverRegion() = %q; want env-region fallback", got)
	}
}

func TestHandleSetRegion(t *testing.T) {
	t.Setenv("BITSWAN_REGION", "")
	t.Cleanup(func() { _ = setServerRegion("", "test") })

	// Valid set.
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/bailey/api/admin/region", strings.NewReader(`{"region":"us-east"}`))
	handleSetRegion(w, r, "admin@example.com")
	if w.Code != http.StatusOK {
		t.Fatalf("set region = %d; body=%s", w.Code, w.Body.String())
	}
	if serverRegion() != "us-east" {
		t.Errorf("region not persisted: %q", serverRegion())
	}

	// Over-long region is rejected.
	w2 := httptest.NewRecorder()
	long := strings.Repeat("x", 65)
	r2 := httptest.NewRequest(http.MethodPost, "/bailey/api/admin/region", strings.NewReader(`{"region":"`+long+`"}`))
	handleSetRegion(w2, r2, "admin@example.com")
	if w2.Code != http.StatusBadRequest {
		t.Errorf("over-long region = %d; want 400", w2.Code)
	}

	// Empty clears (no env → "").
	_ = os.Unsetenv("BITSWAN_REGION")
	w3 := httptest.NewRecorder()
	r3 := httptest.NewRequest(http.MethodPost, "/bailey/api/admin/region", strings.NewReader(`{"region":""}`))
	handleSetRegion(w3, r3, "admin@example.com")
	if w3.Code != http.StatusOK {
		t.Fatalf("clear region = %d", w3.Code)
	}
	if serverRegion() != "" {
		t.Errorf("region not cleared: %q", serverRegion())
	}
}
