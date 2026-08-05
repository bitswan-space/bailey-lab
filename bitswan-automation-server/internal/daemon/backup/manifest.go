package backup

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// The server manifest: what this server WAS, recorded inside its own backup.
//
// A recovery starts on a machine that knows nothing — not which workspaces
// existed, not which images were pinned, not which binary made the backup. Some
// of that is nowhere else on disk at all: the BITSWAN_* image overrides live
// only in the daemon container's environment. So the manifest is written fresh
// into every server snapshot and is the first thing a recovery reads.

// ManifestSchemaVersion is bumped when the shape changes incompatibly.
const ManifestSchemaVersion = 1

// ManifestWorkspace is one workspace as it existed at backup time.
type ManifestWorkspace struct {
	Name        string `json:"name"`
	WorkspaceID string `json:"workspace_id,omitempty"` // the AOC UUID
	Domain      string `json:"domain,omitempty"`
	// Enabled maps service → the stages it was enabled on, so a recovery knows
	// which DB/object-store restores to expect.
	Enabled map[string][]string `json:"enabled,omitempty"`
	// Images are the pins from the workspace's own compose, which a recovery
	// must not silently replace with freshly resolved tags.
	Images map[string]string `json:"images,omitempty"`
}

// ServerManifest describes the server a snapshot came from.
type ServerManifest struct {
	SchemaVersion int       `json:"schema_version"`
	CapturedAt    time.Time `json:"captured_at"`

	// BitswanVersion is the binary that produced the backup. A recovery warns
	// when the binary performing it differs.
	BitswanVersion string `json:"bitswan_version,omitempty"`
	// DaemonImage is load-bearing for a bare-machine restore: it names the
	// image whose restic can read this repo.
	DaemonImage string `json:"daemon_image,omitempty"`

	ServerID        string `json:"server_id,omitempty"`
	AOCUrl          string `json:"aoc_url,omitempty"`
	Domain          string `json:"domain,omitempty"`
	ProtectedDomain string `json:"protected_domain,omitempty"`
	Proxied         bool   `json:"proxied,omitempty"`
	RelayAddr       string `json:"relay_addr,omitempty"`

	// ImagePins are the BITSWAN_* environment overrides — nowhere on disk.
	ImagePins map[string]string `json:"image_pins,omitempty"`

	Workspaces []ManifestWorkspace `json:"workspaces,omitempty"`
	// Routes are the global ingress hostnames, so a recovery can cross-check
	// the restored rest-state.json against what was really there.
	Routes        []string `json:"routes,omitempty"`
	ServerVolumes []string `json:"server_volumes,omitempty"`

	// MkcertCAFingerprint identifies the CA that signed the .localhost certs.
	// The CA itself is deliberately NOT backed up, so this is how a recovery
	// confirms the post-restore CA really is a different one.
	MkcertCAFingerprint string `json:"mkcert_ca_fingerprint,omitempty"`
	// DeliberatelyExcluded names what was left out on purpose, so a recovery
	// operator is not left wondering whether the backup is broken.
	DeliberatelyExcluded []string `json:"deliberately_excluded,omitempty"`
}

// Marshal renders the manifest for writing into the snapshot.
func (m ServerManifest) Marshal() ([]byte, error) {
	m.SchemaVersion = ManifestSchemaVersion
	if m.CapturedAt.IsZero() {
		m.CapturedAt = time.Now().UTC()
	}
	return json.MarshalIndent(m, "", "  ")
}

// ReadServerManifest pulls the manifest out of a snapshot without materializing
// anything: `restic dump` streams a single file. snapshotID may be "latest".
func ReadServerManifest(ctx context.Context, restic *Restic, snapshotID string) (ServerManifest, error) {
	var manifest ServerManifest
	if snapshotID == "" {
		snapshotID = "latest"
	}
	// Scope "latest" to the server series, or it would resolve to whatever
	// snapshot happens to be newest (usually a workspace's).
	// --no-lock because this is a pure read and restic would otherwise create a
	// lock object — a WRITE. A recovery reads the manifest before it has exchanged
	// its one-time password, authenticating with the OTP, and the AOC allows an OTP
	// reads only: taking the lock would fail with a 403 that looks like a
	// permissions bug rather than what it is.
	args := []string{"dump", "--no-lock"}
	if snapshotID == "latest" {
		args = append(args, "--tag", "server-config")
	}
	args = append(args, snapshotID, serverManifestPath())

	stdout, _, err := restic.Run(ctx, args...)
	if err != nil {
		return manifest, fmt.Errorf("could not read the server manifest from the backup "+
			"(a snapshot made before manifests were added will not have one): %w", err)
	}
	if err := json.Unmarshal([]byte(stdout), &manifest); err != nil {
		return manifest, fmt.Errorf("the server manifest is not valid JSON: %w", err)
	}
	return manifest, nil
}

// CheckVersionSkew returns a human-readable warning when the binary running a
// recovery differs from the one that made the backup, or "" when they match.
//
// Always a warning, never a refusal: a version difference is usually harmless,
// and blocking a disaster recovery over it would be worse than the risk.
func CheckVersionSkew(manifest ServerManifest, running string) string {
	backupVersion := strings.TrimSpace(manifest.BitswanVersion)
	running = strings.TrimSpace(running)
	if backupVersion == "" || running == "" || backupVersion == running {
		return ""
	}
	return fmt.Sprintf(
		"version skew: this backup was made by bitswan %s but %s is performing the recovery — "+
			"restores are expected to work across versions, but if something behaves oddly, "+
			"try the version that made the backup",
		backupVersion, running)
}
