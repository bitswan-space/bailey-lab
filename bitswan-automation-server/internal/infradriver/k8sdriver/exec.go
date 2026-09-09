package k8sdriver

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver/core"
)

// execer is how the shared provisioner reaches into this namespace's
// containers. The provisioning itself — the role SQL, the blue/green clone, the
// bucket grants — is the same code the Docker driver runs; what differs is that
// a command is delivered by the API server rather than by a daemon socket.
type execer struct{ d *K8sDriver }

var _ core.Execer = execer{}

func (e execer) Exec(ctx context.Context, container string, args ...string) (string, string, int) {
	t, err := e.d.target(ctx, container)
	if err != nil {
		return "", err.Error(), -1
	}
	full := append([]string{"-n", e.d.namespace, "exec", t.pod, "-c", t.container, "--"}, args...)
	cmd := exec.CommandContext(ctx, "kubectl", full...)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	rc := 0
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			rc = ee.ExitCode()
		} else {
			rc = -1
		}
	}
	return stdout.String(), stderr.String(), rc
}

// Running reports whether the service is up or on its way.
//
// On Docker a container exists the instant compose returns, so "is it running"
// and "was it asked for" are the same question. Here they are seconds apart,
// and the provisioner uses this as a gate before a step that has its own
// readiness wait inside it — so answering "no" for a workload the same apply
// just created skips provisioning entirely and leaves a business process
// without the bucket it was about to be given.
//
// So a declared workload with at least one desired replica counts, and the
// waiting is left to the step that knows how long it is willing to wait.
func (e execer) Running(ctx context.Context, container string) bool {
	if t, err := e.d.target(ctx, container); err == nil {
		return t.state == "running"
	}
	return e.d.workloadWanted(ctx, container)
}

// WaitReady blocks until the container's own readiness probe passes.
//
// Docker's answer to this is a healthcheck event stream; here it is the
// readiness condition the kubelet already maintains, so the wait is the
// API server's watch rather than a poll — and a workload that declares no
// probe is ready the moment it starts, which is why the compiler synthesises
// one for everything it renders.
func (e execer) WaitReady(ctx context.Context, container string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)

	// A pod that does not exist yet is the normal case, not an error: the
	// StatefulSet was created moments ago by the same apply that is now
	// provisioning into it, and the scheduler has not caught up. Refusing here
	// reported a database as "not a container of this workspace", which reads
	// as a scoping failure rather than as a wait that was never done.
	var t podRef
	for {
		found, err := e.d.target(ctx, container)
		if err == nil {
			t = found
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s never appeared within %s: %w", container, timeout, err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}

	left := time.Until(deadline)
	if left < 5*time.Second {
		left = 5 * time.Second
	}
	cmd := exec.CommandContext(ctx, "kubectl", "-n", e.d.namespace, "wait",
		"--for=condition=Ready", "pod/"+t.pod, "--timeout="+left.String())
	var out strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s did not become ready within %s: %s", container, timeout, strings.TrimSpace(out.String()))
	}
	return nil
}
