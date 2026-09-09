package k8sdriver

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"path"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

// Getting bytes in and out of a running container.
//
// `docker cp` is a daemon feature: it needs nothing inside the image, which is
// why the Docker driver can copy out of Garage, whose image is one static
// binary and no shell. Kubernetes has no equivalent — `kubectl cp` is exec plus
// tar, and the tar has to be in the image.
//
// So the tar is put there: the infra workloads stage a static busybox into an
// emptyDir from an init container, and these calls run that. An image that
// happens to ship its own tar still works, because a plain tar is the fallback.

// toolsDir is where the staged busybox lands. Its own volume rather than a
// directory in the image, so nothing in the image is shadowed.
const toolsDir = "/bitswan-tools"

var toolsBusybox = path.Join(toolsDir, "busybox")

// tarArgv is what to run inside the container to read or write a TAR stream.
func (d *K8sDriver) tarArgv(ctx context.Context, t podRef) []string {
	probe := exec.CommandContext(ctx, "kubectl", "-n", d.namespace, "exec",
		t.pod, "-c", t.container, "--", toolsBusybox, "true")
	if err := probe.Run(); err == nil {
		return []string{toolsBusybox, "tar"}
	}
	return []string{"tar"}
}

// ContainerCopyOut streams a TAR of srcPath out of the container, rooted at its
// basename — the same shape `docker cp <c>:<src> -` produces, because that is
// what the caller untars.
func (d *K8sDriver) ContainerCopyOut(ctx context.Context, _ infradriver.WorkspaceContext, container, srcPath string) (io.ReadCloser, error) {
	t, err := d.target(ctx, container)
	if err != nil {
		return nil, err
	}
	src := strings.TrimSuffix(srcPath, "/")
	if src == "" {
		return nil, fmt.Errorf("copy out of %s: no path given", container)
	}
	argv := append(d.tarArgv(ctx, t), "cf", "-", "-C", path.Dir(src), path.Base(src))
	args := append([]string{"-n", d.namespace, "exec", t.pod, "-c", t.container, "--"}, argv...)

	cmd := exec.CommandContext(ctx, "kubectl", args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("copy out of %s:%s: %w", container, srcPath, err)
	}
	return &copyReader{
		r:      stdout,
		cmd:    cmd,
		what:   fmt.Sprintf("copy out of %s:%s", container, srcPath),
		stderr: &stderr,
	}, nil
}

// ContainerCopyIn extracts a TAR read from r into dstPath inside the container.
func (d *K8sDriver) ContainerCopyIn(ctx context.Context, _ infradriver.WorkspaceContext, container, dstPath string, r io.Reader) error {
	t, err := d.target(ctx, container)
	if err != nil {
		return err
	}
	if dstPath == "" {
		return fmt.Errorf("copy into %s: no path given", container)
	}
	argv := append(d.tarArgv(ctx, t), "xf", "-", "-C", dstPath)
	args := append([]string{"-n", d.namespace, "exec", "-i", t.pod, "-c", t.container, "--"}, argv...)

	cmd := exec.CommandContext(ctx, "kubectl", args...)
	cmd.Stdin = r
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("copy into %s:%s: %w: %s", container, dstPath, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// copyReader keeps the exec alive for as long as the caller is reading, and
// turns a non-zero exit into a read error — a truncated backup that reported
// success would be worse than no backup.
type copyReader struct {
	r      io.ReadCloser
	cmd    *exec.Cmd
	what   string
	stderr *strings.Builder
}

func (c *copyReader) Read(p []byte) (int, error) {
	return c.r.Read(p)
}

func (c *copyReader) Close() error {
	c.r.Close()
	if err := c.cmd.Wait(); err != nil {
		return fmt.Errorf("%s: %w: %s", c.what, err, strings.TrimSpace(c.stderr.String()))
	}
	return nil
}
