package backup

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The server snapshot is what makes a rebuilt machine *this* server again, so
// two things are worth pinning hard:
//
//  1. it records REAL absolute paths — a recovery does `restic restore
//     --target /` straight into the bitswan volume, which only works if the
//     snapshot never contained a staging directory;
//  2. it captures exactly the enumerated list. The two most damaging things a
//     stray inclusion could add are backup/restic-key (the repo's own
//     decryption key, inside the repo it decrypts) and backup/pre-recover
//     (entire quarantined workspace trees).

// plantServerState lays down a realistic config dir plus the traps that must
// never be captured. Returns the config dir.
func plantServerState(t *testing.T) string {
	t.Helper()
	cfg := bitswanConfigDir()
	mustMkdir(t, filepath.Join(cfg, "traefik", "acme"))
	mustMkdir(t, filepath.Join(cfg, "protected-proxy"))
	mustMkdir(t, filepath.Join(cfg, "certauthorities"))
	mustMkdir(t, filepath.Join(cfg, "backup", "pre-recover", "ws1-20260729"))
	mustMkdir(t, filepath.Join(cfg, "workspaces", "ws1"))

	mustWrite(t, filepath.Join(cfg, "automation_server_config.toml"), "[aoc]\n")
	mustSQLiteDB(t, filepath.Join(cfg, "bailey.db"))
	mustWrite(t, filepath.Join(cfg, "bailey.db-wal"), "wal")
	mustWrite(t, filepath.Join(cfg, "traefik", "rest-state.json"), `{"routers":{}}`)
	mustWrite(t, filepath.Join(cfg, "traefik", "acme", "acme.json"), "{}")
	mustWrite(t, filepath.Join(cfg, "protected-proxy", "cookie-secret"), "s3cret")
	mustWrite(t, filepath.Join(cfg, "backup", "config.json"), `{"enabled":true}`)
	mustWrite(t, filepath.Join(cfg, "backup", "key-acknowledged"), "")
	// The traps.
	mustWrite(t, filepath.Join(cfg, "backup", "restic-key"), "the-repo-key")
	mustWrite(t, filepath.Join(cfg, "backup", "pre-recover", "ws1-20260729", "big"), "huge")
	mustWrite(t, filepath.Join(cfg, "backup", "last_run.json"), "{}")
	mustWrite(t, filepath.Join(cfg, "workspaces", "ws1", "secrets"), "shh")
	return cfg
}

func mustMkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// mustSQLiteDB creates a real database, because the capture path runs a real
// VACUUM INTO against it — a stub file would only ever exercise the failure
// branch.
func mustSQLiteDB(t *testing.T, path string) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE devices (id TEXT PRIMARY KEY);
		INSERT INTO devices VALUES ('device-1');`); err != nil {
		t.Fatal(err)
	}
}

func serverStateEngine(t *testing.T) (*Engine, *Restic) {
	t.Helper()
	return &Engine{Version: "1.2.3"}, NewRestic(
		NewAOCTarget("https://aoc.example.com", "srv-123", "tok-abc"), "key")
}

func TestServerStateCapturesRealPathsAndNothingDangerous(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cfg := plantServerState(t)
	argvFile, _ := fakeRestic(t, 0, "")

	engine, restic := serverStateEngine(t)
	engine.ManifestBuilder = func() ([]byte, error) {
		return []byte(`{"schema_version":1,"bitswan_version":"1.2.3"}`), nil
	}

	result := engine.backupServerState(context.Background(), restic)
	if !result.Success {
		t.Fatalf("server state backup failed: %s", result.Output)
	}
	argv := readFile(t, argvFile)

	// Real absolute paths, not a staging copy.
	for _, want := range []string{
		filepath.Join(cfg, "automation_server_config.toml"),
		filepath.Join(cfg, "bailey.db.snapshot"),
		filepath.Join(cfg, "traefik"),
		filepath.Join(cfg, "protected-proxy"),
		filepath.Join(cfg, "certauthorities"),
		filepath.Join(cfg, "backup", "config.json"),
		// Without this a recovered server warns the key was never saved, on a
		// machine that just recovered using it.
		filepath.Join(cfg, "backup", "key-acknowledged"),
		filepath.Join(cfg, "server-manifest.json"),
		"--tag server-config",
		"--host srv-123",
	} {
		if !strings.Contains(argv, want) {
			t.Errorf("server snapshot argv missing %q\ngot: %s", want, argv)
		}
	}
	if strings.Contains(argv, stagingRoot()) {
		t.Errorf("server state must not be captured from staging: %s", argv)
	}

	// The dangerous ones, each named individually so a failure says which.
	for name, path := range map[string]string{
		"the repo's own encryption key": filepath.Join(cfg, "backup", "restic-key"),
		"a quarantined workspace tree":  filepath.Join(cfg, "backup", "pre-recover"),
		"the last-run report":           filepath.Join(cfg, "backup", "last_run.json"),
		"workspace trees":               filepath.Join(cfg, "workspaces"),
		"the raw sqlite WAL":            filepath.Join(cfg, "bailey.db-wal"),
	} {
		if strings.Contains(argv, path) {
			t.Errorf("%s must never be in the server snapshot (%s)\nargv: %s", name, path, argv)
		}
	}
	// bailey.db itself: only the vacuumed copy, never the live file. Checked by
	// word boundary, since the snapshot path contains it as a prefix.
	for _, field := range strings.Fields(argv) {
		if field == filepath.Join(cfg, "bailey.db") {
			t.Errorf("the live bailey.db must never be captured directly: %s", argv)
		}
	}
}

func TestServerStateLeavesNoDatabaseSnapshotBehind(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	plantServerState(t)
	fakeRestic(t, 0, "")

	engine, restic := serverStateEngine(t)
	if r := engine.backupServerState(context.Background(), restic); !r.Success {
		t.Fatalf("server state backup failed: %s", r.Output)
	}
	if _, err := os.Stat(baileySnapshotPath()); !os.IsNotExist(err) {
		t.Errorf("bailey.db.snapshot should be removed after the run (err=%v)", err)
	}
}

func TestServerStateClearsAStaleDatabaseSnapshot(t *testing.T) {
	// A crashed run can leave one behind; capturing it would ship a copy of the
	// database from some arbitrary earlier moment.
	t.Setenv("HOME", t.TempDir())
	plantServerState(t)
	mustWrite(t, baileySnapshotPath(), "stale-from-a-crashed-run")
	fakeRestic(t, 0, "")

	engine, restic := serverStateEngine(t)
	engine.backupServerState(context.Background(), restic)

	// The run removes it up front and VACUUM INTO writes a fresh copy, which is
	// then cleaned up — either way the stale bytes must be gone.
	if data, err := os.ReadFile(baileySnapshotPath()); err == nil &&
		strings.Contains(string(data), "stale-from-a-crashed-run") {
		t.Error("a stale bailey.db.snapshot survived into the run")
	}
}

func TestServerStateReportsRedButStillCapturesWhenTheDatabaseIsUnreadable(t *testing.T) {
	// A corrupt bailey.db is a real gap, so the step fails — but the route
	// table, TLS material and config must still reach the repo. Failing the
	// whole step would turn one broken file into a snapshot with nothing in it.
	t.Setenv("HOME", t.TempDir())
	cfg := plantServerState(t)
	mustWrite(t, filepath.Join(cfg, "bailey.db"), "not actually a database")
	argvFile, _ := fakeRestic(t, 0, "")

	engine, restic := serverStateEngine(t)
	result := engine.backupServerState(context.Background(), restic)

	if result.Success {
		t.Error("an unreadable bailey.db must fail the step")
	}
	if !strings.Contains(result.Output, "bailey.db snapshot FAILED") {
		t.Errorf("the reason should be in the report: %s", result.Output)
	}
	argv := readFile(t, argvFile)
	for _, want := range []string{
		filepath.Join(cfg, "traefik"),
		filepath.Join(cfg, "automation_server_config.toml"),
	} {
		if !strings.Contains(argv, want) {
			t.Errorf("the rest of the server state was not captured: missing %q in %s", want, argv)
		}
	}
	if strings.Contains(argv, baileySnapshotPath()) {
		t.Errorf("a database copy that was never made must not be passed to restic: %s", argv)
	}
}

func TestServerStateSkipsAbsentOptionalPaths(t *testing.T) {
	// certauthorities and protected-proxy legitimately do not exist on a fresh
	// server; that is a report line, not a failure.
	t.Setenv("HOME", t.TempDir())
	cfg := bitswanConfigDir()
	mustMkdir(t, cfg)
	mustWrite(t, filepath.Join(cfg, "automation_server_config.toml"), "[aoc]\n")
	argvFile, _ := fakeRestic(t, 0, "")

	engine, restic := serverStateEngine(t)
	result := engine.backupServerState(context.Background(), restic)
	if !result.Success {
		t.Fatalf("absent optional paths must not fail the step: %s", result.Output)
	}
	if !strings.Contains(result.Output, "captured automation_server_config.toml") {
		t.Errorf("report should name what was captured: %s", result.Output)
	}
	if !strings.Contains(result.Output, "absent") || !strings.Contains(result.Output, "certauthorities") {
		t.Errorf("report should name what was absent: %s", result.Output)
	}
	if argv := readFile(t, argvFile); strings.Contains(argv, "certauthorities") {
		t.Errorf("a missing path must not be passed to restic: %s", argv)
	}
}

func TestServerStateStillBacksUpWhenTheManifestFails(t *testing.T) {
	// The manifest is a recovery convenience. Losing it must not cost the
	// server's actual state — that would trade the whole backup for a nicety.
	t.Setenv("HOME", t.TempDir())
	plantServerState(t)
	argvFile, _ := fakeRestic(t, 0, "")

	engine, restic := serverStateEngine(t)
	engine.ManifestBuilder = func() ([]byte, error) {
		return nil, os.ErrPermission
	}

	result := engine.backupServerState(context.Background(), restic)
	if !result.Success {
		t.Fatalf("a failed manifest must not fail the backup: %s", result.Output)
	}
	if !strings.Contains(result.Output, "manifest unavailable") {
		t.Errorf("the failure should still be reported: %s", result.Output)
	}
	if argv := readFile(t, argvFile); !strings.Contains(argv, "automation_server_config.toml") {
		t.Errorf("state was not captured: %s", argv)
	}
}

func TestServerStateFailsWhenThereIsNothingToCapture(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mustMkdir(t, bitswanConfigDir())
	fakeRestic(t, 0, "")

	engine, restic := serverStateEngine(t)
	if r := engine.backupServerState(context.Background(), restic); r.Success {
		t.Errorf("an empty config dir should be a failure, got: %+v", r)
	}
}
