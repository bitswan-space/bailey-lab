package k8sdriver

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver/core"
)

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
	if t, err := e.d.target(ctx, container); err == nil {
		return t.state == "running"
	}
	return e.d.workloadWanted(ctx, container)
}

func (e execer) WaitReady(ctx context.Context, container string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)

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
