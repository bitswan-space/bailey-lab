package daemon

import (
	"os"
	"path/filepath"
	"testing"

	"gopkg.in/yaml.v3"
)

// A whole-workspace bitswan.yaml with two BPs — one (issues) spanning a main +
// a copy context, and per-BP firewall/backups keyed by raw bp.
func writeWholeWorkspaceState(t *testing.T, gitopsDir string) {
	t.Helper()
	bs := map[string]interface{}{
		"business_processes": map[string]interface{}{
			"issues": map[string]interface{}{ // main context == raw bp
				"live-dev": map[string]interface{}{
					"git_commit": "aaaa",
					"deployments": map[string]interface{}{
						"backend-issues-live-dev": map[string]interface{}{
							"relative_path": "copies/main/issues/backend",
							"image":         "img:issues",
						},
					},
				},
			},
			"copy-alice-issues": map[string]interface{}{ // copy context, raw bp = issues
				"live-dev": map[string]interface{}{
					"deployments": map[string]interface{}{
						"backend-copy-alice-issues-live-dev": map[string]interface{}{
							"relative_path": "copies/alice/issues/backend",
							"image":         "img:issues-alice",
						},
					},
				},
			},
			"invoices": map[string]interface{}{
				"live-dev": map[string]interface{}{
					"deployments": map[string]interface{}{
						"backend-invoices-live-dev": map[string]interface{}{
							"relative_path": "copies/main/invoices/backend",
						},
					},
				},
			},
		},
		"firewall": map[string]interface{}{
			"issues": map[string]interface{}{"dev": map[string]interface{}{"posture": "deny"}},
		},
		"backups": map[string]interface{}{
			"invoices": map[string]interface{}{"live_slot": "blue"},
		},
	}
	out, err := yaml.Marshal(bs)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(gitopsDir, "bitswan.yaml"), out, 0o644); err != nil {
		t.Fatal(err)
	}
}

func readBPFile(t *testing.T, dir string) map[string]interface{} {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "bitswan.yaml"))
	if err != nil {
		t.Fatalf("read %s: %v", dir, err)
	}
	var m map[string]interface{}
	if err := yaml.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestMigrateToPerBPDeployState(t *testing.T) {
	wsDir := t.TempDir()
	gitopsDir := filepath.Join(wsDir, "gitops")
	if err := os.MkdirAll(gitopsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeWholeWorkspaceState(t, gitopsDir)

	run := user1000Runner(false)
	if err := migrateToPerBPDeployState("ws1", wsDir, run); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// issues repo holds BOTH its main and copy contexts + its firewall.
	issues := readBPFile(t, filepath.Join(gitopsDir, "bp", "issues"))
	bpTree, _ := issues["business_processes"].(map[string]interface{})
	if _, ok := bpTree["issues"]; !ok {
		t.Errorf("issues slice missing main context: %v", bpTree)
	}
	if _, ok := bpTree["copy-alice-issues"]; !ok {
		t.Errorf("issues slice missing copy context: %v", bpTree)
	}
	if _, ok := issues["firewall"].(map[string]interface{})["issues"]; !ok {
		t.Errorf("issues slice missing its firewall: %v", issues)
	}
	// invoices is separate, with its own backups; no issues leakage.
	invoices := readBPFile(t, filepath.Join(gitopsDir, "bp", "invoices"))
	invTree, _ := invoices["business_processes"].(map[string]interface{})
	if _, ok := invTree["invoices"]; !ok || len(invTree) != 1 {
		t.Errorf("invoices slice wrong: %v", invTree)
	}
	if _, ok := invoices["backups"].(map[string]interface{})["invoices"]; !ok {
		t.Errorf("invoices slice missing its backups: %v", invoices)
	}

	// Each per-BP dir is a git repo with a commit; old file archived; marker set.
	if _, err := os.Stat(filepath.Join(gitopsDir, "bp", "issues", ".git")); err != nil {
		t.Errorf("issues not a git repo: %v", err)
	}
	if _, err := os.Stat(filepath.Join(gitopsDir, "bitswan.yaml")); !os.IsNotExist(err) {
		t.Errorf("old single bitswan.yaml should be archived")
	}
	if _, err := os.Stat(filepath.Join(wsDir, deploySplitMarker)); err != nil {
		t.Errorf("marker not written: %v", err)
	}

	// Idempotent re-run.
	if err := migrateToPerBPDeployState("ws1", wsDir, run); err != nil {
		t.Fatalf("re-run: %v", err)
	}
}

func TestMigrateToPerBPDeployState_FreshWorkspace(t *testing.T) {
	wsDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(wsDir, "gitops"), 0o755); err != nil {
		t.Fatal(err)
	}
	// No bitswan.yaml → nothing to split, just marker.
	if err := migrateToPerBPDeployState("ws1", wsDir, user1000Runner(false)); err != nil {
		t.Fatalf("migrate fresh: %v", err)
	}
	if _, err := os.Stat(filepath.Join(wsDir, deploySplitMarker)); err != nil {
		t.Errorf("marker not written on fresh workspace: %v", err)
	}
}
