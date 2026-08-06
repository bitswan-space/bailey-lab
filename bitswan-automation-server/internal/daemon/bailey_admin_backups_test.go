package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/daemon/backup"
)

// The console's Backups panel talks to these and nothing else. They sit behind
// bailey_dispatch's isAdmin gate, so the checks worth having here are the ones
// the gate cannot make: that a bad retention policy is refused rather than
// persisted, that the key endpoints say 404 instead of handing back an empty
// string, and that a toggle actually reaches disk.

func adminBackupsEnv(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
}

func TestAdminBackupsStatusReportsAnUnregisteredServer(t *testing.T) {
	adminBackupsEnv(t)
	var s Server
	w := httptest.NewRecorder()
	s.handleAdminBackupsStatus(w, httptest.NewRequest(http.MethodGet, "/bailey/api/admin/backups", nil))

	if w.Code != http.StatusOK {
		t.Fatalf("code = %d", w.Code)
	}
	var got BackupStatusResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	// With no AOC there is nowhere to put a backup, and the panel renders that
	// reason instead of an enable button.
	if got.AOCConnected {
		t.Error("a server with no AOC config must not report itself connected")
	}
	if got.Reason == "" {
		t.Error("status must say why backups cannot run")
	}
	if got.HasKey {
		t.Error("no key should exist on a fresh server")
	}
}

func TestAdminBackupsRetentionRefusesAPolicyThatKeepsNothing(t *testing.T) {
	adminBackupsEnv(t)
	var s Server

	// daily=0 would tell restic to keep no nightly at all. Rejecting it matters
	// more than most validation here: the failure is silent and only discovered
	// when someone needs a backup that was pruned on the operator's own orders.
	for _, body := range []string{`{"daily":0,"monthly":12}`, `{"daily":30,"monthly":-1}`, `not json`} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, "/bailey/api/admin/backups/retention", strings.NewReader(body))
		s.handleAdminBackupsRetention(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("body %s: code = %d, want 400", body, w.Code)
		}
	}

	// And nothing was written on the way through.
	cfg, exists, err := backup.LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Error("a rejected policy must not create a config file")
	}
	if cfg.Retention != backup.DefaultRetention {
		t.Errorf("retention = %+v, want the defaults untouched", cfg.Retention)
	}
}

func TestAdminBackupsRetentionPersists(t *testing.T) {
	adminBackupsEnv(t)
	var s Server
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/bailey/api/admin/backups/retention",
		strings.NewReader(`{"daily":7,"monthly":3}`))
	s.handleAdminBackupsRetention(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", w.Code, w.Body.String())
	}
	cfg, _, err := backup.LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Retention.Daily != 7 || cfg.Retention.Monthly != 3 {
		t.Errorf("retention = %+v, want 7/3 on disk", cfg.Retention)
	}
	// Image backups are a separate switch and must survive a retention edit.
	if !cfg.Images {
		t.Error("saving retention should not silently turn image backups off")
	}
}

func TestAdminBackupsEnabledTogglesOnDisk(t *testing.T) {
	adminBackupsEnv(t)
	var s Server

	for _, tc := range []struct {
		body string
		want bool
	}{{`{"enabled":false}`, false}, {`{"enabled":true}`, true}} {
		w := httptest.NewRecorder()
		s.handleAdminBackupsEnabled(w,
			httptest.NewRequest(http.MethodPost, "/bailey/api/admin/backups/enabled", strings.NewReader(tc.body)))
		if w.Code != http.StatusOK {
			t.Fatalf("%s: code = %d", tc.body, w.Code)
		}
		cfg, _, err := backup.LoadConfig()
		if err != nil {
			t.Fatal(err)
		}
		if cfg.Enabled != tc.want {
			t.Errorf("%s: enabled = %v on disk", tc.body, cfg.Enabled)
		}
	}

	w := httptest.NewRecorder()
	s.handleAdminBackupsEnabled(w,
		httptest.NewRequest(http.MethodPost, "/bailey/api/admin/backups/enabled", strings.NewReader(`bad`)))
	if w.Code != http.StatusBadRequest {
		t.Errorf("malformed body: code = %d, want 400", w.Code)
	}
}

// The key endpoints must distinguish "no key yet" from "here is your key". An
// empty 200 would read to the console as a key that exists and is blank, and the
// operator would file nothing.
func TestAdminBackupsKeyIsAbsentUntilItExists(t *testing.T) {
	adminBackupsEnv(t)
	var s Server

	w := httptest.NewRecorder()
	s.handleAdminBackupsKey(w, httptest.NewRequest(http.MethodGet, "/bailey/api/admin/backups/key", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("no key: code = %d, want 404", w.Code)
	}

	ack := httptest.NewRecorder()
	s.handleAdminBackupsKeyAcknowledge(ack,
		httptest.NewRequest(http.MethodPost, "/bailey/api/admin/backups/key/acknowledge", nil))
	if ack.Code != http.StatusNotFound {
		t.Errorf("acknowledging a key that does not exist: code = %d, want 404", ack.Code)
	}
	if backup.KeyAcknowledged() {
		t.Error("nothing should be recorded as saved when there is no key")
	}
}

func TestAdminBackupsKeyIsServedAndAcknowledged(t *testing.T) {
	adminBackupsEnv(t)
	if err := backup.SaveKey("THE-BACKUP-KEY"); err != nil {
		t.Fatal(err)
	}
	var s Server

	w := httptest.NewRecorder()
	s.handleAdminBackupsKey(w, httptest.NewRequest(http.MethodGet, "/bailey/api/admin/backups/key", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d", w.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["key"] != "THE-BACKUP-KEY" {
		t.Errorf("key = %q", body["key"])
	}

	// Acknowledgement is the only signal that a copy exists anywhere but here,
	// so it has to actually persist.
	if backup.KeyAcknowledged() {
		t.Fatal("a fresh key must not start out acknowledged")
	}
	ack := httptest.NewRecorder()
	s.handleAdminBackupsKeyAcknowledge(ack,
		httptest.NewRequest(http.MethodPost, "/bailey/api/admin/backups/key/acknowledge", nil))
	if ack.Code != http.StatusOK {
		t.Fatalf("acknowledge: code = %d", ack.Code)
	}
	if !backup.KeyAcknowledged() {
		t.Error("acknowledgement did not persist")
	}
	if backup.UnsavedKeyWarning() != "" {
		t.Error("the not-saved warning should be silenced once acknowledged")
	}
}

// Run-now is serialised against the nightly and against recoveries by one
// engine-wide reservation. A second run must be refused rather than queued: two
// concurrent runs would fight over the same restic repo lock.
func TestAdminBackupsRunIsRefusedWhileOneIsInFlight(t *testing.T) {
	adminBackupsEnv(t)
	var s Server
	if err := s.backupEngine.TryReserve("test"); err != nil {
		t.Fatal(err)
	}
	defer s.backupEngine.Release()

	w := httptest.NewRecorder()
	s.handleAdminBackupsRun(w, httptest.NewRequest(http.MethodPost, "/bailey/api/admin/backups/run", nil), "someone@example.com")

	if w.Code != http.StatusConflict {
		t.Fatalf("code = %d, want 409 while a run holds the engine", w.Code)
	}
	if !strings.Contains(w.Body.String(), "already in progress") {
		t.Errorf("body should say why: %s", w.Body.String())
	}
}

// A config file that cannot be parsed must surface as an error, not be silently
// replaced by defaults — quietly re-enabling backups or resetting retention
// because a file got corrupted is a change nobody asked for.
func TestAdminBackupsRefuseToActOnAnUnreadableConfig(t *testing.T) {
	adminBackupsEnv(t)
	if err := os.MkdirAll(backup.Dir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(backup.Dir(), "config.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	var s Server

	for name, call := range map[string]func(http.ResponseWriter, *http.Request){
		"retention": s.handleAdminBackupsRetention,
		"enabled":   s.handleAdminBackupsEnabled,
	} {
		body := `{"daily":7,"monthly":3}`
		if name == "enabled" {
			body = `{"enabled":true}`
		}
		w := httptest.NewRecorder()
		call(w, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body)))
		if w.Code != http.StatusInternalServerError {
			t.Errorf("%s: code = %d, want 500 on an unparseable config", name, w.Code)
		}
	}
}

// Run-now accepts and detaches: the console gets 202 immediately and follows the
// run by polling status, because a full backup outlives any request timeout.
func TestAdminBackupsRunAcceptsAndDetaches(t *testing.T) {
	adminBackupsEnv(t)
	saved := adminBackupRun
	t.Cleanup(func() { adminBackupRun = saved })

	started := make(chan struct{})
	adminBackupRun = func(ctx context.Context, e *backup.Engine, log func(string)) error {
		log("working")
		close(started)
		return nil
	}

	var s Server
	w := httptest.NewRecorder()
	s.handleAdminBackupsRun(w, httptest.NewRequest(http.MethodPost, "/x", nil), "someone@example.com")

	if w.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202", w.Code)
	}
	if !strings.Contains(w.Body.String(), `"started":true`) {
		t.Errorf("body = %s", w.Body.String())
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("the handler returned 202 but never actually started a run")
	}
}

// A failing run must not take the daemon down with it — the console learns about
// it from the next status poll, not from a crashed process.
func TestAdminBackupsRunSurvivesAFailedRun(t *testing.T) {
	adminBackupsEnv(t)
	saved := adminBackupRun
	t.Cleanup(func() { adminBackupRun = saved })

	done := make(chan struct{})
	adminBackupRun = func(ctx context.Context, e *backup.Engine, log func(string)) error {
		defer close(done)
		return errors.New("boom")
	}

	var s Server
	w := httptest.NewRecorder()
	s.handleAdminBackupsRun(w, httptest.NewRequest(http.MethodPost, "/x", nil), "someone@example.com")

	if w.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202 — the failure is asynchronous", w.Code)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the run never ran")
	}
}
