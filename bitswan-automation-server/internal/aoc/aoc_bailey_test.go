package aoc

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// newTestClient builds an AOCClient pointed at a test server. Same-package
// test, so it can set the unexported fields directly without an OTP exchange.
func newTestClient(aocURL string) *AOCClient {
	return &AOCClient{
		settings: &config.AutomationOperationsCenterSettings{
			AOCUrl:      aocURL,
			AccessToken: "test-token",
		},
	}
}

func TestReportBaileyURL(t *testing.T) {
	const want = "https://bailey.acme-prod.bswn.io"

	var gotMethod, gotPath, gotAuth, gotBaileyURL string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		body, _ := io.ReadAll(r.Body)
		var payload map[string]interface{}
		_ = json.Unmarshal(body, &payload)
		if v, ok := payload["bailey_url"].(string); ok {
			gotBaileyURL = v
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"bailey_url":"` + want + `"}`))
	}))
	defer ts.Close()

	if err := newTestClient(ts.URL).ReportBaileyURL(want); err != nil {
		t.Fatalf("ReportBaileyURL returned error: %v", err)
	}

	if gotMethod != http.MethodPatch {
		t.Errorf("method = %q; want PATCH", gotMethod)
	}
	if gotPath != "/api/automation_server/info" {
		t.Errorf("path = %q; want /api/automation_server/info", gotPath)
	}
	if gotAuth != "Bearer test-token" {
		t.Errorf("auth header = %q; want %q", gotAuth, "Bearer test-token")
	}
	if gotBaileyURL != want {
		t.Errorf("reported bailey_url = %q; want %q", gotBaileyURL, want)
	}
}

func TestReportBaileyURLServerError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"bailey_url":"Must be a string or null."}`))
	}))
	defer ts.Close()

	if err := newTestClient(ts.URL).ReportBaileyURL("nope"); err == nil {
		t.Fatal("expected an error on non-200 response, got nil")
	}
}
