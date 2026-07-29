package daemon

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeWorkspaceMetadata(t *testing.T, ws, gitopsSecret string) {
	t.Helper()
	wsDir := filepath.Join(os.Getenv("HOME"), ".config", "bitswan", "workspaces", ws)
	if err := os.MkdirAll(wsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	metadata := "domain: example.com\ngitops-url: u\ngitops-secret: " + gitopsSecret + "\n"
	if err := os.WriteFile(filepath.Join(wsDir, "metadata.yaml"), []byte(metadata), 0o644); err != nil {
		t.Fatal(err)
	}
}

func fetchSnapshotRequest(t *testing.T, s *Server, body, secret string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/backup/fetch-snapshot", strings.NewReader(body))
	r.RemoteAddr = "" // unix-socket peer
	if secret != "" {
		r.Header.Set("X-Bitswan-Workspace-Secret", secret)
	}
	w := httptest.NewRecorder()
	s.handleBackup(w, r)
	return w
}

// The socket is reachable from every workspace container: a fetch without
// the OWNING workspace's gitops secret must be refused — otherwise any
// tenant could materialize another tenant's snapshots.
func TestBackupFetchSnapshotAuth(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	writeWorkspaceMetadata(t, "tenant-a", "secret-a")
	s := &Server{}

	body := `{"workspace":"tenant-a","bp":"bp1","stage":"production","snapshot_id":"snap-1"}`

	for name, secret := range map[string]string{"missing": "", "wrong": "secret-b"} {
		if w := fetchSnapshotRequest(t, s, body, secret); w.Code != http.StatusForbidden {
			t.Errorf("%s secret: status = %d, want 403", name, w.Code)
		}
	}

	// Unknown workspace: no metadata → no secret can match.
	unknown := `{"workspace":"ghost","bp":"bp1","stage":"production","snapshot_id":"s"}`
	if w := fetchSnapshotRequest(t, s, unknown, "anything"); w.Code != http.StatusForbidden {
		t.Errorf("unknown workspace: status = %d, want 403", w.Code)
	}

	// Path traversal in any segment is rejected before auth even matters.
	traversal := `{"workspace":"tenant-a","bp":"../../..","stage":"production","snapshot_id":"s"}`
	if w := fetchSnapshotRequest(t, s, traversal, "secret-a"); w.Code != http.StatusBadRequest {
		t.Errorf("traversal: status = %d, want 400", w.Code)
	}
}

// Same rule for the offsite listing.
func TestBackupOffsiteSnapshotsAuth(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	writeWorkspaceMetadata(t, "tenant-a", "secret-a")
	s := &Server{}

	r := httptest.NewRequest(http.MethodGet, "/backup/offsite-snapshots?workspace=tenant-a&bp=bp1&stage=production", nil)
	r.RemoteAddr = ""
	r.Header.Set("X-Bitswan-Workspace-Secret", "wrong")
	w := httptest.NewRecorder()
	s.handleBackup(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("wrong secret: status = %d, want 403", w.Code)
	}
}

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
