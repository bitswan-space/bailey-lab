package dockerdriver

import (
	"strconv"
	"strings"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

const twoFrontendBitswanYAML = `deployments:
  storefront-acme-staging:
    automation_name: storefront
    context: acme
    stage: staging
    checksum: sf
    image: internal/ws3-acme-storefront:shasf
    relative_path: copies/main/acme/storefront
  adminui-acme-staging:
    automation_name: adminui
    context: acme
    stage: staging
    checksum: au
    image: internal/ws3-acme-adminui:shaau
    relative_path: copies/main/acme/adminui
  backend-acme-staging:
    automation_name: backend
    context: acme
    stage: staging
    checksum: bk
    image: internal/ws3-acme-backend:shabk
    relative_path: copies/main/acme/backend
`

func twoFrontendScenario() scenario {
	sc := stagingScenario(twoFrontendBitswanYAML, frontendExposeTOML, backendWorkerTOML)
	sc.Sources[0].Checksum = "sf"
	sc.Sources[1].Checksum = "bk"
	sc.Sources = append(sc.Sources, sc.Sources[0])
	sc.Sources[2].Checksum = "au"
	return sc
}

func TestTwoExposedFrontendsGetDistinctPortsInSharedNetns(t *testing.T) {
	svcs, _ := compileScenario(t, twoFrontendScenario())

	storefront := findWorker(t, svcs, "storefront")
	adminui := findWorker(t, svcs, "adminui")
	backend := findWorker(t, svcs, "backend")

	gw := netnsTarget(svcs[storefront])
	if gw == "" || gw != netnsTarget(svcs[adminui]) {
		t.Fatalf("frontends do not share one netns (%q vs %q); the enforce firewall is not applied to both",
			gw, netnsTarget(svcs[adminui]))
	}

	owner := map[int]string{}
	for _, worker := range []struct {
		service string
		keys    []string
	}{
		{storefront, []string{"PORT", "BITSWAN_UI_PORT"}},
		{adminui, []string{"PORT", "BITSWAN_UI_PORT"}},
		{backend, []string{"PORT"}},
	} {
		for _, key := range worker.keys {
			port := envPort(t, svcs, worker.service, key)
			if taken, clash := owner[port]; clash {
				t.Errorf("%s %s is :%d, already bound by %s inside netns %s — the loser of that race crash-loops on `address already in use`",
					worker.service, key, port, taken, gw)
				continue
			}
			owner[port] = worker.service + " " + key
		}
	}
}

func TestFrontendRoutesTargetTheResolvedListenPort(t *testing.T) {
	svcs, routes := compileScenario(t, twoFrontendScenario())

	for _, automation := range []string{"storefront", "adminui"} {
		service := findWorker(t, svcs, automation)
		listen := envPort(t, svcs, service, "PORT")
		if got := routePort(t, routes, automation); got != listen {
			t.Errorf("%s ingress route targets :%d but the container listens on :%d", automation, got, listen)
		}
	}
}

func envPort(t *testing.T, services map[string]map[string]interface{}, service, key string) int {
	t.Helper()
	env, _ := services[service]["environment"].(map[string]interface{})
	raw, ok := env[key].(string)
	if !ok || raw == "" {
		t.Fatalf("service %q has no %s — nothing tells it which port to bind inside a shared netns", service, key)
	}
	port, err := strconv.Atoi(raw)
	if err != nil {
		t.Fatalf("service %q %s = %q: %v", service, key, raw, err)
	}
	return port
}

func routePort(t *testing.T, routes []infradriver.Route, automation string) int {
	t.Helper()
	for _, r := range routes {
		if r.Kind != "frontend" || !strings.Contains(r.Hostname, automation) {
			continue
		}
		_, portStr, ok := strings.Cut(r.Upstream, ":")
		if !ok {
			t.Fatalf("route %q has no port in upstream %q", r.Hostname, r.Upstream)
		}
		port, err := strconv.Atoi(portStr)
		if err != nil {
			t.Fatalf("route %q upstream %q: %v", r.Hostname, r.Upstream, err)
		}
		return port
	}
	t.Fatalf("no frontend route for automation %q; routes=%v", automation, routes)
	return 0
}
