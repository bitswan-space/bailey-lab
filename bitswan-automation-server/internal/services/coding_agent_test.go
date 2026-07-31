package services

import (
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
