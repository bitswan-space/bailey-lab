package services

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newTestAgentService pins HOME to a temp dir and creates the workspace
// layout NewCodingAgentService expects.
func newTestAgentService(t *testing.T, workspace string) *CodingAgentService {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	deployment := filepath.Join(home, ".config", "bitswan", "workspaces", workspace, "deployment")
	if err := os.MkdirAll(deployment, 0o755); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}
	svc, err := NewCodingAgentService(workspace)
	if err != nil {
		t.Fatalf("NewCodingAgentService: %v", err)
	}
	return svc
}

// TestCodingAgentComposeJoinsDevNetwork proves the #210 network attachment:
// the generated compose puts the agent on the workspace dev network (so its
// browser tooling can reach deployed dev frontends) and declares that
// network external — and does NOT attach staging or production.
func TestCodingAgentComposeJoinsDevNetwork(t *testing.T) {
	svc := newTestAgentService(t, "wsx")
	out, err := svc.CreateDockerCompose("sekret", "img:tag", "example.com")
	if err != nil {
		t.Fatalf("CreateDockerCompose: %v", err)
	}
	for _, want := range []string{"wsx-dev", "bitswan_network"} {
		if !strings.Contains(out, want) {
			t.Errorf("compose missing %q:\n%s", want, out)
		}
	}
	for _, reject := range []string{"wsx-staging", "wsx-production"} {
		if strings.Contains(out, reject) {
			t.Errorf("compose must not attach %q (least privilege):\n%s", reject, out)
		}
	}
}

// TestUpdateImagePatchesInDevNetwork proves a compose file written before
// the dev-network attachment gains it on the next image update, so existing
// installs self-heal without a re-enable.
func TestUpdateImagePatchesInDevNetwork(t *testing.T) {
	svc := newTestAgentService(t, "wsy")
	legacy := `
version: "3.8"
services:
  bitswan-coding-agent:
    image: old:img
    networks:
      - bitswan_network
networks:
  bitswan_network:
    external: true
`
	composePath := filepath.Join(svc.WorkspacePath, "deployment", "docker-compose-coding-agent.yml")
	if err := os.WriteFile(composePath, []byte(legacy), 0o644); err != nil {
		t.Fatalf("write legacy compose: %v", err)
	}

	if err := svc.UpdateImage("new:img"); err != nil {
		t.Fatalf("UpdateImage: %v", err)
	}
	updated, err := os.ReadFile(composePath)
	if err != nil {
		t.Fatalf("read updated compose: %v", err)
	}
	for _, want := range []string{"new:img", "wsy-dev"} {
		if !strings.Contains(string(updated), want) {
			t.Errorf("updated compose missing %q:\n%s", want, updated)
		}
	}

	// Idempotence: a second update must not duplicate the network entry.
	if err := svc.UpdateImage("newer:img"); err != nil {
		t.Fatalf("UpdateImage again: %v", err)
	}
	updated, _ = os.ReadFile(composePath)
	if got := strings.Count(string(updated), "wsy-dev"); got != 2 {
		t.Errorf("wsy-dev should appear exactly twice (service list + networks map), got %d:\n%s", got, updated)
	}
}
