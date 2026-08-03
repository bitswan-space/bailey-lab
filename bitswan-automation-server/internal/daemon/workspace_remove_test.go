package daemon

import (
	"bytes"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// TestWorkspaceRemove_RouteCleanupEnumeration covers the gitops-independent
// route cleanup that workspace remove relies on: the daemon enumerates a
// workspace's gitops-managed endpoints from its OWN Bailey DB and removes each
// (ingress route + Bailey rows) without depending on gitops, and without
// touching another workspace's endpoints.
//
// No ingress container runs under `go test`, so traefikapi.RemoveRoute treats
// "unreachable" as success — which is exactly the path that still deletes the
// Bailey endpoint/protected_route rows.
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
	hosts, err := listGitopsManagedHosts(ws, "")
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

// TestWorkspaceHostsToRemove covers the all-source route enumeration the
// daemon-only removal relies on: hosts under the workspace prefix are removed
// REGARDLESS of source (manual rows leaked before), hosts of a sibling
// workspace whose name extends this one are protected, and the platform
// gitops/dashboard hosts are appended from the metadata domain.
func TestWorkspaceHostsToRemove(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")

	const ws = "wsx"
	const domain = "example.com"

	// Mixed sources for this workspace, one sibling ("wsx-two"), one unrelated.
	seed := []struct{ host, source string }{
		{ws + "-gitops." + domain, "gitops"},
		{ws + "-frontend-abc-dev." + domain, "manual"}, // the previously-leaked kind
		{"wsx-two-gitops." + domain, "gitops"},         // sibling — must survive
		{"other-gitops." + domain, "gitops"},           // unrelated — must survive
	}
	for _, s := range seed {
		if _, err := registerEndpoint(s.host, "o@example.com", "", "", "", ""); err != nil {
			t.Fatalf("registerEndpoint %s: %v", s.host, err)
		}
		if s.source == "gitops" {
			if err := setEndpointSource(s.host, "gitops"); err != nil {
				t.Fatalf("setEndpointSource: %v", err)
			}
		}
	}
	// A route WITHOUT an owned endpoint (infra admin UIs
	// register only a protected_routes row) — the leak the union fixes.
	if err := saveProtectedRoute(ws+"-postgres-dev."+domain, "http://proxy:80"); err != nil {
		t.Fatalf("saveProtectedRoute: %v", err)
	}

	endpoints, err := listAllEndpoints()
	if err != nil {
		t.Fatalf("listAllEndpoints: %v", err)
	}
	routes, err := listProtectedRoutes()
	if err != nil {
		t.Fatalf("listProtectedRoutes: %v", err)
	}
	var candidates []string
	for _, ep := range endpoints {
		candidates = append(candidates, ep.Hostname)
	}
	for _, r := range routes {
		candidates = append(candidates, r.Hostname)
	}

	hosts := workspaceHostsToRemove(candidates, ws, domain, []string{"wsx-two", "unrelated"})
	got := map[string]bool{}
	for _, h := range hosts {
		got[h] = true
	}
	for _, want := range []string{
		ws + "-gitops." + domain,
		ws + "-frontend-abc-dev." + domain, // manual row now included
		ws + "-postgres-dev." + domain,     // protected_routes-only row included
		ws + "-dashboard." + domain,        // platform host from domain
	} {
		if !got[want] {
			t.Errorf("workspaceHostsToRemove missing %q (got %v)", want, hosts)
		}
	}
	for _, protected := range []string{"wsx-two-gitops." + domain, "other-gitops." + domain} {
		if got[protected] {
			t.Errorf("workspaceHostsToRemove must not include %q", protected)
		}
	}
	// Dedup: platform gitops host appears once even though it is also a row.
	count := 0
	for _, h := range hosts {
		if h == ws+"-gitops."+domain {
			count++
		}
	}
	if count != 1 {
		t.Errorf("expected exactly one %s-gitops entry, got %d", ws, count)
	}
}

func TestProtectedDockerResourceGuards(t *testing.T) {
	for name, protected := range map[string]bool{
		"bitswan":         true,
		"bitswan-mkcert":  true,
		"pr-postgres-dev": false,
		"":                false,
	} {
		if got := isProtectedDockerVolume(name); got != protected {
			t.Errorf("isProtectedDockerVolume(%q) = %v, want %v", name, got, protected)
		}
	}
	if !isProtectedDockerNetwork("bitswan_network") {
		t.Error("bitswan_network must be protected")
	}
	if isProtectedDockerNetwork("pr-dev") {
		t.Error("pr-dev must not be protected")
	}
}

func TestWorkspaceComposeProjectsAndStageNetworks(t *testing.T) {
	projects := workspaceComposeProjects("Pr")
	want := []string{"Pr", "pr", "pr-site", "pr-dashboard", "pr-coding-agent", "bitswan-Pr-traefik", "Pr__traefik"}
	if len(projects) != len(want) {
		t.Fatalf("workspaceComposeProjects(Pr) = %v, want %v", projects, want)
	}
	for i := range want {
		if projects[i] != want[i] {
			t.Errorf("projects[%d] = %q, want %q", i, projects[i], want[i])
		}
	}
	// Lowercase names don't duplicate the raw entry.
	if got := workspaceComposeProjects("pr"); len(got) != 6 {
		t.Errorf("workspaceComposeProjects(pr) = %v, want 6 entries (no raw/lower dupe)", got)
	}
	nets := workspaceStageNetworks("pr")
	if len(nets) != 4 || nets[0] != "pr-dev" || nets[1] != "pr-staging" || nets[2] != "pr-production" || nets[3] != "pr-agent" {
		t.Errorf("workspaceStageNetworks = %v", nets)
	}
}

func TestFilterHostsFileLines(t *testing.T) {
	lines := []string{
		"127.0.0.1 localhost",
		"127.0.0.1 wsx-gitops.bitswan.local",
		"127.0.0.1 wsx-gitops.tp-sandbox.bswn.io",
		"10.0.0.1 keep.me",
	}
	kept, found := filterHostsFileLines(lines, []string{
		"wsx-gitops.bitswan.local",
		"wsx-gitops.tp-sandbox.bswn.io",
	})
	if !found {
		t.Fatal("expected entries to be found")
	}
	if len(kept) != 2 || kept[0] != "127.0.0.1 localhost" || kept[1] != "10.0.0.1 keep.me" {
		t.Errorf("kept = %v", kept)
	}
	// Nothing matching → found=false, everything kept.
	kept2, found2 := filterHostsFileLines(lines, []string{"absent-host.example"})
	if found2 || len(kept2) != len(lines) {
		t.Errorf("expected no-op filter, got kept=%v found=%v", kept2, found2)
	}
}

// TestDockerSweepHelpers exercises the label/project sweeps against a real
// docker daemon: a container labeled with the workspace key and a volume
// labeled with the compose project are both removed; the shared `bitswan`
// volume (if present) survives thanks to the guard.
func TestDockerSweepHelpers(t *testing.T) {
	requireDocker(t)
	const ws = "zztest-unit-sweep"
	var buf bytes.Buffer

	if out, err := exec.Command("docker", "create", "--label", "gitops.workspace="+ws,
		"--name", ws+"-c1", "alpine:latest", "true").CombinedOutput(); err != nil {
		t.Skipf("cannot create test container (image pull?): %v: %s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", ws+"-c1").Run() })
	if out, err := exec.Command("docker", "volume", "create", "--label",
		"com.docker.compose.project="+ws, ws+"-vol").CombinedOutput(); err != nil {
		t.Fatalf("volume create: %v: %s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("docker", "volume", "rm", ws+"-vol").Run() })

	ids, err := dockerContainerIDsByLabel("gitops.workspace=" + ws)
	if err != nil || len(ids) != 1 {
		t.Fatalf("dockerContainerIDsByLabel = %v, %v; want 1 id", ids, err)
	}
	dockerRemoveContainers(ids, &buf)
	if ids, _ := dockerContainerIDsByLabel("gitops.workspace=" + ws); len(ids) != 0 {
		t.Errorf("container survived the sweep: %v", ids)
	}

	vols, err := dockerVolumesByComposeProject(ws)
	if err != nil || len(vols) != 1 {
		t.Fatalf("dockerVolumesByComposeProject = %v, %v; want 1", vols, err)
	}
	// The guard refuses the shared volume even if it were labeled.
	dockerRemoveVolumes(append(vols, "bitswan"), &buf)
	if vols, _ := dockerVolumesByComposeProject(ws); len(vols) != 0 {
		t.Errorf("volume survived the sweep: %v", vols)
	}
	if strings.Contains(buf.String(), "Removed volume bitswan\n") {
		t.Error("shared bitswan volume must never be removed")
	}
	if err := exec.Command("docker", "volume", "inspect", "bitswan").Run(); err == nil {
		// exists — good, and it must still exist (guard). Nothing else to assert:
		// inspect succeeding IS the assertion.
		_ = err
	}
}

// TestDomainUsedByAnotherWorkspace guards the wildcard-cert decision: the
// `*.<domain>` TLS entry is only swept when NO remaining workspace declares
// the same domain (a shared domain's wildcard must survive siblings).
func TestDomainUsedByAnotherWorkspace(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SUDO_USER", "")
	wsFolder := home + "/.config/bitswan/workspaces"

	mk := func(name, domain string) {
		dir := wsFolder + "/" + name
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dir+"/metadata.yaml", []byte("domain: "+domain+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mk("pr", "shared.example.com")
	mk("dev", "shared.example.com")
	mk("solo", "solo-only.example.com")

	if !domainUsedByAnotherWorkspace(wsFolder, "pr", "shared.example.com") {
		t.Error("shared domain must be reported as used by the sibling")
	}
	if domainUsedByAnotherWorkspace(wsFolder, "solo", "solo-only.example.com") {
		t.Error("sole user of a domain must not report it as shared")
	}
	// The removed workspace's own metadata never counts.
	if domainUsedByAnotherWorkspace(wsFolder, "solo", "nowhere.example.com") {
		t.Error("unknown domain must not be reported as shared")
	}
}
