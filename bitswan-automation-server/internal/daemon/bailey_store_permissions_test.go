package daemon

import (
	"os"
	"path/filepath"
	"testing"
)

// Regression guard for issue #286: bailey.db, its WAL sidecars and the
// enclosing ~/.config/bitswan dir must come out of store init owner-only.
// They hold the device-cookie signing key, TOTP seeds, backup-code hashes,
// roles and ACL grants; the process umask alone leaves them world-readable
// (0644 file / 0755 dir). This is exactly the kind of hardening that gets
// silently undone by a later refactor, hence the test.

// modeOf fails the test when path is missing — every path these tests name is
// expected to exist by the time they look.
func modeOf(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return info.Mode().Perm()
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	if got := modeOf(t, path); got != want {
		t.Errorf("%s: mode %#o, want %#o", filepath.Base(path), got, want)
	}
}

// openStoreInFreshHome points HOME at a throwaway dir and opens the store
// there, modelling a first-ever daemon start. Returns the bailey.db path.
func openStoreInFreshHome(t *testing.T) string {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	// Isolate this test's DB, and hand the suite a fresh handle afterwards so a
	// later test re-opens against its own HOME rather than this temp dir.
	reopenBaileyDBForTest(t)
	t.Cleanup(func() { reopenBaileyDBForTest(t) })
	if _, err := openBaileyDB(); err != nil {
		t.Fatalf("openBaileyDB: %v", err)
	}
	return baileyDBPath()
}

// TestBaileyDBCreatedOwnerOnly is the first-start case: nothing on disk, so
// the modes are whatever init leaves behind.
func TestBaileyDBCreatedOwnerOnly(t *testing.T) {
	dbPath := openStoreInFreshHome(t)

	assertMode(t, filepath.Dir(dbPath), 0o700)
	assertMode(t, dbPath, 0o600)
	// journal_mode(WAL) is in the DSN, so both sidecars exist by now.
	assertMode(t, dbPath+"-wal", 0o600)
	assertMode(t, dbPath+"-shm", 0o600)
}

// TestBaileyDBTightenedOnRestart is the upgrade case that actually matters in
// the field: an install that predates this change already has a 0644 database
// in a 0755 dir, and the daemon start that follows the upgrade has to fix it.
func TestBaileyDBTightenedOnRestart(t *testing.T) {
	dbPath := openStoreInFreshHome(t)
	sidecars := []string{dbPath + "-wal", dbPath + "-shm"}

	// Loosen everything back to the umask defaults, as a pre-#286 daemon left them.
	if err := os.Chmod(filepath.Dir(dbPath), 0o755); err != nil {
		t.Fatalf("chmod dir: %v", err)
	}
	for _, path := range append([]string{dbPath}, sidecars...) {
		if err := os.Chmod(path, 0o644); err != nil {
			t.Fatalf("chmod %s: %v", path, err)
		}
	}

	// A new daemon process against the same on-disk DB.
	reopenBaileyDBForTest(t)
	if _, err := openBaileyDB(); err != nil {
		t.Fatalf("reopen bailey.db: %v", err)
	}

	assertMode(t, filepath.Dir(dbPath), 0o700)
	assertMode(t, dbPath, 0o600)
	for _, path := range sidecars {
		assertMode(t, path, 0o600)
	}

	// And once more with nothing to do — tightening is idempotent, not a
	// one-shot that only works on a loose file.
	reopenBaileyDBForTest(t)
	if _, err := openBaileyDB(); err != nil {
		t.Fatalf("second reopen: %v", err)
	}
	assertMode(t, filepath.Dir(dbPath), 0o700)
	assertMode(t, dbPath, 0o600)
}

// TestTightenModeNeverLoosens covers the two edge cases of the primitive that
// a full store open can't reach: a path already stricter than the target must
// be left alone (never opened up to the target), and a path that does not
// exist yet is not an error — SQLite makes -wal/-shm lazily.
func TestTightenModeNeverLoosens(t *testing.T) {
	dir := t.TempDir()

	stricter := filepath.Join(dir, "already-stricter")
	if err := os.WriteFile(stricter, []byte("x"), 0o400); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := tightenMode(stricter, 0o600); err != nil {
		t.Fatalf("tightenMode: %v", err)
	}
	assertMode(t, stricter, 0o400)

	// Mixed bits: the group/other bits go, the owner bits that are already
	// absent stay absent (0464 & 0600 == 0400).
	mixed := filepath.Join(dir, "mixed")
	if err := os.WriteFile(mixed, []byte("x"), 0o464); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.Chmod(mixed, 0o464); err != nil { // umask-proof
		t.Fatalf("chmod: %v", err)
	}
	if err := tightenMode(mixed, 0o600); err != nil {
		t.Fatalf("tightenMode: %v", err)
	}
	assertMode(t, mixed, 0o400)

	if err := tightenMode(filepath.Join(dir, "not-created-yet"), 0o600); err != nil {
		t.Errorf("a missing path must not be an error: %v", err)
	}
}
