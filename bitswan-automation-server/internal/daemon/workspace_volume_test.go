package daemon

import (
	"regexp"
	"strings"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/services"
)

var subpathRe = regexp.MustCompile(`subpath:\s*workspaces/([^/\s]+)/(\S+)`)

func subpathsIn(t *testing.T, compose string) []string {
	t.Helper()
	var found []string
	for _, m := range subpathRe.FindAllStringSubmatch(compose, -1) {
		found = append(found, m[2])
	}
	if len(found) == 0 {
		t.Fatalf("no volume subpaths found in compose:\n%s", compose)
	}
	return found
}

// Docker refuses to start a container whose volume subpath is missing, and a
// workspace whose dashboard cannot start looks like a workspace that never
// finishes creating. So every subpath a generated compose mounts has to be in
// the set the daemon creates first.
func TestEveryMountedSubpathIsCreated(t *testing.T) {
	created := map[string]bool{}
	for _, d := range workspaceVolumeSubdirs {
		created[d] = true
	}

	ext := t.TempDir()
	t.Setenv("BITSWAN_CLAUDE_EXTENSION_DIR", ext)
	dashboard := &services.DashboardService{WorkspaceName: "finance", WorkspacePath: t.TempDir()}
	compose, err := dashboard.CreateDockerComposeWithDevMode("token", "img", false, nil)
	if err != nil {
		t.Fatalf("dashboard compose: %v", err)
	}

	for _, sub := range subpathsIn(t, compose) {
		if !created[sub] {
			t.Errorf("dashboard mounts workspaces/<ws>/%s, which nothing creates — add it to workspaceVolumeSubdirs", sub)
		}
	}
	if !strings.Contains(compose, "claude-configs") {
		t.Errorf("expected the agent chat's config volume in:\n%s", compose)
	}
}
