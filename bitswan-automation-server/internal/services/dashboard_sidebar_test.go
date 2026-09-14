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

func TestAgentSidebarDownloadsWhenNothingSuppliesAnExtension(t *testing.T) {
	t.Setenv("BITSWAN_CLAUDE_EXTENSION_DIR", "")
	out := composeFor(t, "")
	for _, want := range []string{
		"CLAUDE_EXTENSION_PATH=/claude-extension-cache/extension",
		"workspaces/finance/claude-extension",
		"SIDEBAR_CONFIG_ROOT=/claude-config",
		"workspaces/finance/claude-configs",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("compose is missing %q:\n%s", want, out)
		}
	}
	// The read-only bind is for an operator-supplied copy. Mounting it here too
	// would collide with the cache volume the entrypoint downloads into.
	if strings.Contains(out, ":/claude-extension:ro") {
		t.Errorf("nothing supplied an extension, so nothing should be bind-mounted:\n%s", out)
	}
}

func TestAgentSidebarForwardsAPinnedVersion(t *testing.T) {
	t.Setenv("BITSWAN_CLAUDE_EXTENSION_DIR", "")
	t.Setenv("BITSWAN_CLAUDE_CODE_VERSION", "2.1.268")
	if out := composeFor(t, ""); !strings.Contains(out, "CLAUDE_CODE_VERSION=2.1.268") {
		t.Errorf("the daemon's pin must reach the container:\n%s", out)
	}

	// Unset means "use the image's own pin" — forwarding an empty value would
	// override that default with nothing and disable the download.
	t.Setenv("BITSWAN_CLAUDE_CODE_VERSION", "")
	if out := composeFor(t, ""); strings.Contains(out, "CLAUDE_CODE_VERSION") {
		t.Errorf("an unset version must not be forwarded as empty:\n%s", out)
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

func TestAgentSidebarFallsBackWhenTheExtensionDirIsNotThere(t *testing.T) {
	t.Setenv("BITSWAN_CLAUDE_EXTENSION_DIR", "/does/not/exist/claude-extension")
	out := composeFor(t, "")
	// A path that resolves nowhere must not become a mount — Docker would
	// create it as an empty directory and the sidebar would serve nothing.
	// Downloading is the right answer instead.
	if strings.Contains(out, "/does/not/exist/claude-extension:/claude-extension:ro") {
		t.Errorf("a path that resolves nowhere must not be mounted:\n%s", out)
	}
	if !strings.Contains(out, "CLAUDE_EXTENSION_PATH=/claude-extension-cache/extension") {
		t.Errorf("the download path should take over:\n%s", out)
	}
}

func TestExtensionDirVisible(t *testing.T) {
	if !ExtensionDirVisible(t.TempDir()) {
		t.Error("a directory that exists is visible")
	}
	if ExtensionDirVisible("") || ExtensionDirVisible("relative/path") ||
		ExtensionDirVisible("/no/such/extension") {
		t.Error("empty, relative and missing paths are not visible")
	}
}
