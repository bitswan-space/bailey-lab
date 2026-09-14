package main

import (
	"fmt"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver/dockerdriver"
	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver/k8sdriver"
)

func newDriver(kind string, cf ctxFlags) (infradriver.Driver, error) {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "", "docker":
		return dockerdriver.New(cf.workspace), nil
	case "k8s", "kubernetes":
		return k8sdriver.New(k8sdriver.Options{
			Workspace: cf.workspace,
			Namespace: cf.namespace,
		})
	default:
		return nil, fmt.Errorf("unknown infra driver %q (want docker or k8s)", kind)
	}
}
