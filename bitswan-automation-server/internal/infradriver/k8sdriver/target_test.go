package k8sdriver

import (
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/k8srender"
)

// TestASidecarResolvesByItsOwnName is the case that broke every snapshot. The
// object store's tooling is a sidecar, gitops addresses it as
// "<container>-toolbox", and the pod's container-name label is one value shared
// by both containers — so matching on the label alone resolved the pod for the
// main container and nothing at all for the sidecar.
func TestASidecarResolvesByItsOwnName(t *testing.T) {
	labels := map[string]string{
		k8srender.ContainerNameLabel: k8srender.LabelValue("finance__garage"),
		k8srender.NameLabel:          "finance-garage",
	}
	main := podRef{pod: "finance-garage-0", container: "finance-garage",
		name: "finance__garage", id: "finance-garage-0/finance-garage", labels: labels}
	side := podRef{pod: "finance-garage-0", container: "toolbox",
		name: "finance__garage-toolbox", id: "finance-garage-0/toolbox", labels: labels}
	all := []podRef{main, side}

	for _, tc := range []struct {
		asked string
		want  string
	}{
		{"finance__garage-toolbox", "toolbox"},  // the sidecar, by its own name
		{"finance__garage", "finance-garage"},   // the service itself
		{"finance-garage-0/toolbox", "toolbox"}, // this driver's own handle
		{"finance-garage", "finance-garage"},    // the Service name
		{"finance-garage-0", "finance-garage"},  // the bare pod
	} {
		got, ok := resolveTarget(all, tc.asked)
		if !ok {
			t.Errorf("%q resolved to nothing", tc.asked)
			continue
		}
		if got.container != tc.want {
			t.Errorf("%q resolved to container %q, want %q", tc.asked, got.container, tc.want)
		}
	}

	if _, ok := resolveTarget(all, "finance__postgres"); ok {
		t.Error("a container of another service resolved; scoping is what stops one workspace reaching another")
	}
}
