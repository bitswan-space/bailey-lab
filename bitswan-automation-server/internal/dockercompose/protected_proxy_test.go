package dockercompose

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestCreateProtectedProxyDockerComposeFile(t *testing.T) {
	env := map[string]string{
		"OAUTH2_PROXY_PROVIDER":     "oidc",
		"OAUTH2_PROXY_UPSTREAMS":    "http://bitswan-automation-server-daemon:9080",
		"OAUTH2_PROXY_HTTP_ADDRESS": "0.0.0.0:80",
	}

	out, err := CreateProtectedProxyDockerComposeFile(env)
	if err != nil {
		t.Fatalf("CreateProtectedProxyDockerComposeFile: %v", err)
	}

	var compose struct {
		Services map[string]struct {
			Image         string   `yaml:"image"`
			Restart       string   `yaml:"restart"`
			ContainerName string   `yaml:"container_name"`
			Networks      []string `yaml:"networks"`
			Environment   []string `yaml:"environment"`
			Ports         []string `yaml:"ports"`
			Volumes       []string `yaml:"volumes"`
		} `yaml:"services"`
		Networks map[string]struct {
			External bool `yaml:"external"`
		} `yaml:"networks"`
	}
	if err := yaml.Unmarshal([]byte(out), &compose); err != nil {
		t.Fatalf("rendered compose is not valid YAML: %v\n%s", err, out)
	}

	svc, ok := compose.Services["bitswan-protected-proxy"]
	if !ok {
		t.Fatalf("compose missing bitswan-protected-proxy service:\n%s", out)
	}
	if svc.Image != "quay.io/oauth2-proxy/oauth2-proxy:v7.7.1" {
		t.Errorf("image = %q, want pinned v7.7.1", svc.Image)
	}
	if svc.ContainerName != "bitswan-protected-proxy" {
		t.Errorf("container_name = %q", svc.ContainerName)
	}
	if svc.Restart != "always" {
		t.Errorf("restart = %q, want always", svc.Restart)
	}
	if len(svc.Networks) != 1 || svc.Networks[0] != "bitswan_network" {
		t.Errorf("networks = %v, want [bitswan_network]", svc.Networks)
	}
	// Traefik reaches it over the network — no published ports, no mounts.
	if len(svc.Ports) != 0 {
		t.Errorf("expected no published ports, got %v", svc.Ports)
	}
	if len(svc.Volumes) != 0 {
		t.Errorf("expected no volumes, got %v", svc.Volumes)
	}
	if !compose.Networks["bitswan_network"].External {
		t.Errorf("bitswan_network must be external")
	}

	// Env is rendered sorted for deterministic drift detection.
	joined := strings.Join(svc.Environment, "\n")
	for _, want := range []string{
		"OAUTH2_PROXY_PROVIDER=oidc",
		"OAUTH2_PROXY_UPSTREAMS=http://bitswan-automation-server-daemon:9080",
		"OAUTH2_PROXY_HTTP_ADDRESS=0.0.0.0:80",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("environment missing %q; got:\n%s", want, joined)
		}
	}
}
