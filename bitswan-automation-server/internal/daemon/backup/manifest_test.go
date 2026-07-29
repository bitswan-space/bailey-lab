package backup

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// The manifest is the only thing that tells a bare machine what it is supposed
// to become, so the fields that exist NOWHERE else deserve explicit coverage:
// the image pins (which live only in the daemon container's environment) and
// the binary version (which drives the skew warning).

func TestManifestRoundTripsWhatOnlyItRecords(t *testing.T) {
	original := ServerManifest{
		BitswanVersion: "2026.07.1",
		DaemonImage:    "bitswan/automation-server-runtime:latest",
		ServerID:       "srv-123",
		AOCUrl:         "https://api.example.com",
		Domain:         "acme.bswn.io",
		Proxied:        true,
		ImagePins: map[string]string{
			"BITSWAN_GITOPS_IMAGE": "bitswan/gitops:pinned",
		},
		Workspaces: []ManifestWorkspace{{
			Name:        "tenant-a",
			WorkspaceID: "8f14e45f-0000-4000-8000-000000000001",
			Domain:      "tenant-a.acme.bswn.io",
			Enabled:     map[string][]string{"postgres": {"production", "staging"}},
			Images:      map[string]string{"bitswan-gitops": "bitswan/gitops:pinned"},
		}},
		Routes:               []string{"bailey.acme.bswn.io"},
		MkcertCAFingerprint:  "ab:cd",
		DeliberatelyExcluded: []string{"the mkcert CA private key (~/.local/share/mkcert)"},
	}

	raw, err := original.Marshal()
	if err != nil {
		t.Fatal(err)
	}

	var decoded ServerManifest
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}

	if decoded.SchemaVersion != ManifestSchemaVersion {
		t.Errorf("schema version = %d, want %d", decoded.SchemaVersion, ManifestSchemaVersion)
	}
	if decoded.CapturedAt.IsZero() {
		t.Error("Marshal should stamp captured_at")
	}
	if decoded.ImagePins["BITSWAN_GITOPS_IMAGE"] != "bitswan/gitops:pinned" {
		t.Errorf("image pins lost: %+v", decoded.ImagePins)
	}
	if len(decoded.Workspaces) != 1 ||
		decoded.Workspaces[0].WorkspaceID != original.Workspaces[0].WorkspaceID ||
		len(decoded.Workspaces[0].Enabled["postgres"]) != 2 {
		t.Errorf("workspace detail lost: %+v", decoded.Workspaces)
	}
	if decoded.BitswanVersion != "2026.07.1" || decoded.DaemonImage == "" {
		t.Errorf("recovery-critical versions lost: %+v", decoded)
	}
	if len(decoded.DeliberatelyExcluded) != 1 {
		t.Errorf("the exclusion note is what stops a recovery operator wondering: %+v", decoded)
	}
}

func TestManifestKeepsAnExplicitCaptureTime(t *testing.T) {
	when := time.Date(2026, 7, 29, 2, 0, 0, 0, time.UTC)
	raw, err := ServerManifest{CapturedAt: when}.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	var decoded ServerManifest
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if !decoded.CapturedAt.Equal(when) {
		t.Errorf("captured_at = %s, want %s", decoded.CapturedAt, when)
	}
}

func TestCheckVersionSkew(t *testing.T) {
	cases := []struct {
		name     string
		backup   string
		running  string
		wantWarn bool
	}{
		{"identical", "1.2.3", "1.2.3", false},
		{"whitespace only", " 1.2.3 ", "1.2.3", false},
		{"different", "1.2.3", "2.0.0", true},
		// An older snapshot predates the manifest, and a dev build may have no
		// version at all. Neither is a reason to alarm an operator mid-recovery.
		{"backup version unknown", "", "2.0.0", false},
		{"running version unknown", "1.2.3", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			warning := CheckVersionSkew(ServerManifest{BitswanVersion: tc.backup}, tc.running)
			if tc.wantWarn == (warning == "") {
				t.Fatalf("warning = %q, wantWarn = %v", warning, tc.wantWarn)
			}
			if tc.wantWarn {
				// Naming both versions is the whole value of the warning.
				if !strings.Contains(warning, tc.backup) || !strings.Contains(warning, tc.running) {
					t.Errorf("warning should name both versions: %q", warning)
				}
			}
		})
	}
}

func TestReadServerManifestFailsHelpfullyOnAnOldSnapshot(t *testing.T) {
	// Pre-manifest snapshots have no such file; restic exits non-zero. The
	// error has to explain that rather than reading as data corruption.
	fakeRestic(t, 1, "file not found in snapshot")
	restic := NewRestic(NewAOCTarget("https://aoc.example.com", "srv-123", "tok"), "key")

	_, err := ReadServerManifest(t.Context(), restic, "abc123")
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "before manifests were added") {
		t.Errorf("error should explain the likely cause: %v", err)
	}
}
