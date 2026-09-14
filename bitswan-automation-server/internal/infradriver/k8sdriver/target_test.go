package k8sdriver

import (
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/k8srender"
)

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
		{"finance__garage-toolbox", "toolbox"},
		{"finance__garage", "finance-garage"},
		{"finance-garage-0/toolbox", "toolbox"},
		{"finance-garage", "finance-garage"},
		{"finance-garage-0", "finance-garage"},
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
