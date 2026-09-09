package daemon

import "testing"

// The privileged routes must be unreachable on the workspace listener, not
// merely refused: they are the ones the socket's trust premise failed on three
// times (#128, #189, #234), and a workspace service is exactly the caller that
// premise was wrong about.
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
	// And the ones a workspace service does call must be there, or a live caller
	// breaks with a 404 that looks like a routing bug.
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
