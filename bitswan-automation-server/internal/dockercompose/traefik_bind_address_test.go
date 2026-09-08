package dockercompose

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func traefikPorts(t *testing.T, composeYAML string) []string {
	t.Helper()
	var c struct {
		Services map[string]struct {
			Ports []string `yaml:"ports"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal([]byte(composeYAML), &c); err != nil {
		t.Fatalf("parse compose: %v\n%s", err, composeYAML)
	}
	svc, ok := c.Services["traefik"]
	if !ok {
		t.Fatalf("compose has no traefik service:\n%s", composeYAML)
	}
	return svc.Ports
}

// TestTraefikBindAddressNarrowsThePublish is the whole point of the option: a
// server that is only meant to be reachable over a VPN must not publish its
// ingress on every interface, because Docker's publish DNATs ahead of the host
// firewall and cannot be closed with a ufw rule.
func TestTraefikBindAddressNarrowsThePublish(t *testing.T) {
	compose, err := CreateTraefikDockerComposeFile(t.TempDir(), nil, "10.8.0.7")
	if err != nil {
		t.Fatalf("compose: %v", err)
	}
	ports := traefikPorts(t, compose)
	want := []string{"10.8.0.7:80:80", "10.8.0.7:443:443"}
	if len(ports) != len(want) {
		t.Fatalf("ports = %v, want %v", ports, want)
	}
	for i := range want {
		if ports[i] != want[i] {
			t.Errorf("ports[%d] = %q, want %q", i, ports[i], want[i])
		}
	}
}

// TestTraefikBindAddressDefaultIsByteIdentical guards the upgrade path. The
// daemon compares the rendered compose against the file on disk and recreates
// Traefik on any difference, so an unset bind address must render EXACTLY what
// the previous release wrote — otherwise every existing server bounces its
// ingress on the next daemon boot.
func TestTraefikBindAddressDefaultIsByteIdentical(t *testing.T) {
	compose, err := CreateTraefikDockerComposeFile(t.TempDir(), nil, "")
	if err != nil {
		t.Fatalf("compose: %v", err)
	}
	ports := traefikPorts(t, compose)
	want := []string{"80:80", "443:443"}
	if len(ports) != len(want) {
		t.Fatalf("ports = %v, want %v", ports, want)
	}
	for i := range want {
		if ports[i] != want[i] {
			t.Errorf("ports[%d] = %q, want %q — an unset bind address must not change the render",
				i, ports[i], want[i])
		}
	}
	// And the admin ports stay unpublished whatever the bind address.
	for _, p := range ports {
		if strings.Contains(p, "8080") || strings.Contains(p, "9080") {
			t.Errorf("published an admin port %q", p)
		}
	}
}

func TestTraefikPublishedPorts(t *testing.T) {
	for _, tc := range []struct {
		name string
		addr string
		want []string
	}{
		{"every interface", "", []string{"80:80", "443:443"}},
		{"vpn address", "10.8.0.7", []string{"10.8.0.7:80:80", "10.8.0.7:443:443"}},
		{"loopback", "127.0.0.1", []string{"127.0.0.1:80:80", "127.0.0.1:443:443"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := traefikPublishedPorts(tc.addr)
			if strings.Join(got, ",") != strings.Join(tc.want, ",") {
				t.Errorf("traefikPublishedPorts(%q) = %v, want %v", tc.addr, got, tc.want)
			}
		})
	}
}
