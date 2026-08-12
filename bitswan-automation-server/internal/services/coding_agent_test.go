package services

import (
	"os"
	"path/filepath"
	"testing"

	"gopkg.in/yaml.v3"
)

// TestCodingAgentComposeNetworkIsolation is a security regression guard: the
// coding agent runs untrusted (member-/AI-authored) code and MUST NOT sit on
// bitswan_network (the control-plane inner ring). It must join ONLY the
// dedicated <ws>-agent bridge it shares with gitops. If anyone re-adds
// bitswan_network to the agent compose, this fails.
func TestCodingAgentComposeNetworkIsolation(t *testing.T) {
	c := &CodingAgentService{WorkspaceName: "testws", WorkspacePath: t.TempDir()}
	out, err := c.CreateDockerCompose("secret-token", "", "example.com")
	if err != nil {
		t.Fatalf("CreateDockerCompose: %v", err)
	}

	var compose struct {
		Services map[string]struct {
			Networks    []string `yaml:"networks"`
			Environment []string `yaml:"environment"`
		} `yaml:"services"`
		Networks map[string]struct {
			External bool `yaml:"external"`
		} `yaml:"networks"`
	}
	if err := yaml.Unmarshal([]byte(out), &compose); err != nil {
		t.Fatalf("parse compose: %v\n%s", err, out)
	}

	agent, ok := compose.Services["bitswan-coding-agent"]
	if !ok {
		t.Fatalf("bitswan-coding-agent service missing:\n%s", out)
	}

	// The agent must be on exactly one network: testws-agent — never bitswan_network.
	if len(agent.Networks) != 1 || agent.Networks[0] != "testws-agent" {
		t.Errorf("agent networks = %v; want [testws-agent]", agent.Networks)
	}
	for _, n := range agent.Networks {
		if n == "bitswan_network" {
			t.Errorf("SECURITY REGRESSION: coding agent is on bitswan_network (the control-plane inner ring)")
		}
	}

	// The compose must declare testws-agent (external) and must NOT declare bitswan_network.
	if _, ok := compose.Networks["testws-agent"]; !ok {
		t.Errorf("compose does not declare the testws-agent network:\n%s", out)
	}
	if !compose.Networks["testws-agent"].External {
		t.Errorf("testws-agent should be external:true")
	}
	if _, ok := compose.Networks["bitswan_network"]; ok {
		t.Errorf("SECURITY REGRESSION: agent compose declares bitswan_network")
	}

	// The gitops API endpoint the CLI talks to must be unchanged (still reachable
	// over the shared network by gitops's hostname).
	var haveGitopsURL bool
	for _, e := range agent.Environment {
		if e == "BITSWAN_GITOPS_URL=http://testws-gitops:8079" {
			haveGitopsURL = true
		}
	}
	if !haveGitopsURL {
		t.Errorf("BITSWAN_GITOPS_URL not set to gitops over the shared net; env=%v", agent.Environment)
	}
}

// TestGitopsContainerFilterArgs pins the fix for the agent-start bug: the
// container that gets attached to the <ws>-agent bridge must be ONLY the gitops
// service container. Filtering by gitops.workspace alone also matches every
// automation gitops deploys (live-dev / blue-green / staging app containers,
// garage, postgres, firewall) — many of which share another container's network
// namespace, which Docker refuses to attach an extra network to, aborting the
// whole coding-agent bring-up. The compose-service filter is what pins it.
func TestGitopsContainerFilterArgs(t *testing.T) {
	args := gitopsContainerFilterArgs("myws")
	joined := ""
	for _, a := range args {
		joined += a + " "
	}
	if !contains(args, "label=gitops.workspace=myws") {
		t.Errorf("missing workspace-scope filter; got %q", joined)
	}
	// The load-bearing part: without this, dozens of containers match.
	if !contains(args, "label=com.docker.compose.service=bitswan-gitops") {
		t.Errorf("missing the compose-service filter that isolates gitops; got %q", joined)
	}
}

func contains(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}

// codingAgentWorkspace stands up a workspace on disk that looks ENABLED —
// metadata plus an existing coding-agent compose pinning `image` — and points
// HOME at it, which is where both the service and config.GetWorkspaceMetadata
// resolve paths from.
func codingAgentWorkspace(t *testing.T, name, image string) *CodingAgentService {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	wsPath := filepath.Join(home, ".config", "bitswan", "workspaces", name)
	if err := os.MkdirAll(filepath.Join(wsPath, "deployment"), 0o755); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}
	metadata := "domain: example.com\ngitops-url: http://x\ngitops-secret: s\n" +
		"coding-agent-enabled: true\ncoding-agent-secret: agent-secret\n"
	if err := os.WriteFile(filepath.Join(wsPath, "metadata.yaml"), []byte(metadata), 0o644); err != nil {
		t.Fatalf("write metadata: %v", err)
	}
	compose := "services:\n  bitswan-coding-agent:\n    image: " + image + "\n"
	if err := os.WriteFile(
		filepath.Join(wsPath, "deployment", "docker-compose-coding-agent.yml"),
		[]byte(compose), 0o644,
	); err != nil {
		t.Fatalf("write compose: %v", err)
	}
	return &CodingAgentService{WorkspaceName: name, WorkspacePath: wsPath}
}

func composeImage(t *testing.T, c *CodingAgentService) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(c.WorkspacePath, "deployment", "docker-compose-coding-agent.yml"))
	if err != nil {
		t.Fatalf("read compose: %v", err)
	}
	var compose struct {
		Services map[string]struct {
			Image string `yaml:"image"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(data, &compose); err != nil {
		t.Fatalf("parse compose: %v", err)
	}
	return compose.Services["bitswan-coding-agent"].Image
}

// TestRegenerateDockerComposeHonoursTheDevChannel pins the fix for a workspace
// update putting the coding agent on the WRONG image.
//
// `workspace update --dev` regenerated the agent's compose with an empty
// image, which fell through to the hard-coded "bitswan/coding-agent:latest"
// while gitops, the dashboard and the infra-driver all went to their -dev
// tags. The floating production tag was old enough to predate git being
// installed in the image, so the freshly "updated" agent reported it had no
// git — from an update that had just built and installed a dev image
// containing one.
func TestRegenerateDockerComposeHonoursTheDevChannel(t *testing.T) {
	c := codingAgentWorkspace(t, "testws", "bitswan/coding-agent-staging:2026-1-git-abc")

	if err := c.RegenerateDockerCompose("", false, true); err != nil {
		t.Fatalf("RegenerateDockerCompose: %v", err)
	}

	if got := composeImage(t, c); got != "bitswan/coding-agent-dev:latest" {
		t.Errorf("image = %q; want bitswan/coding-agent-dev:latest", got)
	}
}

// An explicit image always wins — the --coding-agent-image override and the
// callers that pass an already-resolved pin.
func TestRegenerateDockerComposeKeepsAnExplicitImage(t *testing.T) {
	c := codingAgentWorkspace(t, "testws", "bitswan/coding-agent:latest")

	if err := c.RegenerateDockerCompose("registry.example/agent:pinned", false, true); err != nil {
		t.Fatalf("RegenerateDockerCompose: %v", err)
	}

	if got := composeImage(t, c); got != "registry.example/agent:pinned" {
		t.Errorf("image = %q; want registry.example/agent:pinned", got)
	}
}

// CurrentImage is what lets a failed resolution keep the workspace where it
// is instead of reaching for a floating tag: an update that cannot find a
// NEWER image must never install an OLDER one.
func TestCurrentImageReadsTheRunningPin(t *testing.T) {
	c := codingAgentWorkspace(t, "testws", "bitswan/coding-agent-staging:2026-1-git-abc")

	if got := c.CurrentImage(); got != "bitswan/coding-agent-staging:2026-1-git-abc" {
		t.Errorf("CurrentImage() = %q; want the pin in the compose", got)
	}

	// No compose at all (never enabled) is "" — not a guess.
	fresh := &CodingAgentService{WorkspaceName: "nope", WorkspacePath: t.TempDir()}
	if got := fresh.CurrentImage(); got != "" {
		t.Errorf("CurrentImage() on a workspace with no compose = %q; want \"\"", got)
	}
}
