package dockerdriver

import (
	"strings"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

// Two non-exposed workers in the same context/stage. Image-based so compile
// needs no on-disk source tree; both inherit the default automation config
// (expose=false, port 8080).
const twoWorkerYAML = `
deployments:
  aworker:
    automation_name: aworker
    context: acme
    stage: dev
    image: "registry/aworker:v1"
  bworker:
    automation_name: bworker
    context: acme
    stage: dev
    image: "registry/bworker:v1"
`

// TestWorkerPortCollisionInFirewallNetns proves the #59 fix: when several
// non-exposed workers share one firewall gateway's network namespace
// (network_mode: service:<gw>), each is handed a DISTINCT listen port so they
// don't both bind :8080 and collide ([Errno 98] Address in use). The resolved
// port is advertised in BITSWAN_WORKER_HOSTS and injected as PORT, so the
// routing entry and the actual listen port stay in sync.
func TestWorkerPortCollisionInFirewallNetns(t *testing.T) {
	bs, err := parseBitswanYAML([]byte(twoWorkerYAML))
	if err != nil {
		t.Fatalf("parseBitswanYAML: %v", err)
	}
	wctx := infradriver.WorkspaceContext{WorkspaceName: "ws", Domain: "example.com"}
	c := newCompileState(wctx, bs)

	// Force the (acme, dev, "") scope through a single shared gateway netns so the
	// two workers must share it — the collision condition the fix resolves.
	gw := "ws-fwgw-acme-dev"
	scope := fwKey{"acme", "dev", ""}
	fwScope := map[fwKey]*fwGroup{scope: {gw: gw, ok: true}}

	hosts, ports := c.computeWorkerHosts(bs.Deployments, fwScope)

	// Workers are visited in sorted depID order (aworker, bworker); both default
	// to :8080, so the second one in scope must shift to :8081.
	if got := ports[workerPortKey{"acme", "dev", "", "aworker"}]; got != 8080 {
		t.Errorf("aworker port = %d; want 8080", got)
	}
	if got := ports[workerPortKey{"acme", "dev", "", "bworker"}]; got != 8081 {
		t.Errorf("bworker port = %d; want 8081 (collision-free)", got)
	}

	// The advertised host:port list must carry the same resolved ports.
	want := map[string]bool{
		"aworker=" + gw + ":8080": true,
		"bworker=" + gw + ":8081": true,
	}
	for _, hp := range hosts[scope] {
		if !want[hp] {
			t.Errorf("unexpected worker host entry %q", hp)
		}
		delete(want, hp)
	}
	if len(want) != 0 {
		t.Errorf("missing worker host entries: %v", want)
	}

	// The shifted port must reach the container as PORT (the listen port the
	// worker template binds).
	entry, _, _, emit, err := c.buildServiceEntry("bworker", bs.Deployments["bworker"], "", 0, hosts, ports, fwScope)
	if err != nil {
		t.Fatalf("buildServiceEntry(bworker): %v", err)
	}
	if !emit {
		t.Fatal("buildServiceEntry(bworker): expected emit=true")
	}
	env := entry["environment"].(map[string]interface{})
	if env["PORT"] != "8081" {
		t.Errorf("bworker PORT = %v; want \"8081\"", env["PORT"])
	}
}

// TestWorkerPortNoFirewallKeepsDeclaredPort proves a non-firewalled worker owns
// its own netns, so it keeps its declared port — no shifting — and advertises
// its own hostname rather than a shared gateway.
func TestWorkerPortNoFirewallKeepsDeclaredPort(t *testing.T) {
	bs, err := parseBitswanYAML([]byte(twoWorkerYAML))
	if err != nil {
		t.Fatalf("parseBitswanYAML: %v", err)
	}
	wctx := infradriver.WorkspaceContext{WorkspaceName: "ws", Domain: "example.com"}
	c := newCompileState(wctx, bs)

	// No firewall scope → each worker owns its netns.
	hosts, ports := c.computeWorkerHosts(bs.Deployments, map[fwKey]*fwGroup{})

	for _, name := range []string{"aworker", "bworker"} {
		if got := ports[workerPortKey{"acme", "dev", "", name}]; got != 8080 {
			t.Errorf("%s port = %d; want 8080 (own netns, no shift)", name, got)
		}
	}
	for _, hp := range hosts[fwKey{"acme", "dev", ""}] {
		if !strings.HasSuffix(hp, ":8080") {
			t.Errorf("worker host %q should keep declared :8080", hp)
		}
		if strings.Contains(hp, "fwgw") {
			t.Errorf("non-firewalled worker %q should not route through a gateway", hp)
		}
	}
}
