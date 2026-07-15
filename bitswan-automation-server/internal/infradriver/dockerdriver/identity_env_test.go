package dockerdriver

import (
	"path/filepath"
	"testing"

	yaml "gopkg.in/yaml.v3"
)

// Every deployed worker must carry the admin-gating contract: the explicit
// BITSWAN_ADMIN_GROUP override when set, otherwise the platform-convention
// default {BITSWAN_ALLOWED_GROUP}/admin (the default itself is pinned by the
// golden fixtures).
func TestWorkerAdminGroupOverride(t *testing.T) {
	sc := loadScenario(t, "dev")
	root := t.TempDir()
	wctx := buildTree(t, root, sc)

	setEnv(t, "BITSWAN_GITOPS_DIR_HOST", wctx.GitopsDir)
	setEnv(t, "BITSWAN_WORKSPACE_REPO_DIR", filepath.Join(root, "workspace-repo"))
	setEnv(t, "KEYCLOAK_URL", "https://keycloak.example.com/realms/testrealm")
	setEnv(t, "BITSWAN_ALLOWED_GROUP", "/Test Org")
	setEnv(t, "BITSWAN_ADMIN_GROUP", "/Test Org/platform-admins")
	setEnv(t, "BITSWAN_AUTH_MODE", "aoc")
	unsetEnv(t, "BITSWAN_VOLUME_NAME")
	unsetEnv(t, "BITSWAN_CERTS_DIR")

	bs, err := parseBitswanYAML([]byte(sc.BitswanYAML))
	if err != nil {
		t.Fatalf("parseBitswanYAML: %v", err)
	}
	gotYAML, _, _, err := compile(wctx, bs)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	var m map[string]interface{}
	if err := yaml.Unmarshal([]byte(gotYAML), &m); err != nil {
		t.Fatalf("unmarshal compose: %v", err)
	}
	services, _ := m["services"].(map[string]interface{})
	workers := 0
	for name, s := range services {
		sm, _ := s.(map[string]interface{})
		env, _ := sm["environment"].(map[string]interface{})
		if env == nil {
			continue
		}
		// Only worker entries carry the stage marker; infra sidecars
		// (egress gateways) deliberately get no identity env.
		if _, isWorker := env["BITSWAN_AUTOMATION_STAGE"]; !isWorker {
			continue
		}
		workers++
		if got := env["BITSWAN_ADMIN_GROUP"]; got != "/Test Org/platform-admins" {
			t.Errorf("service %s: BITSWAN_ADMIN_GROUP = %v, want the explicit override", name, got)
		}
		if got := env["BITSWAN_ALLOWED_GROUP"]; got != "/Test Org" {
			t.Errorf("service %s: BITSWAN_ALLOWED_GROUP = %v, want /Test Org", name, got)
		}
		if got := env["KEYCLOAK_ISSUER_URL"]; got != "https://keycloak.example.com/realms/testrealm" {
			t.Errorf("service %s: KEYCLOAK_ISSUER_URL = %v, want the full issuer", name, got)
		}
		if got := env["BITSWAN_AUTH_MODE"]; got != "aoc" {
			t.Errorf("service %s: BITSWAN_AUTH_MODE = %v, want aoc", name, got)
		}
	}
	if workers == 0 {
		t.Fatal("scenario compiled to no worker services — test is vacuous")
	}
}
