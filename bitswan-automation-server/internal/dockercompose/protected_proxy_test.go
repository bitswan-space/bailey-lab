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

	// The proxy's template mount uses the long syntax (a named-volume subpath)
	// while redis's is a short-syntax string, so volumes decode untyped.
	var compose struct {
		Services map[string]struct {
			Image         string        `yaml:"image"`
			Restart       string        `yaml:"restart"`
			ContainerName string        `yaml:"container_name"`
			Networks      []string      `yaml:"networks"`
			Environment   []string      `yaml:"environment"`
			Ports         []string      `yaml:"ports"`
			Volumes       []interface{} `yaml:"volumes"`
		} `yaml:"services"`
		Networks map[string]struct {
			External bool `yaml:"external"`
			Internal bool `yaml:"internal"`
		} `yaml:"networks"`
		Volumes map[string]struct {
			External bool `yaml:"external"`
		} `yaml:"volumes"`
	}
	if err := yaml.Unmarshal([]byte(out), &compose); err != nil {
		t.Fatalf("rendered compose is not valid YAML: %v\n%s", err, out)
	}

	svc, ok := compose.Services["bitswan-protected-proxy"]
	if !ok {
		t.Fatalf("compose missing bitswan-protected-proxy service:\n%s", out)
	}
	if svc.Image != "quay.io/oauth2-proxy/oauth2-proxy:v7.15.3" {
		t.Errorf("image = %q, want pinned v7.15.3", svc.Image)
	}
	if svc.ContainerName != "bitswan-protected-proxy" {
		t.Errorf("container_name = %q", svc.ContainerName)
	}
	if svc.Restart != "always" {
		t.Errorf("restart = %q, want always", svc.Restart)
	}
	// The proxy needs bitswan_network (Traefik + the daemon gate) AND the
	// private session network (redis).
	if len(svc.Networks) != 2 || svc.Networks[0] != "bitswan_network" || svc.Networks[1] != "protected-proxy-session" {
		t.Errorf("networks = %v, want [bitswan_network protected-proxy-session]", svc.Networks)
	}
	// Traefik reaches it over the network — no published ports.
	if len(svc.Ports) != 0 {
		t.Errorf("expected no published ports, got %v", svc.Ports)
	}
	if !compose.Networks["bitswan_network"].External {
		t.Errorf("bitswan_network must be external")
	}

	// The Bailey error page (internal/daemon/protected_proxy_error_page.go) is the
	// proxy's ONLY mount, and it must be a read-only named-volume SUBPATH: the
	// daemon writes it inside the `bitswan` config volume, which has no host path
	// to bind, and the rest of that volume (bailey.db, workspace secrets, this
	// proxy's cookie secret) must stay invisible to the proxy.
	if len(svc.Volumes) != 1 {
		t.Fatalf("proxy should mount exactly its templates, got %v", svc.Volumes)
	}
	mount, ok := svc.Volumes[0].(map[string]interface{})
	if !ok {
		t.Fatalf("templates mount is not a long-syntax mount: %#v", svc.Volumes[0])
	}
	if mount["type"] != "volume" {
		t.Errorf("templates mount type = %v, want volume (a host bind has no source here)", mount["type"])
	}
	if mount["source"] != "bitswan" {
		t.Errorf("templates mount source = %v, want the daemon config volume", mount["source"])
	}
	if mount["target"] != ProtectedProxyTemplatesTarget {
		t.Errorf("templates mount target = %v, want %s", mount["target"], ProtectedProxyTemplatesTarget)
	}
	if mount["read_only"] != true {
		t.Errorf("templates mount must be read-only, got %v", mount["read_only"])
	}
	subOpts, ok := mount["volume"].(map[string]interface{})
	if !ok || subOpts["subpath"] != protectedProxyTemplatesSubpath {
		t.Errorf("templates mount must expose only the %q subpath, got %#v",
			protectedProxyTemplatesSubpath, mount["volume"])
	}
	if !compose.Volumes["bitswan"].External {
		t.Errorf("the daemon config volume must be declared external, got %#v", compose.Volumes)
	}

	// Redis has no auth, so it must be reachable ONLY from the proxy: never on
	// bitswan_network (shared with user-controlled workspace containers), only
	// on the compose-private internal network.
	redis, ok := compose.Services["bitswan-protected-proxy-redis"]
	if !ok {
		t.Fatalf("compose missing bitswan-protected-proxy-redis service:\n%s", out)
	}
	if len(redis.Networks) != 1 || redis.Networks[0] != "protected-proxy-session" {
		t.Errorf("redis networks = %v, want [protected-proxy-session] only", redis.Networks)
	}
	priv, ok := compose.Networks["protected-proxy-session"]
	if !ok {
		t.Fatalf("compose missing protected-proxy-session network:\n%s", out)
	}
	if priv.External || !priv.Internal {
		t.Errorf("protected-proxy-session must be a compose-private internal network (external=%v internal=%v)", priv.External, priv.Internal)
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
