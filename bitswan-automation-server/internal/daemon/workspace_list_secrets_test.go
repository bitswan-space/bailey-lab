package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeWorkspaceWithSecret creates a fake workspace dir under $HOME with a
// deployment/docker-compose.yml carrying a BITSWAN_GITOPS_SECRET, matching
// the shape getGitOpsSecret parses.
func writeWorkspaceWithSecret(t *testing.T, name, secret string) {
	t.Helper()
	depDir := filepath.Join(os.Getenv("HOME"), ".config", "bitswan", "workspaces", name, "deployment")
	if err := os.MkdirAll(depDir, 0o755); err != nil {
		t.Fatal(err)
	}
	compose := `services:
  bitswan-gitops:
    image: bitswan/gitops:latest
    environment:
      - BITSWAN_GITOPS_SECRET=` + secret + "\n"
	if err := os.WriteFile(filepath.Join(depDir, "docker-compose.yml"), []byte(compose), 0o644); err != nil {
		t.Fatal(err)
	}
}

// listRequest builds a socket-style request (empty RemoteAddr — the shape
// authMiddleware fully trusts) with an optional bearer token, and runs it
// through handleWorkspaceList.
func listRequest(t *testing.T, s *Server, query, bearer string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/workspace/list"+query, nil)
	r.RemoteAddr = "" // unix-socket peer as seen by authMiddleware
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	w := httptest.NewRecorder()
	s.handleWorkspaceList(w, r)
	return w
}

// A socket-trusted caller WITHOUT the admin token (e.g. a compromised
// workspace gitops/infra-driver container, which has the daemon socket
// bind-mounted) must never receive any workspace's gitops secret (#128).
func TestWorkspaceList_PasswordsWithoutTokenForbidden(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("HOST_HOME", "")
	writeWorkspaceWithSecret(t, "tenant-a", "secret-tenant-a")
	writeWorkspaceWithSecret(t, "tenant-b", "secret-tenant-b")
	s := &Server{token: "daemon-admin-token"}

	for _, bearer := range []string{"", "wrong-token"} {
		w := listRequest(t, s, "?passwords=true", bearer)
		if w.Code != http.StatusForbidden {
			t.Errorf("bearer %q: status = %d, want %d", bearer, w.Code, http.StatusForbidden)
		}
		body := w.Body.String()
		for _, secret := range []string{"secret-tenant-a", "secret-tenant-b"} {
			if strings.Contains(body, secret) {
				t.Errorf("bearer %q: response leaked gitops secret %q", bearer, secret)
			}
		}
	}
}

// The daemon's own token (used by `docker exec` into the daemon, and matching
// the host config when the daemon runs directly on the host) still unlocks
// passwords=true.
func TestWorkspaceList_PasswordsWithDaemonToken(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("HOST_HOME", "")
	writeWorkspaceWithSecret(t, "tenant-a", "secret-tenant-a")
	s := &Server{token: "daemon-admin-token"}

	w := listRequest(t, s, "?passwords=true", "daemon-admin-token")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", w.Code, w.Body.String())
	}
	var resp WorkspaceListResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, ws := range resp.Workspaces {
		if ws.Name == "tenant-a" && ws.GitopsSecret == "secret-tenant-a" {
			found = true
		}
	}
	if !found {
		t.Errorf("admin-token request did not return tenant-a's secret: %s", w.Body.String())
	}
}

// The HOST CLI's token — a different store than the daemon's volume config —
// is verified through the /host mount + HOST_HOME, so `bitswan list
// --passwords` on the host keeps working.
func TestWorkspaceList_PasswordsWithHostCLIToken(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("HOST_HOME", "/home/hostuser")
	oldRoot := hostRootDir
	hostRootDir = t.TempDir()
	t.Cleanup(func() { hostRootDir = oldRoot })

	hostCfgDir := filepath.Join(hostRootDir, "home", "hostuser", ".config", "bitswan")
	if err := os.MkdirAll(hostCfgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	hostCfg := "[local_server]\ntoken = \"host-cli-token\"\n"
	if err := os.WriteFile(filepath.Join(hostCfgDir, "automation_server_config.toml"), []byte(hostCfg), 0o600); err != nil {
		t.Fatal(err)
	}

	writeWorkspaceWithSecret(t, "tenant-a", "secret-tenant-a")
	s := &Server{token: "daemon-admin-token"} // deliberately different from host token

	w := listRequest(t, s, "?passwords=true", "host-cli-token")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "secret-tenant-a") {
		t.Errorf("host-CLI-token request did not return the secret: %s", w.Body.String())
	}
}

// Plain listing (no passwords) must keep working for socket-trusted callers
// with no token at all — that is the path every workspace container and CLI
// command relies on — and must not include secrets.
func TestWorkspaceList_PlainListUnaffected(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("HOST_HOME", "")
	writeWorkspaceWithSecret(t, "tenant-a", "secret-tenant-a")
	s := &Server{token: "daemon-admin-token"}

	w := listRequest(t, s, "", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, "tenant-a") {
		t.Errorf("plain list missing workspace name: %s", body)
	}
	if strings.Contains(body, "secret-tenant-a") {
		t.Errorf("plain list leaked gitops secret: %s", body)
	}
}
