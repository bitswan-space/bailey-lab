package dockerdriver

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

// Issue #134: the deployment record (bitswan.yaml) is tenant-writable — the
// gitops deploy route persists `checksum` / `relative_path` verbatim — and the
// compiler joins those strings onto gitopsDirHost / workspaceDir to build the
// SOURCE of read-only bind-mounts. These tests pin the containment invariant:
// a deployment record must never be able to point a mount source outside the
// gitops / workspace roots, neither lexically (`..`) nor via a symlink.

// containmentTree builds a minimal gitops tree with one valid materialized
// source (goodsum) and the given bitswan.yaml, and pins the env so mounts are
// emitted as host bind strings (no named volume).
func containmentTree(t *testing.T, bitswanYAML string) (infradriver.WorkspaceContext, string) {
	t.Helper()
	root := t.TempDir()
	gitops := filepath.Join(root, "gitops")
	secrets := filepath.Join(root, "secrets")
	mustMkdir(t, filepath.Join(gitops, "goodsum"))
	mustWrite(t, filepath.Join(gitops, "goodsum", "automation.toml"),
		"[deployment]\nexpose = false\nport = 8080\n")
	mustMkdir(t, secrets)
	mustMkdir(t, filepath.Join(root, "workspace-repo"))
	// A directory that exists but lies OUTSIDE the gitops root — the escape
	// target the malicious records below point at.
	mustMkdir(t, filepath.Join(root, "outside"))
	mustWrite(t, filepath.Join(root, "outside", "host-secret"), "s3cret\n")
	mustWrite(t, filepath.Join(gitops, "bitswan.yaml"), bitswanYAML)

	setEnv(t, "BITSWAN_GITOPS_DIR_HOST", gitops)
	setEnv(t, "BITSWAN_WORKSPACE_REPO_DIR", filepath.Join(root, "workspace-repo"))
	unsetEnv(t, "BITSWAN_VOLUME_NAME")
	unsetEnv(t, "BITSWAN_CERTS_DIR")
	unsetEnv(t, "KEYCLOAK_URL")
	unsetEnv(t, "BITSWAN_ALLOWED_GROUP")

	return infradriver.WorkspaceContext{
		WorkspaceName: "ws1",
		Domain:        "example.com",
		GitopsDir:     gitops,
		SecretsDir:    secrets,
	}, root
}

func compileErr(t *testing.T, wctx infradriver.WorkspaceContext, bsYAML string) (string, error) {
	t.Helper()
	bs, err := parseBitswanYAML([]byte(bsYAML))
	if err != nil {
		t.Fatalf("parseBitswanYAML: %v", err)
	}
	out, _, _, err := compile(wctx, bs)
	return out, err
}

// A `..` checksum must be rejected, not joined into a mount source. Before the
// fix this compiled successfully (the escape target exists, so the existence
// check passed) and emitted a bind-mount of a path outside the gitops root.
func TestMountSourceRejectsDotDotChecksum(t *testing.T) {
	bsYAML := "deployments:\n" +
		"  app-dev:\n" +
		"    automation_name: app\n" +
		"    stage: dev\n" +
		"    checksum: ../outside\n"
	wctx, _ := containmentTree(t, bsYAML)
	out, err := compileErr(t, wctx, bsYAML)
	if err == nil {
		t.Fatalf("compile accepted a ..-escaping checksum; compose:\n%s", out)
	}
	if !strings.Contains(err.Error(), "not contained") {
		t.Fatalf("expected containment error, got: %v", err)
	}
}

// A deeply traversing checksum aimed at a real host path must be rejected too.
func TestMountSourceRejectsHostPathChecksum(t *testing.T) {
	bsYAML := "deployments:\n" +
		"  app-dev:\n" +
		"    automation_name: app\n" +
		"    stage: dev\n" +
		"    checksum: ../../../../../../../../etc\n"
	wctx, _ := containmentTree(t, bsYAML)
	out, err := compileErr(t, wctx, bsYAML)
	if err == nil {
		t.Fatalf("compile accepted a host-escaping checksum; compose:\n%s", out)
	}
	if !strings.Contains(err.Error(), "not contained") {
		t.Fatalf("expected containment error, got: %v", err)
	}
}

// A symlink planted inside the gitops tree must not redirect the mount source
// outside it: the lexical join is contained, so only the realpath re-check
// catches this.
func TestMountSourceRejectsSymlinkEscape(t *testing.T) {
	bsYAML := "deployments:\n" +
		"  app-dev:\n" +
		"    automation_name: app\n" +
		"    stage: dev\n" +
		"    checksum: evil\n"
	wctx, root := containmentTree(t, bsYAML)
	if err := os.Symlink(filepath.Join(root, "outside"), filepath.Join(wctx.GitopsDir, "evil")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	out, err := compileErr(t, wctx, bsYAML)
	if err == nil {
		t.Fatalf("compile accepted a symlinked checksum escaping the gitops root; compose:\n%s", out)
	}
	if !strings.Contains(err.Error(), "resolves outside") {
		t.Fatalf("expected realpath containment error, got: %v", err)
	}
}

// The live-dev variant builds its mount source from relative_path — the same
// containment must hold there.
func TestLiveDevRejectsDotDotRelativePath(t *testing.T) {
	bsYAML := "deployments:\n" +
		"  app-copy-main-live-dev:\n" +
		"    automation_name: app\n" +
		"    stage: live-dev\n" +
		"    relative_path: ../outside\n"
	wctx, _ := containmentTree(t, bsYAML)
	out, err := compileErr(t, wctx, bsYAML)
	if err == nil {
		t.Fatalf("compile accepted a ..-escaping relative_path; compose:\n%s", out)
	}
	if !strings.Contains(err.Error(), "not contained") {
		t.Fatalf("expected containment error, got: %v", err)
	}
}

// Positive control: a well-formed record still compiles and mounts its own
// materialized tree from under the gitops root.
func TestMountSourceAcceptsContainedChecksum(t *testing.T) {
	bsYAML := "deployments:\n" +
		"  app-dev:\n" +
		"    automation_name: app\n" +
		"    stage: dev\n" +
		"    checksum: goodsum\n"
	wctx, _ := containmentTree(t, bsYAML)
	out, err := compileErr(t, wctx, bsYAML)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	want := filepath.Join(wctx.GitopsDir, "goodsum") + ":"
	if !strings.Contains(out, want) {
		t.Fatalf("compose missing contained bind-mount %q:\n%s", want, out)
	}
}

func TestContainedJoin(t *testing.T) {
	root := "/data/gitops"
	cases := []struct {
		elem string
		ok   bool
	}{
		{"goodsum", true},
		{"copies/main/app", true},
		{"..foo", true}, // literal name starting with dots, not a traversal
		{"..", false},
		{"../sibling", false},
		{"a/../../etc", false},
		{".", false}, // the root itself is never a valid mount source
		{"", false},
	}
	for _, c := range cases {
		got, err := containedJoin(root, c.elem)
		if c.ok && err != nil {
			t.Errorf("containedJoin(%q, %q): unexpected error %v", root, c.elem, err)
		}
		if !c.ok && err == nil {
			t.Errorf("containedJoin(%q, %q): expected error, got %q", root, c.elem, got)
		}
	}
}

func TestAssertRealUnder(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "in")
	outside := t.TempDir()
	mustMkdir(t, inside)

	if err := assertRealUnder(root, inside); err != nil {
		t.Errorf("real dir under root rejected: %v", err)
	}
	// Missing paths pass — the lexical check has already run.
	if err := assertRealUnder(root, filepath.Join(root, "missing")); err != nil {
		t.Errorf("missing path rejected: %v", err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	if err := assertRealUnder(root, link); err == nil {
		t.Errorf("symlink escaping root was accepted")
	}
}
