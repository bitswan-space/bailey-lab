package services

import (
	"testing"

	"gopkg.in/yaml.v3"
)

// Where a conversation lives, and who can find it again.
//
// Claude Code writes each conversation to
// $CLAUDE_CONFIG_DIR/projects/<cwd with its slashes flattened>/<uuid>.jsonl.
// The CLI runs in the coding-agent container; the sidebar's extension host,
// which lists a BP's history by reading that directory itself, runs in the
// dashboard container. Two things therefore have to line up across the two
// composes, and when either drifts the panel shows an empty history for a BP
// full of conversations and can resume none of them:
//
//  1. both containers mount the same claude-configs subpath at /claude-config;
//  2. the dashboard can name the BP clone the way the agent's cwd does,
//     /workspace/copies/<copy>/<bp>.
//
// Neither failure is visible in a log — the directory simply isn't there — so
// they are pinned here.

type composeVolume struct {
	Source string `yaml:"source"`
	Target string `yaml:"target"`
	Volume struct {
		Subpath string `yaml:"subpath"`
	} `yaml:"volume"`
}

type composeFile struct {
	Services map[string]struct {
		Environment []string        `yaml:"environment"`
		Volumes     []composeVolume `yaml:"volumes"`
	} `yaml:"services"`
}

func parseCompose(t *testing.T, out string) composeFile {
	t.Helper()
	var parsed composeFile
	if err := yaml.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("unmarshal compose: %v\n%s", err, out)
	}
	return parsed
}

// subpathAt returns the volume subpath mounted at target, or "" when nothing is.
func subpathAt(t *testing.T, out, service, target string) string {
	t.Helper()
	svc, ok := parseCompose(t, out).Services[service]
	if !ok {
		t.Fatalf("compose has no service %q:\n%s", service, out)
	}
	for _, v := range svc.Volumes {
		if v.Target == target {
			return v.Volume.Subpath
		}
	}
	return ""
}

func TestBothContainersShareOneClaudeConfigDir(t *testing.T) {
	t.Setenv("BITSWAN_CLAUDE_EXTENSION_DIR", "")

	agent := &CodingAgentService{WorkspaceName: "finance", WorkspacePath: t.TempDir()}
	agentOut, err := agent.CreateDockerCompose("secret", "", "example.com")
	if err != nil {
		t.Fatalf("CreateDockerCompose: %v", err)
	}

	dashboard := subpathAt(t, composeFor(t, ""), "bitswan-dashboard", "/claude-config")
	codingAgent := subpathAt(t, agentOut, "bitswan-coding-agent", "/claude-config")

	if dashboard == "" {
		t.Fatal("the dashboard must mount the per-user Claude config dirs")
	}
	if codingAgent == "" {
		t.Fatal("the coding agent must mount the per-user Claude config dirs; " +
			"without it the CLI writes transcripts the sidebar can never list")
	}
	if dashboard != codingAgent {
		t.Errorf("the two containers must share one directory, got %q and %q", dashboard, codingAgent)
	}
	if want := "workspaces/finance/claude-configs"; dashboard != want {
		t.Errorf("claude config subpath = %q, want %q", dashboard, want)
	}
}

func TestDashboardSeesCopiesWhereTheAgentDoes(t *testing.T) {
	t.Setenv("BITSWAN_CLAUDE_EXTENSION_DIR", "")
	out := composeFor(t, "")

	agentPath := subpathAt(t, out, "bitswan-dashboard", "/workspace/copies")
	if agentPath == "" {
		t.Fatal("the dashboard must also see the copies tree at the agent's own path, " +
			"or the extension host derives a different transcript directory name")
	}
	if own := subpathAt(t, out, "bitswan-dashboard", "/workspace/workspace/copies"); own != agentPath {
		t.Errorf("both mounts must be the same tree, got %q and %q", own, agentPath)
	}

	svc := parseCompose(t, out).Services["bitswan-dashboard"]
	var found bool
	for _, e := range svc.Environment {
		if e == "SIDEBAR_COPIES_ROOT=/workspace/copies" {
			found = true
		}
	}
	if !found {
		t.Errorf("the sidebar must be pointed at that path:\n%v", svc.Environment)
	}
}
