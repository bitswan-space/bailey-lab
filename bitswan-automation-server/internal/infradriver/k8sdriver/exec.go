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

func (e execer) Running(ctx context.Context, container string) bool {
	t, err := e.d.target(ctx, container)
	return err == nil && t.state == "running"
}

// WaitReady blocks until the container's own readiness probe passes.
//
// Docker's answer to this is a healthcheck event stream; here it is the
// readiness condition the kubelet already maintains, so the wait is the
// API server's watch rather than a poll — and a workload that declares no
// probe is ready the moment it starts, which is why the compiler synthesises
// one for everything it renders.
func (e execer) WaitReady(ctx context.Context, container string, timeout time.Duration) error {
	t, err := e.d.target(ctx, container)
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "kubectl", "-n", e.d.namespace, "wait",
		"--for=condition=Ready", "pod/"+t.pod, "--timeout="+timeout.String())
	var out strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s did not become ready within %s: %s", container, timeout, strings.TrimSpace(out.String()))
	}
	return nil
}
