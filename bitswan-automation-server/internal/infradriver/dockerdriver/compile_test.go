package dockerdriver

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
	yaml "gopkg.in/yaml.v3"
)

// scenario mirrors the JSON the Python fixture generator (testdata/*.scenario.json)
// consumes, so the Go test reconstructs the SAME on-disk gitops tree the Python
// reference was generated against (automation.toml source dirs + infra secrets
// files), runs the Go compiler, and asserts structural equivalence with the
// captured Python compose (testdata/*.golden.yaml).
type scenario struct {
	WorkspaceName string `json:"workspace_name"`
	Domain        string `json:"domain"`
	GitopsDirHost string `json:"gitops_dir_host"`
	Sources       []struct {
		Checksum string `json:"checksum"`
		TOML     string `json:"toml"`
	} `json:"sources"`
	SecretsFiles   []string          `json:"secrets_files"`
	SecretsContent map[string]string `json:"secrets_content"`
	BitswanYAML    string            `json:"bitswan_yaml"`
	// WorkspaceRepo maps a path (relative to the workspace-repo root) to file
	// content — automation.toml for live-dev / image-baked deployments.
	WorkspaceRepo map[string]string `json:"workspace_repo"`
}

// buildTree reconstructs the gitops tree under root exactly like the Python
// generator: <root>/gitops/<checksum>/automation.toml source dirs,
// <root>/secrets/<name> infra secrets files, and <root>/gitops/bitswan.yaml.
// Returns the WorkspaceContext the compiler runs against.
func buildTree(t *testing.T, root string, sc scenario) infradriver.WorkspaceContext {
	t.Helper()
	gitops := filepath.Join(root, "gitops")
	secrets := filepath.Join(root, "secrets")
	mustMkdir(t, gitops)
	mustMkdir(t, secrets)

	for _, s := range sc.Sources {
		d := filepath.Join(gitops, s.Checksum)
		mustMkdir(t, d)
		mustWrite(t, filepath.Join(d, "automation.toml"), s.TOML)
	}
	for _, sf := range sc.SecretsFiles {
		content := "DUMMY=1\n"
		if c, ok := sc.SecretsContent[sf]; ok {
			content = c
		}
		mustWrite(t, filepath.Join(secrets, sf), content)
	}
	for rel, content := range sc.WorkspaceRepo {
		p := filepath.Join(root, "workspace-repo", rel)
		mustMkdir(t, filepath.Dir(p))
		mustWrite(t, p, content)
	}
	mustWrite(t, filepath.Join(gitops, "bitswan.yaml"), sc.BitswanYAML)

	return infradriver.WorkspaceContext{
		WorkspaceName: sc.WorkspaceName,
		Domain:        sc.Domain,
		GitopsDir:     gitops,
		SecretsDir:    secrets,
	}
}

func TestCompileGoldenFixtures(t *testing.T) {
	cases := []string{"dev", "bluegreen", "staging", "livedev"}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			sc := loadScenario(t, name)
			root := t.TempDir()
			wctx := buildTree(t, root, sc)

			// Match the Python generator's environment exactly: deterministic,
			// no AOC / keycloak / named volume. gitops_dir_host defaults to the
			// gitops dir (the Python AutomationService default), so bind-mount
			// strings line up.
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

			// The golden fixtures were captured with their absolute gitops/secrets
			// root rewritten to __ROOT__; rewrite the Go output's temp root the
			// same way so the absolute env_file / bind-mount paths line up.
			gotYAML = strings.ReplaceAll(gotYAML, root, "__ROOT__")

			got := normalize(t, []byte(gotYAML))
			want := normalize(t, readGolden(t, name))

			if !reflect.DeepEqual(got, want) {
				t.Errorf("compose mismatch for %s.\n--- got ---\n%s\n--- want ---\n%s",
					name, dumpYAML(got), dumpYAML(want))
			}
		})
	}
}

// normalize parses compose YAML to a generic map and strips the inherently
// non-deterministic BITSWAN_DEPLOY_TIME from every service's environment so the
// structural compare is stable.
func normalize(t *testing.T, data []byte) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	if err := yaml.Unmarshal(data, &m); err != nil {
		t.Fatalf("unmarshal compose: %v", err)
	}
	services, _ := m["services"].(map[string]interface{})
	for _, raw := range services {
		entry, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		if env, ok := entry["environment"].(map[string]interface{}); ok {
			delete(env, "BITSWAN_DEPLOY_TIME")
		}
	}
	return m
}

func loadScenario(t *testing.T, name string) scenario {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name+".scenario.json"))
	if err != nil {
		t.Fatalf("read scenario: %v", err)
	}
	var sc scenario
	if err := json.Unmarshal(data, &sc); err != nil {
		t.Fatalf("parse scenario: %v", err)
	}
	return sc
}

func readGolden(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name+".golden.yaml"))
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	return data
}

func dumpYAML(m map[string]interface{}) string {
	out, _ := yaml.Marshal(m)
	return string(out)
}

func mustMkdir(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
}

func mustWrite(t *testing.T, p, content string) {
	t.Helper()
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func setEnv(t *testing.T, k, v string) {
	t.Helper()
	t.Setenv(k, v)
}

func unsetEnv(t *testing.T, k string) {
	t.Helper()
	// t.Setenv to empty then the compiler treats "" as unset (envOr/Getenv "").
	t.Setenv(k, "")
}
