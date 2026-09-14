package services

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The coding-agent installs the Claude Code CLI at startup and the dashboard
// downloads the matching VS Code extension. The two must be the same version:
// the dashboard's extension host reads the extension's own compiled artifacts
// (a regex over the webview bundle, theme variables derived from its
// stylesheet), so an extension built against a different Claude Code than the
// CLI it drives can break the panel in ways nothing else catches.
//
// Three places spell the version, and nothing at runtime would notice them
// diverging — a drifted pair just produces a subtly broken sidebar on a machine
// someone else owns. So check it here, where it costs nothing.
func TestClaudeCodeVersionIsPinnedConsistently(t *testing.T) {
	root := repoRoot(t)

	want := strings.TrimSpace(readFile(t, filepath.Join(root, "CLAUDE_CODE_VERSION")))
	if want == "" {
		t.Fatal("repo-root CLAUDE_CODE_VERSION is empty")
	}

	for _, dockerfile := range []string{
		filepath.Join(root, "bitswan-coding-agent", "Dockerfile"),
		filepath.Join(root, "bitswan-workspace-dashboard", "Dockerfile"),
	} {
		got := argDefault(t, readFile(t, dockerfile), "CLAUDE_CODE_VERSION")
		if got != want {
			t.Errorf("%s pins CLAUDE_CODE_VERSION=%s, but CLAUDE_CODE_VERSION says %s\n"+
				"the CLI and the extension must be the same build — update both, or neither",
				dockerfile, got, want)
		}
	}
}

var argDefaultRe = regexp.MustCompile(`(?m)^ARG\s+([A-Z_]+)=(\S+)\s*$`)

func argDefault(t *testing.T, dockerfile, name string) string {
	t.Helper()
	for _, m := range argDefaultRe.FindAllStringSubmatch(dockerfile, -1) {
		if m[1] == name {
			return m[2]
		}
	}
	t.Fatalf("no `ARG %s=<default>` found", name)
	return ""
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

// repoRoot walks up from the package directory to the directory holding
// CLAUDE_CODE_VERSION, so the test does not care how deep in the module it sits.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "CLAUDE_CODE_VERSION")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("no CLAUDE_CODE_VERSION found in any parent directory")
		}
		dir = parent
	}
}
