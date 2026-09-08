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

	if _, err := newTestClient(ts.URL).ReportBaileyURL(want, BaileyURLReport{}); err != nil {
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

	if _, err := newTestClient(ts.URL).ReportBaileyURL("nope", BaileyURLReport{}); err == nil {
		t.Fatal("expected an error on non-200 response, got nil")
	}
}

// TestReportBaileyURLDeclaresPrivatePosition: the AOC cannot discover that a
// server sits behind a VPN, and it cannot discover the address to publish for it
// either — pointing the record at its relay is its uniform default. Both facts
// therefore have to travel on this report, and the absence of either one is what
// would silently put a private server on the public internet.
func TestReportBaileyURLDeclaresPrivatePosition(t *testing.T) {
	var payload map[string]interface{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &payload)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"domain_status":"private"}`))
	}))
	defer ts.Close()

	status, err := newTestClient(ts.URL).ReportBaileyURL(
		"https://bailey.acme-prod.bswn.io",
		BaileyURLReport{Private: true, PrivateAddress: "10.8.0.7"},
	)
	if err != nil {
		t.Fatalf("ReportBaileyURL returned error: %v", err)
	}
	if status != "private" {
		t.Errorf("domain_status = %q, want %q", status, "private")
	}
	if payload["private"] != true {
		t.Errorf("payload private = %v, want true", payload["private"])
	}
	if payload["private_address"] != "10.8.0.7" {
		t.Errorf("payload private_address = %v, want 10.8.0.7", payload["private_address"])
	}
	if _, ok := payload["force_proxy"]; ok {
		t.Error("a private report must not also ask for the relay")
	}
}

// A plain report must stay byte-compatible with what an older AOC accepts: no
// private keys at all, so an AOC that doesn't know the field can't 400 on it.
func TestReportBaileyURLOmitsPrivateWhenNotDeclared(t *testing.T) {
	var payload map[string]interface{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &payload)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer ts.Close()

	if _, err := newTestClient(ts.URL).ReportBaileyURL("https://bailey.acme-prod.bswn.io",
		BaileyURLReport{}); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"private", "private_address", "force_proxy"} {
		if _, ok := payload[k]; ok {
			t.Errorf("payload carries %q on a plain report: %v", k, payload)
		}
	}
}
