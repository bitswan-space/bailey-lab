package dockerdriver

import (
	"context"
	"os/exec"
	"strings"
	"testing"
)

// TestWorkspaceScopingRefusesForeignContainer is the security gate: a driver
// scoped to workspace A must refuse to act on a container belonging to another
// workspace (or to the daemon / host). Docker-gated — skipped without a daemon.
func TestWorkspaceScopingRefusesForeignContainer(t *testing.T) {
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker not available")
	}
	ctx := context.Background()
	if err := exec.CommandContext(ctx, "docker", "info").Run(); err != nil {
		t.Skip("docker daemon not reachable")
	}

	// A throwaway container labelled for workspace "ws-a".
	name := "infradriver-scope-test"
	_ = exec.CommandContext(ctx, "docker", "rm", "-f", name).Run()
	if out, err := exec.CommandContext(ctx, "docker", "run", "-d", "--name", name,
		"--label", "gitops.workspace=ws-a", "busybox", "sleep", "60").CombinedOutput(); err != nil {
		t.Skipf("could not start test container (no busybox image?): %s", out)
	}
	defer exec.CommandContext(context.Background(), "docker", "rm", "-f", name).Run()

	// A driver for the SAME workspace may act on it.
	if err := New("ws-a").assertInWorkspace(ctx, name); err != nil {
		t.Fatalf("same-workspace exec was refused: %v", err)
	}
	// A driver for a DIFFERENT workspace must refuse — this is the boundary that
	// stops gitops-for-B (or a compromised gitops) from exec'ing into A's, the
	// daemon's, or any other container.
	err := New("ws-b").assertInWorkspace(ctx, name)
	if err == nil {
		t.Fatal("cross-workspace exec was NOT refused — boundary broken")
	}
	if !strings.Contains(err.Error(), "refused") {
		t.Fatalf("unexpected error: %v", err)
	}

	// An unscoped driver (empty workspace, tests/dev only) does not enforce.
	if err := New("").assertInWorkspace(ctx, name); err != nil {
		t.Fatalf("unscoped driver should not enforce: %v", err)
	}
}
