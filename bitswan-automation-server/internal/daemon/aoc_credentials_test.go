package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// POST /aoc/credentials exists for one job: a recovered server's config is
// correct except for the access token, because redeeming the recovery OTP minted
// a new one. The test that matters is that swapping the token does not quietly
// take anything else with it — during the manual drill that field-preservation
// was done with `sed`, precisely because the existing /aoc/config replaces the
// whole [aoc] table.

// writeRestoredConfig lays down a config shaped like one restored from a backup:
// a full registration with relay details and a now-stale token.
func writeRestoredConfig(t *testing.T) *config.AutomationServerConfig {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	dir := filepath.Join(os.Getenv("HOME"), ".config", "bitswan")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	toml := `active_workspace = "dev"
protected_domain = "apps.acme.com"

[aoc]
  aoc_url = "https://api.acme.com"
  automation_server_id = "srv-123"
  access_token = "STALE-token-from-the-backup"
  expires_at = "2026-01-01T00:00:00Z"
  domain = "acme-prod.bswn.io"
  proxied = true
  relay_addr = "relay.acme.com:7443"
  relay_fingerprint = "sha256:deadbeef"

[local_server]
  token = "host-local-token"
`
	if err := os.WriteFile(filepath.Join(dir, "automation_server_config.toml"), []byte(toml), 0o600); err != nil {
		t.Fatal(err)
	}
	return config.NewAutomationServerConfig()
}

func postCredentials(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	s := &Server{}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/aoc/credentials", strings.NewReader(body))
	s.handleAOCCredentials(w, r)
	return w
}

func TestAOCCredentialsSwapsTokenAndKeepsEverythingElse(t *testing.T) {
	cfg := writeRestoredConfig(t)

	w := postCredentials(t, `{"access_token":"FRESH-token","expires_at":"2027-07-29T17:01:52Z"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}

	got, err := cfg.LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	aoc := got.AutomationOperationsCenter

	if aoc.AccessToken != "FRESH-token" || aoc.ExpiresAt != "2027-07-29T17:01:52Z" {
		t.Errorf("credentials not updated: %+v", aoc)
	}
	// Every one of these is unrecoverable from the manifest alone, so losing any
	// of them would leave a recovered server subtly wrong rather than broken.
	for _, tc := range []struct{ field, got, want string }{
		{"aoc_url", aoc.AOCUrl, "https://api.acme.com"},
		{"automation_server_id", aoc.AutomationServerId, "srv-123"},
		{"domain", aoc.Domain, "acme-prod.bswn.io"},
		{"relay_addr", aoc.RelayAddr, "relay.acme.com:7443"},
		{"relay_fingerprint", aoc.RelayFingerprint, "sha256:deadbeef"},
	} {
		if tc.got != tc.want {
			t.Errorf("%s = %q, want %q (must survive a credential swap)", tc.field, tc.got, tc.want)
		}
	}
	if !aoc.Proxied {
		t.Error("proxied must survive a credential swap")
	}
	// Fields outside [aoc] round-trip through the same whole-file re-encode.
	if got.ActiveWorkspace != "dev" || got.ProtectedDomain != "apps.acme.com" {
		t.Errorf("non-AOC config lost: active_workspace=%q protected_domain=%q",
			got.ActiveWorkspace, got.ProtectedDomain)
	}
	if got.LocalServer.Token != "host-local-token" {
		t.Errorf("local server token lost: %q", got.LocalServer.Token)
	}
}

func TestAOCCredentialsKeepsTheFileOwnerOnly(t *testing.T) {
	cfg := writeRestoredConfig(t)
	if w := postCredentials(t, `{"access_token":"FRESH"}`); w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	info, err := os.Stat(cfg.GetConfigPath())
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("config mode = %o, want 600 (it holds the access token)", perm)
	}
}

func TestAOCCredentialsRejectsBadInput(t *testing.T) {
	writeRestoredConfig(t)
	if w := postCredentials(t, `{"expires_at":"2027-01-01T00:00:00Z"}`); w.Code != http.StatusBadRequest {
		t.Errorf("missing token: status = %d, want 400", w.Code)
	}
	if w := postCredentials(t, `not json`); w.Code != http.StatusBadRequest {
		t.Errorf("bad body: status = %d, want 400", w.Code)
	}
	s := &Server{}
	w := httptest.NewRecorder()
	s.handleAOCCredentials(w, httptest.NewRequest(http.MethodGet, "/aoc/credentials", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET: status = %d, want 405", w.Code)
	}
}

func TestAOCCredentialsRefusesWhenThereIsNothingToMergeInto(t *testing.T) {
	// An unregistered server has no config to preserve, so this endpoint is the
	// wrong tool — say so and point at the one that writes a whole registration.
	t.Setenv("HOME", t.TempDir())
	w := postCredentials(t, `{"access_token":"FRESH"}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body = %s", w.Code, w.Body.String())
	}
	var errResp ErrorResponse
	if err := json.Unmarshal(w.Body.Bytes(), &errResp); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(errResp.Error, "/aoc/config") {
		t.Errorf("error should point at the registration endpoint: %q", errResp.Error)
	}
}
