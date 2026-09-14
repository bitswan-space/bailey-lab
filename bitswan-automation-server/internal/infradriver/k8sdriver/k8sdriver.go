package k8sdriver

import (
	"context"
	"fmt"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
	"github.com/bitswan-space/bitswan-workspaces/internal/k8sctl"
)

type K8sDriver struct {
	workspace string
	namespace string
}

var _ infradriver.Driver = (*K8sDriver)(nil)

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

func (d *K8sDriver) Apply(ctx context.Context, req infradriver.ApplyRequest, prog func(infradriver.Progress)) ([]infradriver.Route, error) {
	report := func(step, msg string) {
		if prog != nil {
			prog(infradriver.Progress{Step: step, Message: msg})
		}
	}
	return d.apply(ctx, req, report)
}
