package main

import (
	"fmt"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver/dockerdriver"
)

// newDriver picks the backend that realizes a workspace declaration.
//
// The factory lives here rather than in internal/infradriver so the package that
// defines the Driver contract never imports an implementation of it: both
// backends depend on the contract, and the contract depends on neither.
//
// An empty kind is docker. That is what makes every deploy repo written before
// the second backend existed keep working with no migration — its git config has
// no bitswan.driver, and reading it back gives the backend it was created with.
func newDriver(kind string, cf ctxFlags) (infradriver.Driver, error) {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "", "docker":
		return dockerdriver.New(cf.workspace), nil
	case "k8s", "kubernetes":
		return nil, fmt.Errorf("the kubernetes backend is not wired up yet")
	default:
		return nil, fmt.Errorf("unknown infra driver %q (want docker or k8s)", kind)
	}
}
