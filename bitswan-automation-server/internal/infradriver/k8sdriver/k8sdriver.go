// Package k8sdriver realizes a workspace's declaration in one Kubernetes
// namespace.
//
// It is the second implementation of infradriver.Driver. The first compiles
// bitswan.yaml to compose and runs Docker; this one compiles the same
// declaration to Kubernetes objects and applies them to the namespace it runs
// in. Both read the declaration through internal/infradriver/core, so they
// cannot disagree about what it says — only about how to run it.
//
// Scope is a namespace, pinned when the driver is constructed rather than taken
// from a request, exactly as the Docker driver pins its workspace: a compromised
// gitops must not be able to name someone else's. Here the API server enforces
// the boundary too, which is stronger than a label check on a socket that could
// do anything.
package k8sdriver

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
	"github.com/bitswan-space/bitswan-workspaces/internal/k8sctl"
)

// K8sDriver applies a workspace's declaration to one namespace.
type K8sDriver struct {
	workspace string
	namespace string
}

var _ infradriver.Driver = (*K8sDriver)(nil)

// Options is what the driver needs to know about itself. The namespace defaults
// to the one this pod runs in, which is the only one it can act in anyway.
type Options struct {
	Workspace string
	Namespace string
}

func New(opts Options) (*K8sDriver, error) {
	ns := strings.TrimSpace(opts.Namespace)
	if ns == "" {
		resolved, err := k8sctl.Namespace()
		if err != nil {
			return nil, fmt.Errorf("resolve namespace: %w", err)
		}
		ns = resolved
	}
	if strings.TrimSpace(opts.Workspace) == "" {
		return nil, fmt.Errorf("the kubernetes driver needs a workspace to be scoped to")
	}
	return &K8sDriver{workspace: opts.Workspace, namespace: ns}, nil
}

// Apply compiles the declaration and applies it.
func (d *K8sDriver) Apply(ctx context.Context, req infradriver.ApplyRequest, prog func(infradriver.Progress)) ([]infradriver.Route, error) {
	report := func(step, msg string) {
		if prog != nil {
			prog(infradriver.Progress{Step: step, Message: msg})
		}
	}
	return d.apply(ctx, req, report)
}

func (d *K8sDriver) notYet(what string) error {
	return fmt.Errorf("%s is not implemented by the kubernetes driver yet", what)
}

func (d *K8sDriver) ContainerCopyOut(ctx context.Context, req infradriver.WorkspaceContext, container, srcPath string) (io.ReadCloser, error) {
	return nil, d.notYet("copying out of a container")
}

func (d *K8sDriver) ContainerCopyIn(ctx context.Context, req infradriver.WorkspaceContext, container, dstPath string, r io.Reader) error {
	return d.notYet("copying into a container")
}
