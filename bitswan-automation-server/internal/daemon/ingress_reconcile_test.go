package daemon

import (
	"strings"
	"testing"
)

// The ingress reconcile prunes only gitops-managed routes for a workspace.
// listGitopsManagedHosts defines exactly that prune set — so it must include
// gitops routes of the workspace and EXCLUDE manual routes and other
// workspaces, or a reconcile could delete a human-added route.
func TestListGitopsManagedHosts_OnlyManagedThisWorkspace(t *testing.T) {
	ws := "rcws"
	owner := "owner@example.com"

	// A gitops route in this workspace (registered manual, then promoted).
	gitopsHost := ws + "-frontend-bp-production.example.com"
	if _, err := registerEndpoint(gitopsHost, owner, "FE", "", endpointKindFrontend, "production"); err != nil {
		t.Fatalf("register gitops host: %v", err)
	}
	if err := setEndpointSource(gitopsHost, "gitops"); err != nil {
		t.Fatalf("setEndpointSource: %v", err)
	}

	// A MANUAL route in this workspace — must never be in the prune set.
	manualHost := ws + "-handcrafted.example.com"
	if _, err := registerEndpoint(manualHost, owner, "Manual", "", endpointKindService, ""); err != nil {
		t.Fatalf("register manual host: %v", err)
	}

	// A gitops route in a DIFFERENT workspace — out of scope.
	otherHost := "otherws-frontend-bp-production.example.com"
	if _, err := registerEndpoint(otherHost, owner, "Other", "", endpointKindFrontend, "production"); err != nil {
		t.Fatalf("register other host: %v", err)
	}
	if err := setEndpointSource(otherHost, "gitops"); err != nil {
		t.Fatalf("setEndpointSource other: %v", err)
	}

	managed, err := listGitopsManagedHosts(ws)
	if err != nil {
		t.Fatalf("listGitopsManagedHosts: %v", err)
	}

	has := func(h string) bool {
		for _, m := range managed {
			if strings.EqualFold(m, h) {
				return true
			}
		}
		return false
	}

	if !has(gitopsHost) {
		t.Errorf("managed set missing the workspace's gitops route %q: %v", gitopsHost, managed)
	}
	if has(manualHost) {
		t.Errorf("managed set must NOT include the manual route %q (reconcile would prune it): %v", manualHost, managed)
	}
	if has(otherHost) {
		t.Errorf("managed set must NOT include another workspace's route %q: %v", otherHost, managed)
	}
}

// upstreamsEqual ignores the scheme the daemon adds, so an in-sync route isn't
// needlessly re-applied — but a genuinely different/missing upstream is.
func TestUpstreamsEqual(t *testing.T) {
	cases := []struct {
		live, desired string
		want          bool
	}{
		{"http://svc:8080", "svc:8080", true},
		{"http://svc:8080/", "svc:8080", true},
		{"https://svc:8080", "svc:8080", true},
		{"http://svc:8080", "other:8080", false},
		{"", "svc:8080", false}, // missing live route → not in sync → re-apply
		{"http://svc:8080", "", false},
	}
	for _, c := range cases {
		if got := upstreamsEqual(c.live, c.desired); got != c.want {
			t.Errorf("upstreamsEqual(%q,%q)=%v want %v", c.live, c.desired, got, c.want)
		}
	}
}

// registerEndpoint defaults a route to 'manual'; only setEndpointSource makes
// it 'gitops'. Guards the migration default + the promote path.
func TestEndpointSource_DefaultsManualPromotesToGitops(t *testing.T) {
	host := "srcws-app.example.com"
	if _, err := registerEndpoint(host, "o@example.com", "", "", "", ""); err != nil {
		t.Fatalf("register: %v", err)
	}
	ep, err := getEndpoint(host)
	if err != nil || ep == nil {
		t.Fatalf("getEndpoint: %v / %v", ep, err)
	}
	if ep.Source != "manual" {
		t.Errorf("default source = %q, want manual", ep.Source)
	}
	if err := setEndpointSource(host, "gitops"); err != nil {
		t.Fatalf("setEndpointSource: %v", err)
	}
	ep, _ = getEndpoint(host)
	if ep.Source != "gitops" {
		t.Errorf("after promote source = %q, want gitops", ep.Source)
	}
}
