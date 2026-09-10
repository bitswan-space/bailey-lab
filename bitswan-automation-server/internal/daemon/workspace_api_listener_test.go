package daemon

import "testing"

func TestWorkspaceAPIServesNoPrivilegedRoute(t *testing.T) {
	registered := map[string]bool{}
	for _, r := range workspaceCallableRoutePatterns() {
		registered[r] = true
	}
	for _, priv := range socketPrivilegedRoutes {
		if registered[priv] {
			t.Fatalf("%s is registered on the workspace listener; it must be unreachable there", priv)
		}
	}
	for _, want := range socketWorkspaceCallableRoutes {
		if !registered[want] {
			t.Fatalf("%s is classified as workspace-callable but is not served", want)
		}
	}
}

func TestWorkspaceAPIRefusesTheWrongToken(t *testing.T) {
	cases := []struct {
		header string
		want   bool
	}{
		{"Bearer secret", true},
		{"Bearer wrong", false},
		{"secret", false},
		{"", false},
		{"Bearer ", false},
	}
	for _, c := range cases {
		if got := bearerEquals(c.header, "secret"); got != c.want {
			t.Fatalf("bearerEquals(%q) = %v, want %v", c.header, got, c.want)
		}
	}
}
