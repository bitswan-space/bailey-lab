package dockerdriver

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
	yaml "gopkg.in/yaml.v3"
)

// These tests pin the security invariant behind finding F1: in an *enforce*
// realm (staging / production) the egress firewall must actually operate — a
// gateway (fwgw owner + proxy) must be emitted and every worker must share the
// gateway's network namespace (network_mode: service:<gw>). The firewall must
// NOT fail open just because a deployment has no explicit firewall node, runs
// more than one replica, or exposes an ingress port.
//
// They are written to FAIL against the fail-open compiler and pass once it
// fails closed.

// compileScenario compiles an inline scenario, mirroring the environment the
// golden-fixture test uses, and returns the compose services map plus the
// ingress routes.
func compileScenario(t *testing.T, sc scenario) (map[string]map[string]interface{}, []infradriver.Route) {
	t.Helper()
	root := t.TempDir()
	wctx := buildTree(t, root, sc)
	setEnv(t, "BITSWAN_GITOPS_DIR_HOST", wctx.GitopsDir)
	setEnv(t, "BITSWAN_WORKSPACE_REPO_DIR", filepath.Join(root, "workspace-repo"))
	unsetEnv(t, "KEYCLOAK_URL")
	unsetEnv(t, "BITSWAN_VOLUME_NAME")
	unsetEnv(t, "BITSWAN_ALLOWED_GROUP")
	unsetEnv(t, "BITSWAN_CERTS_DIR")

	bs, err := parseBitswanYAML([]byte(sc.BitswanYAML))
	if err != nil {
		t.Fatalf("parseBitswanYAML: %v", err)
	}
	gotYAML, routes, _, err := compile(wctx, bs)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	var doc struct {
		Services map[string]map[string]interface{} `yaml:"services"`
	}
	if err := yaml.Unmarshal([]byte(gotYAML), &doc); err != nil {
		t.Fatalf("unmarshal compose: %v\n%s", err, gotYAML)
	}
	return doc.Services, routes
}

// compileToServices is compileScenario keeping only the services map.
func compileToServices(t *testing.T, sc scenario) map[string]map[string]interface{} {
	t.Helper()
	svcs, _ := compileScenario(t, sc)
	return svcs
}

// fwRole returns the BITSWAN_FW_ROLE of a compose service ("" if not a gateway).
func fwRole(svc map[string]interface{}) string {
	env, ok := svc["environment"].(map[string]interface{})
	if !ok {
		return ""
	}
	role, _ := env["BITSWAN_FW_ROLE"].(string)
	return role
}

// gatewayOwners returns the names of fwgw "owner" services in the compose.
func gatewayOwners(services map[string]map[string]interface{}) []string {
	var out []string
	for name, svc := range services {
		if fwRole(svc) == "owner" {
			out = append(out, name)
		}
	}
	return out
}

// netnsTarget returns the "<gw>" that a worker shares its netns with, or "".
func netnsTarget(svc map[string]interface{}) string {
	nm, _ := svc["network_mode"].(string)
	if strings.HasPrefix(nm, "service:") {
		return strings.TrimPrefix(nm, "service:")
	}
	return ""
}

// stagingScenario builds a two-automation staging (enforce) workspace with NO
// firewall node declared — the exact shape that ships in the golden fixtures.
// mutate lets a test tweak the bitswan.yaml / sources.
func stagingScenario(bitswanYAML string, frontendTOML, backendTOML string) scenario {
	return scenario{
		WorkspaceName: "ws3",
		Domain:        "example.com",
		Sources: []struct {
			Checksum string `json:"checksum"`
			TOML     string `json:"toml"`
		}{
			{Checksum: "fr", TOML: frontendTOML},
			{Checksum: "bk", TOML: backendTOML},
		},
		BitswanYAML: bitswanYAML,
	}
}

const stagingBitswanYAML = `deployments:
  frontend-acme-staging:
    automation_name: frontend
    context: acme
    stage: staging
    checksum: fr
    image: internal/ws3-acme-frontend:shafr
    relative_path: copies/main/acme/frontend
  backend-acme-staging:
    automation_name: backend
    context: acme
    stage: staging
    checksum: bk
    image: internal/ws3-acme-backend:shabk
    relative_path: copies/main/acme/backend
`

const frontendExposeTOML = "[deployment]\nexpose = true\nport = 8080\n"
const backendWorkerTOML = "[deployment]\nexpose = false\nport = 8080\n"

// F1 path 1 — enforce realm, no firewall node: a gateway must still be
// synthesized (default-deny) and the worker must run inside its netns.
func TestEgressFirewall_EnforceWithoutNode_FailsClosed(t *testing.T) {
	svcs := compileToServices(t, stagingScenario(stagingBitswanYAML, frontendExposeTOML, backendWorkerTOML))

	owners := gatewayOwners(svcs)
	if len(owners) == 0 {
		t.Fatalf("enforce realm with no firewall node emitted NO egress gateway — firewall is fail-open; services=%v", keys(svcs))
	}

	// The backend worker (expose=false) must share a gateway's netns.
	backend := findWorker(t, svcs, "backend")
	if gw := netnsTarget(svcs[backend]); gw == "" {
		t.Fatalf("backend worker %q has no network_mode: service:<gw> — egress is not routed through the firewall", backend)
	}
}

// F1 path 2 — replicas>1 must not silently disable the firewall.
func TestEgressFirewall_ReplicasStayFirewalled(t *testing.T) {
	yamlReplicas := strings.Replace(stagingBitswanYAML,
		"    checksum: bk\n",
		"    checksum: bk\n    replicas: 3\n", 1)
	svcs := compileToServices(t, stagingScenario(yamlReplicas, frontendExposeTOML, backendWorkerTOML))

	backend := findWorker(t, svcs, "backend")
	if gw := netnsTarget(svcs[backend]); gw == "" {
		t.Fatalf("backend worker %q with replicas>1 has no network_mode: service:<gw> — firewall fails open for scaled workers", backend)
	}
}

// F1 path 3 — an exposed (ingress) worker still runs tenant code and must have
// its egress filtered, drop NET_ADMIN/NET_RAW, and still be reachable via
// ingress (its route must target the gateway, which owns the stage-net alias).
func TestEgressFirewall_ExposedWorkerFirewalled(t *testing.T) {
	svcs, routes := compileScenario(t, stagingScenario(stagingBitswanYAML, frontendExposeTOML, backendWorkerTOML))

	frontend := findWorker(t, svcs, "frontend")
	gw := netnsTarget(svcs[frontend])
	if gw == "" {
		t.Fatalf("exposed frontend worker %q has no network_mode: service:<gw> — expose=true bypasses the egress firewall", frontend)
	}
	if !dropsCap(svcs[frontend], "NET_ADMIN") {
		t.Fatalf("exposed frontend %q does not cap_drop NET_ADMIN — tenant code could rewrite the firewall", frontend)
	}

	// Ingress must still resolve: the frontend has no network of its own now, so
	// its route upstream must point at the gateway (the netns owner on the stage
	// network), not the frontend's own (unroutable) service name.
	var fr *infradriver.Route
	for i := range routes {
		if routes[i].Kind == "frontend" {
			fr = &routes[i]
			break
		}
	}
	if fr == nil {
		t.Fatalf("no frontend ingress route emitted; routes=%v", routes)
	}
	if !strings.HasPrefix(fr.Upstream, gw+":") {
		t.Fatalf("frontend route upstream %q does not target the gateway %q — ingress would break when firewalled", fr.Upstream, gw)
	}
}

// #311 — the allow-list is DATA in bitswan.yaml, not compiler policy. gitops
// seeds the AOC Keycloak host (from KEYCLOAK_URL) into a BP realm's rules on its
// first deploy; this pins the contract that makes that visible seed effective:
// exactly the `status: allowed` hosts reach the gateway proxy's
// BITSWAN_FW_ALLOW, denied hosts do not, and the compiler adds nothing of its
// own (no wildcard, no host derived from the workspace domain).
func TestEgressFirewall_AllowListComesFromBitswanYAML(t *testing.T) {
	yamlWithRules := stagingBitswanYAML + `firewall:
  acme:
    staging:
      posture: enforce
      rules:
        keycloak.example.com:
          status: allowed
        blocked.example.com:
          status: denied
`
	svcs := compileToServices(t, stagingScenario(yamlWithRules, frontendExposeTOML, backendWorkerTOML))

	var proxies []string
	for name, svc := range svcs {
		if fwRole(svc) != "proxy" {
			continue
		}
		proxies = append(proxies, name)
		env, _ := svc["environment"].(map[string]interface{})
		allow, _ := env["BITSWAN_FW_ALLOW"].(string)
		if allow != "keycloak.example.com" {
			t.Fatalf("proxy %q BITSWAN_FW_ALLOW = %q, want exactly %q (allowed rules only, no extras)",
				name, allow, "keycloak.example.com")
		}
		if strings.Contains(allow, "*") {
			t.Fatalf("proxy %q allow-list contains a wildcard: %q", name, allow)
		}
	}
	if len(proxies) == 0 {
		t.Fatalf("no firewall proxy emitted; services=%v", keys(svcs))
	}
}

// With no firewall node at all the allow-list stays EMPTY — the compiler never
// invents a default host. Seeding is gitops' job (and lands in bitswan.yaml,
// where an operator can see and revoke it), never a hidden compiler bypass.
func TestEgressFirewall_NoNodeMeansEmptyAllowList(t *testing.T) {
	svcs := compileToServices(t, stagingScenario(stagingBitswanYAML, frontendExposeTOML, backendWorkerTOML))
	for name, svc := range svcs {
		if fwRole(svc) != "proxy" {
			continue
		}
		env, _ := svc["environment"].(map[string]interface{})
		if allow, _ := env["BITSWAN_FW_ALLOW"].(string); allow != "" {
			t.Fatalf("proxy %q allow-list is %q with no firewall node — want empty", name, allow)
		}
	}
}

// dropsCap reports whether svc drops the given capability.
func dropsCap(svc map[string]interface{}, cap string) bool {
	cd, ok := svc["cap_drop"].([]interface{})
	if !ok {
		return false
	}
	for _, c := range cd {
		if s, _ := c.(string); s == cap {
			return true
		}
	}
	return false
}

func keys(m map[string]map[string]interface{}) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

// findWorker returns the compose service key for the automation whose name
// contains substr and is not a gateway/proxy/infra service.
func findWorker(t *testing.T, services map[string]map[string]interface{}, substr string) string {
	t.Helper()
	for name := range services {
		if !strings.Contains(name, substr) {
			continue
		}
		if fwRole(services[name]) != "" || strings.Contains(name, "fwgw") {
			continue
		}
		return name
	}
	t.Fatalf("no worker service matching %q; services=%v", substr, keys(services))
	return ""
}
