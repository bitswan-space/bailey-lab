package daemon

import (
	"os"
	"path/filepath"
	"testing"
)

func writeWorkspaceCompose(t *testing.T, home, workspaceName, body string) {
	t.Helper()
	dir := filepath.Join(home, ".config", "bitswan", "workspaces", workspaceName, "deployment")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte(body), 0o644); err != nil {
		t.Fatalf("write compose: %v", err)
	}
}

func TestCurrentGitopsImage(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	// A typical generated compose: the gitops service records its image.
	writeWorkspaceCompose(t, home, "ws-staging", `
services:
  bitswan-gitops:
    image: bitswan/gitops-staging:2026-28456985040-git-6088745
    hostname: ws-staging-gitops
  ws-staging-infra-driver:
    image: bitswan/automation-server-runtime:latest
`)
	if got := currentGitopsImage("ws-staging"); got != "bitswan/gitops-staging:2026-28456985040-git-6088745" {
		t.Fatalf("staging image: got %q", got)
	}

	// Production image is read verbatim too (no downgrade logic here — the point
	// is to reflect exactly what's deployed).
	writeWorkspaceCompose(t, home, "ws-prod", `
services:
  bitswan-gitops:
    image: bitswan/gitops:2026-25277988269-git-0fd361e
`)
	if got := currentGitopsImage("ws-prod"); got != "bitswan/gitops:2026-25277988269-git-0fd361e" {
		t.Fatalf("prod image: got %q", got)
	}

	// Missing deployment → empty string, so callers fall back to the resolver.
	if got := currentGitopsImage("ws-missing"); got != "" {
		t.Fatalf("missing workspace: got %q, want empty", got)
	}

	// Malformed YAML → empty string (never blocks the regeneration path).
	writeWorkspaceCompose(t, home, "ws-bad", "this: : not: valid: yaml")
	if got := currentGitopsImage("ws-bad"); got != "" {
		t.Fatalf("malformed compose: got %q, want empty", got)
	}

	// Compose without a gitops service (or without an image) → empty string.
	writeWorkspaceCompose(t, home, "ws-noimg", `
services:
  something-else:
    image: foo/bar:latest
`)
	if got := currentGitopsImage("ws-noimg"); got != "" {
		t.Fatalf("no gitops service: got %q, want empty", got)
	}
}
