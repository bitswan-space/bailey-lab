package services

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A live check against the machine's own Docker: seed an audit directory in the
// workspace volume, bring the agent up on it, and prove the report the agent
// writes is the file the workspace reads. Skipped unless AUDIT_LIVE names the
// workspace whose volume to use, because it starts a real container.
//
//	AUDIT_LIVE=playground AUDIT_LIVE_IMAGE=bitswan/coding-agent-dev:latest \
//	  go test ./internal/services/ -run TestAuditAgentAgainstRealDocker -v
func TestAuditAgentAgainstRealDocker(t *testing.T) {
	workspace := os.Getenv("AUDIT_LIVE")
	if workspace == "" {
		t.Skip("set AUDIT_LIVE=<workspace> to run the audit agent against real Docker")
	}
	image := os.Getenv("AUDIT_LIVE_IMAGE")
	if image == "" {
		image = "bitswan/coding-agent-dev:latest"
	}
	const bp, sha = "audit-live", "0123456789ab"
	volumeRoot := os.Getenv("AUDIT_LIVE_VOLUME_ROOT")
	if volumeRoot == "" {
		volumeRoot = "/var/lib/docker/volumes/bitswan/_data"
	}
	dir := filepath.Join(volumeRoot, "workspaces", workspace, "audits", bp, sha)
	if err := os.MkdirAll(filepath.Join(dir, "source"), 0o755); err != nil {
		t.Fatalf("seed the audit directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "source", "worker.py"), []byte("VAT = 21\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "report.md"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = StopAuditAgent(workspace, bp, sha)
		_ = os.RemoveAll(filepath.Join(volumeRoot, "workspaces", workspace, "audits", bp))
	})

	state, err := StartAuditAgent(AuditAgentSpec{
		WorkspaceName: workspace, BP: bp, Sha: sha, Image: image,
	})
	if err != nil {
		t.Fatalf("StartAuditAgent: %v", err)
	}
	if running, _ := state["running"].(bool); !running {
		t.Fatalf("the agent did not come up: %v", state)
	}

	out, err := runDocker("", "exec", AuditAgentName(workspace, bp, sha), "sh", "-lc",
		"echo drafted > /audit/report.md; cat /audit/source/worker.py; touch /audit/source/nope 2>&1 | tail -1")
	if err != nil {
		t.Fatalf("exec in the agent: %v (%s)", err, out)
	}
	text := string(out)
	if !strings.Contains(text, "VAT = 21") {
		t.Errorf("the agent cannot read the audited source: %s", text)
	}
	if !strings.Contains(text, "Read-only file system") {
		t.Errorf("the audited source must be read-only to the agent: %s", text)
	}
	written, readErr := os.ReadFile(filepath.Join(dir, "report.md"))
	if readErr != nil {
		t.Fatalf("read the report back: %v", readErr)
	}
	if strings.TrimSpace(string(written)) != "drafted" {
		t.Errorf("the report the agent wrote is not the file the workspace reads: %q", written)
	}
}
