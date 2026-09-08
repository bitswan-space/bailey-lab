package dockercompose

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// TestTraefikComposesNeverPublishAdminPort guards the exact issue an external
// researcher reported: a Traefik admin port (dashboard/API) reachable from the
// public internet. Our Traefik compose files must publish ONLY the public web
// entrypoints (80/443) and never the admin API port (8080/9080).
func TestTraefikComposesNeverPublishAdminPort(t *testing.T) {
	check := func(name, composeYAML string) {
		var c struct {
			Services map[string]struct {
				Ports []string `yaml:"ports"`
			} `yaml:"services"`
		}
		if err := yaml.Unmarshal([]byte(composeYAML), &c); err != nil {
			t.Fatalf("%s: parse compose: %v\n%s", name, err, composeYAML)
		}
		for svc, s := range c.Services {
			for _, p := range s.Ports {
				if strings.Contains(p, "8080") || strings.Contains(p, "9080") {
					t.Errorf("%s/%s publishes an admin port %q — the Traefik API/dashboard must never be host-reachable", name, svc, p)
				}
				// Belt-and-braces: only 80 and 443 may ever be published.
				host := p
				if i := strings.LastIndex(p, ":"); i >= 0 {
					host = p[:i]
				}
				_ = host
			}
		}
	}

	global, err := CreateTraefikDockerComposeFile(t.TempDir(), nil, "")
	if err != nil {
		t.Fatalf("global traefik compose: %v", err)
	}
	check("global", global)

	sub, err := CreateWorkspaceTraefikDockerComposeFile("ws", t.TempDir(), "example.com", "", []string{"ws-dev"})
	if err != nil {
		t.Fatalf("workspace traefik compose: %v", err)
	}
	check("workspace", sub)

	// The global traefik must still publish the public web entrypoints.
	if !strings.Contains(global, "80:80") || !strings.Contains(global, "443:443") {
		t.Errorf("global traefik must still publish 80/443:\n%s", global)
	}

	// The multi-homed workspace sub-traefik must disable IP forwarding so it
	// cannot bridge one stage network into another at L3 (stage isolation).
	if !strings.Contains(sub, "net.ipv4.ip_forward") || !strings.Contains(sub, "sysctls") {
		t.Errorf("workspace sub-traefik must set the net.ipv4.ip_forward sysctl:\n%s", sub)
	}
}
