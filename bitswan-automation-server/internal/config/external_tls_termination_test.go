package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The declaration disarms half of an interception check, so it has to survive a
// round trip exactly — and it has to survive the OTHER writers of this file.
// Registration sets a TLS mode, a bind address and the AOC block in separate
// calls, each of which rewrites the whole TOML; a field that any of them dropped
// would re-arm the check on the next boot and alarm forever.
func TestExternalTLSTerminationRoundTripsAlongsideTheOtherIngressSettings(t *testing.T) {
	dir := t.TempDir()
	m := NewAutomationServerConfigWithDir(dir)

	if m.GetExternalTLSTermination() {
		t.Error("a server with no config at all must not be treated as externally terminated")
	}

	if err := m.SetTLSMode("manual"); err != nil {
		t.Fatal(err)
	}
	if err := m.SetExternalTLSTermination(true); err != nil {
		t.Fatal(err)
	}
	if err := m.SetIngressBindAddress("10.8.0.7"); err != nil {
		t.Fatal(err)
	}

	if !m.GetExternalTLSTermination() {
		t.Error("the declaration did not survive a later write of the same file")
	}
	if got := m.GetTLSMode(); got != "manual" {
		t.Errorf("tls_mode = %q, want it untouched", got)
	}

	raw, err := os.ReadFile(filepath.Join(dir, "automation_server_config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "external_tls_termination") {
		t.Errorf("the declaration is not in the file an operator reads:\n%s", raw)
	}

	// Withdrawing it must clear the key, not leave a stale true behind: TLS
	// termination moving back onto the server has to re-arm the check.
	if err := m.SetExternalTLSTermination(false); err != nil {
		t.Fatal(err)
	}
	if m.GetExternalTLSTermination() {
		t.Error("withdrawing the declaration did not persist")
	}
}
