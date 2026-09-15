package daemon

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
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

// The daemon runs as root, but every container mounting these subpaths runs as
// uid 1000. Workspace *creation* chowns the whole bitswan config dir afterwards
// and so masked a root-owned subdir; workspace *update* does not, so any subdir
// a release adds to workspaceVolumeSubdirs reached updated workspaces owned by
// root. That is how `claude-configs` shipped unwritable: the dashboard's sidebar
// drops to uid 1000 and got EACCES creating its per-user Claude config dir, and
// only updated workspaces had a broken coding agent.
func TestEnsureWorkspaceVolumeDirsAreOwnedByUser1000(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("chown to uid 1000 requires root")
	}

	home := t.TempDir()
	t.Setenv("HOME", home)

	ensureWorkspaceVolumeDirs("finance")

	base := filepath.Join(home, ".config", "bitswan", "workspaces", "finance")
	for _, sub := range workspaceVolumeSubdirs {
		info, err := os.Stat(filepath.Join(base, sub))
		if err != nil {
			t.Errorf("%s: not created: %v", sub, err)
			continue
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			t.Fatalf("%s: no stat_t", sub)
		}
		if st.Uid != 1000 || st.Gid != 1000 {
			t.Errorf("%s: owned by %d:%d, want 1000:1000 — containers mounting this subpath run as 1000 and will EACCES", sub, st.Uid, st.Gid)
		}
	}
}
