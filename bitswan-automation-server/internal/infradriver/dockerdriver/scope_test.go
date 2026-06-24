package dockerdriver

import (
	"context"
	"os/exec"
	"strings"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
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

// TestCopyScopingRefusesForeignContainer is the same boundary for the archive
// primitives: copy-out/copy-in must refuse a foreign container before they
// touch the daemon's archive API (a TAR exfiltration / injection would
// otherwise cross tenants). Docker-gated — skipped without a daemon.
func TestCopyScopingRefusesForeignContainer(t *testing.T) {
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker not available")
	}
	ctx := context.Background()
	if err := exec.CommandContext(ctx, "docker", "info").Run(); err != nil {
		t.Skip("docker daemon not reachable")
	}

	name := "infradriver-copy-scope-test"
	_ = exec.CommandContext(ctx, "docker", "rm", "-f", name).Run()
	if out, err := exec.CommandContext(ctx, "docker", "run", "-d", "--name", name,
		"--label", "gitops.workspace=ws-a", "busybox", "sleep", "60").CombinedOutput(); err != nil {
		t.Skipf("could not start test container (no busybox image?): %s", out)
	}
	defer exec.CommandContext(context.Background(), "docker", "rm", "-f", name).Run()

	wctx := infradriver.WorkspaceContext{}
	// A driver for a DIFFERENT workspace must refuse both archive directions.
	if _, err := New("ws-b").ContainerCopyOut(ctx, wctx, name, "/etc"); err == nil {
		t.Fatal("cross-workspace copy-out was NOT refused — boundary broken")
	} else if !strings.Contains(err.Error(), "refused") {
		t.Fatalf("unexpected copy-out error: %v", err)
	}
	if err := New("ws-b").ContainerCopyIn(ctx, wctx, name, "/tmp", strings.NewReader("")); err == nil {
		t.Fatal("cross-workspace copy-in was NOT refused — boundary broken")
	} else if !strings.Contains(err.Error(), "refused") {
		t.Fatalf("unexpected copy-in error: %v", err)
	}
}
