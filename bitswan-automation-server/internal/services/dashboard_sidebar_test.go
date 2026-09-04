package services

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func composeFor(t *testing.T, devSourceDir string) string {
	t.Helper()
	d := &DashboardService{WorkspaceName: "finance", WorkspacePath: t.TempDir()}
	var dev *DashboardDevConfig
	if devSourceDir != "" {
		dev = &DashboardDevConfig{SourceDir: devSourceDir}
	}
	out, err := d.CreateDockerComposeWithDevMode("token", "bitswan/workspace-dashboard:latest", false, dev)
	if err != nil {
		t.Fatalf("CreateDockerComposeWithDevMode: %v", err)
	}
	return out
}

func TestAgentSidebarOffWithoutAnExtension(t *testing.T) {
	t.Setenv("BITSWAN_CLAUDE_EXTENSION_DIR", "")
	out := composeFor(t, "")
	if strings.Contains(out, "CLAUDE_EXTENSION_PATH") {
		t.Errorf("no extension anywhere, so the sidebar must stay off:\n%s", out)
	}
}

func TestAgentSidebarFromTheDaemonEnvironment(t *testing.T) {
	ext := t.TempDir()
	t.Setenv("BITSWAN_CLAUDE_EXTENSION_DIR", ext)
	t.Setenv("ANTHROPIC_BASE_URL", "http://bitswan-e2e-mock-anthropic:8790")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "sk-ant-e2e-mock")
	out := composeFor(t, "")
	for _, want := range []string{
		ext + ":/claude-extension:ro",
		"CLAUDE_EXTENSION_PATH=/claude-extension",
		"SIDEBAR_CONFIG_ROOT=/claude-config",
		"workspaces/finance/claude-configs",
		"ANTHROPIC_BASE_URL=http://bitswan-e2e-mock-anthropic:8790",
		"ANTHROPIC_AUTH_TOKEN=sk-ant-e2e-mock",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("compose is missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "ANTHROPIC_API_KEY") {
		t.Errorf("an unset ANTHROPIC_API_KEY must not be forwarded as empty:\n%s", out)
	}
}

func TestAgentSidebarPrefersTheDevSourceTree(t *testing.T) {
	hostExt := t.TempDir()
	devSource := t.TempDir()
	if err := os.MkdirAll(filepath.Join(devSource, ".claude-extension"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BITSWAN_CLAUDE_EXTENSION_DIR", hostExt)
	out := composeFor(t, devSource)
	if !strings.Contains(out, "CLAUDE_EXTENSION_PATH=/workspace/dashboard-src/.claude-extension") {
		t.Errorf("dev mode should host the extension it can hot-reload:\n%s", out)
	}
	if strings.Contains(out, hostExt+":/claude-extension:ro") {
		t.Errorf("the read-only mount is redundant once the dev tree carries one:\n%s", out)
	}
}
