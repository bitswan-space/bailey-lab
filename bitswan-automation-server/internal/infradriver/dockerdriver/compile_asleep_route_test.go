package dockerdriver

import (
	"path/filepath"
	"strings"
	"testing"

	yaml "gopkg.in/yaml.v3"
)

func compileScenarioWithAsleep(t *testing.T, name string, asleepDepIDs ...string) (services map[string]interface{}, hosts []string) {
	t.Helper()
	sc := loadScenario(t, name)
	root := t.TempDir()
	wctx := buildTree(t, root, sc)
	setEnv(t, "BITSWAN_GITOPS_DIR_HOST", wctx.GitopsDir)
	setEnv(t, "BITSWAN_WORKSPACE_REPO_DIR", filepath.Join(root, "workspace-repo"))
	setEnv(t, "KEYCLOAK_URL", "https://keycloak.example.com/realms/testrealm")
	setEnv(t, "BITSWAN_ALLOWED_GROUP", "/Test Org")
	setEnv(t, "BITSWAN_AUTH_MODE", "aoc")
	unsetEnv(t, "BITSWAN_ADMIN_GROUP")
	unsetEnv(t, "BITSWAN_VOLUME_NAME")
	unsetEnv(t, "BITSWAN_CERTS_DIR")

	bs, err := parseBitswanYAML([]byte(sc.BitswanYAML))
	if err != nil {
		t.Fatalf("parseBitswanYAML: %v", err)
	}
	asleep := false
	for _, depID := range asleepDepIDs {
		conf := bs.Deployments[depID]
		if conf == nil {
			t.Fatalf("scenario %s has no deployment %q", name, depID)
		}
		conf.Active = &asleep
	}

	composeYAML, routes, _, err := compile(wctx, bs)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	var dc struct {
		Services map[string]interface{} `yaml:"services"`
	}
	if err := yaml.Unmarshal([]byte(composeYAML), &dc); err != nil {
		t.Fatalf("unmarshal compose: %v", err)
	}
	for _, r := range routes {
		hosts = append(hosts, r.Hostname)
	}
	return dc.Services, hosts
}

func TestAsleepDeploymentCostsNothingButKeepsItsIngressRoute(t *testing.T) {
	cases := []struct {
		scenario  string
		depID     string
		service   string
		wantHosts []string
	}{
		{
			scenario:  "bluegreen",
			depID:     "frontend-shop",
			service:   "frontend",
			wantHosts: []string{"ws2-frontend-8d90-production.example.com"},
		},
		{
			scenario:  "dev",
			depID:     "frontend-acme-dev",
			service:   "frontend",
			wantHosts: []string{"ws1-frontend-822b-dev.example.com"},
		},
	}
	for _, c := range cases {
		t.Run(c.scenario, func(t *testing.T) {
			awakeServices, awakeHosts := compileScenarioWithAsleep(t, c.scenario)
			for _, want := range c.wantHosts {
				if !containsHost(awakeHosts, want) {
					t.Fatalf("scenario %s does not route %q even while awake (got %v) — "+
						"the test's expected host is wrong, not the compiler",
						c.scenario, want, awakeHosts)
				}
			}
			if !hasServiceContaining(awakeServices, c.service) {
				t.Fatalf("scenario %s emits no %q service while awake (got %v)",
					c.scenario, c.service, serviceNames(awakeServices))
			}

			asleepServices, asleepHosts := compileScenarioWithAsleep(t, c.scenario, c.depID)

			if hasServiceContaining(asleepServices, c.service) {
				t.Errorf("asleep %s still compiles a %q compose service (%v) — "+
					"an asleep deployment must cost nothing",
					c.depID, c.service, serviceNames(asleepServices))
			}
			for _, want := range c.wantHosts {
				if !containsHost(asleepHosts, want) {
					t.Errorf("asleep %s drops its ingress route %q (routes left: %v). "+
						"Every later apply of this business process POSTs these routes to "+
						"/ingress/reconcile as the COMPLETE desired set, so the daemon prunes "+
						"the missing host and the ingress answers Traefik's no-such-router "+
						"404. The gate's wake-on-access only fires on a 5xx and the request no "+
						"longer reaches the gate at all, so a sleeping on-demand automation "+
						"becomes permanently unreachable instead of auto-waking (#424)",
						c.depID, want, asleepHosts)
				}
			}
		})
	}
}

func containsHost(hosts []string, want string) bool {
	for _, h := range hosts {
		if strings.EqualFold(h, want) {
			return true
		}
	}
	return false
}

func hasServiceContaining(services map[string]interface{}, needle string) bool {
	for name := range services {
		if strings.Contains(name, needle) {
			return true
		}
	}
	return false
}

func serviceNames(services map[string]interface{}) []string {
	names := make([]string, 0, len(services))
	for name := range services {
		names = append(names, name)
	}
	return names
}
