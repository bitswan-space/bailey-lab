package daemon

import "testing"

// TestWorkspaceRemove_RouteCleanupEnumeration covers the gitops-independent
// route cleanup that workspace remove relies on: the daemon enumerates a
// workspace's gitops-managed endpoints from its OWN Bailey DB and removes each
// (ingress route + Bailey rows) without depending on gitops, and without
// touching another workspace's endpoints.
//
// No ingress container runs under `go test`, so DetectIngressType() defaults to
// Traefik and traefikapi.RemoveRoute treats "unreachable" as success — which is
// exactly the path that still deletes the Bailey endpoint/protected_route rows.
func TestWorkspaceRemove_RouteCleanupEnumeration(t *testing.T) {
	// Isolate the Bailey DB (it lives under $HOME/.config/bitswan).
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")

	const ws = "wsx"
	const domain = "example.com"
	mine := []string{ws + "-gitops." + domain, ws + "-bp." + domain}
	const other = "other-gitops." + domain

	for _, h := range append(append([]string{}, mine...), other) {
		if _, err := registerEndpoint(h, "owner@example.com", "", "", "", ""); err != nil {
			t.Fatalf("registerEndpoint %s: %v", h, err)
		}
		if err := setEndpointSource(h, "gitops"); err != nil {
			t.Fatalf("setEndpointSource %s: %v", h, err)
		}
	}

	// Enumeration must return exactly this workspace's gitops endpoints.
	hosts, err := listGitopsManagedHosts(ws)
	if err != nil {
		t.Fatalf("listGitopsManagedHosts: %v", err)
	}
	if len(hosts) != len(mine) {
		t.Fatalf("listGitopsManagedHosts(%q) = %v, want the %d %q endpoints", ws, hosts, len(mine), ws)
	}

	// Removing each clears the Bailey rows (ingress unreachable → success path).
	for _, h := range hosts {
		if err := removeRouteFromIngress(h); err != nil {
			t.Fatalf("removeRouteFromIngress %s: %v", h, err)
		}
	}
	for _, h := range mine {
		if ep, _ := getEndpoint(h); ep != nil {
			t.Errorf("endpoint %s should have been removed, still present", h)
		}
	}
	// A different workspace's endpoint must be untouched.
	if ep, _ := getEndpoint(other); ep == nil {
		t.Errorf("unrelated endpoint %s was wrongly removed", other)
	}
}
