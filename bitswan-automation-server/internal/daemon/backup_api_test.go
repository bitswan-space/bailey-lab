package daemon

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Key download and restore both demand the host-admin token, socket or not.
func TestBackupAdminGates(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("HOST_HOME", "")
	s := &Server{token: "admin-token"}

	key := httptest.NewRequest(http.MethodGet, "/backup/key", nil)
	key.RemoteAddr = ""
	w := httptest.NewRecorder()
	s.handleBackup(w, key)
	if w.Code != http.StatusForbidden {
		t.Errorf("key without token: status = %d, want 403", w.Code)
	}

	restore := httptest.NewRequest(http.MethodPost, "/backup/restore",
		strings.NewReader(`{"type":"postgres","workspace":"ws1"}`))
	restore.RemoteAddr = ""
	w = httptest.NewRecorder()
	s.handleBackup(w, restore)
	if w.Code != http.StatusForbidden {
		t.Errorf("restore without token: status = %d, want 403", w.Code)
	}
}

func recoverRequest(t *testing.T, s *Server, body, bearer string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/backup/recover/workspace", strings.NewReader(body))
	r.RemoteAddr = "" // unix-socket peer
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	w := httptest.NewRecorder()
	s.handleBackup(w, r)
	return w
}

// Recovery is the most destructive route in the daemon: socket trust alone is
// not enough, it needs the host-admin token.
func TestBackupRecoverWorkspaceRequiresAdmin(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("HOST_HOME", "")
	s := &Server{token: "admin-token"}

	if w := recoverRequest(t, s, `{"workspace":"ws1","force":true}`, ""); w.Code != http.StatusForbidden {
		t.Errorf("no token: status = %d, want 403", w.Code)
	}
	if w := recoverRequest(t, s, `{"workspace":"ws1","force":true}`, "wrong"); w.Code != http.StatusForbidden {
		t.Errorf("wrong token: status = %d, want 403", w.Code)
	}
}

func TestBackupRecoverWorkspaceValidation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("HOST_HOME", "")
	s := &Server{token: "admin-token"}

	cases := map[string]string{
		"missing workspace":     `{}`,
		"path traversal":        `{"workspace":"../etc","force":true}`,
		"unknown stage":         `{"workspace":"ws1","force":true,"stages":["prod"]}`,
		"skip-containers alone": `{"workspace":"ws1","force":true,"skip_containers":true}`,
	}
	for name, body := range cases {
		if w := recoverRequest(t, s, body, "admin-token"); w.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400 (%s)", name, w.Code, w.Body.String())
		}
	}
}

// An existing workspace must not be replaced without an explicit force.
func TestBackupRecoverWorkspaceRefusesExistingWithoutForce(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("HOST_HOME", "")
	if err := os.MkdirAll(filepath.Join(home, ".config", "bitswan", "workspaces", "ws1"), 0o755); err != nil {
		t.Fatal(err)
	}
	s := &Server{token: "admin-token"}

	w := recoverRequest(t, s, `{"workspace":"ws1"}`, "admin-token")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "force") {
		t.Errorf("error should mention force: %s", w.Body.String())
	}
}
