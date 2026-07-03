package dockerdriver

import (
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// A user-defined per-BP secret must land in the env of the BP's WORKER (backend)
// container and NOT the exposed, browser-reachable frontend — nor any other BP's
// container (the env file is per-(BP, realm)). Compiles the `dev` golden
// scenario (an `acme` BP with a backend worker + an exposed frontend + a dev
// secret) and asserts the scoping on the generated compose.
func TestSecretEnvFileScopedToBackendWorker(t *testing.T) {
	sc := loadScenario(t, "dev")
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
	gotYAML, _, _, err := compile(wctx, bs)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	var doc struct {
		Services map[string]struct {
			EnvFile any                    `yaml:"env_file"`
			Labels  map[string]interface{} `yaml:"labels"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal([]byte(gotYAML), &doc); err != nil {
		t.Fatalf("unmarshal compose: %v", err)
	}

	// The per-BP secret env file for BP "acme", realm "dev".
	const secretMarker = "secrets/bp/acme/dev"
	hasSecretEnv := func(env any) bool {
		switch v := env.(type) {
		case string:
			return strings.Contains(v, secretMarker)
		case []interface{}:
			for _, e := range v {
				if s, ok := e.(string); ok && strings.Contains(s, secretMarker) {
					return true
				}
			}
		}
		return false
	}

	var sawBackend bool
	for name, svc := range doc.Services {
		auto, _ := svc.Labels["gitops.automation_name"].(string)
		ctx, _ := svc.Labels["gitops.context"].(string)
		has := hasSecretEnv(svc.EnvFile)
		switch {
		case ctx == "acme" && auto == "backend":
			if !has {
				t.Errorf("acme backend %q is MISSING the secret env file %q", name, secretMarker)
			}
			sawBackend = true
		case ctx == "acme" && auto == "frontend":
			if has {
				t.Errorf("acme frontend %q has the secret env file %q — secrets must not reach the exposed frontend", name, secretMarker)
			}
		default:
			// Any non-acme (other BP / infra) service must never carry acme's
			// per-BP secret file.
			if has {
				t.Errorf("non-acme service %q (ctx=%q) leaked acme's secret env file %q", name, ctx, secretMarker)
			}
		}
	}
	if !sawBackend {
		t.Fatal("no acme backend service found in the compiled compose")
	}
}
