package daemon

import (
	"bytes"
	"sync"
	"testing"
	"time"
)

// reopenBaileyDBForTest drops the cached DB handle so the next access re-opens
// the on-disk bailey.db — modelling a brand-new daemon process (as happens on a
// binary upgrade/downgrade or `bitswan self-update`, which recreate the daemon
// container against the SAME volume-backed DB).
func reopenBaileyDBForTest(t *testing.T) {
	t.Helper()
	if baileyDB != nil {
		_ = baileyDB.Close()
	}
	baileyDB = nil
	baileyDBOnce = sync.Once{}
}

// TestDeviceTrustSurvivesDaemonRestart is the regression guard for
// "device trust must persist across bailey versions". A version upgrade or
// downgrade swaps the binary and recreates the daemon container, but the
// device-trust store — the `devices` rows AND the HMAC signing key — lives in
// bailey.db on the persistent Docker volume, not in the binary or image. So a
// device cookie issued before the swap must still verify after it.
//
// The two ways this could regress, both caught here:
//   - the signing key being regenerated on start (ephemeral) instead of read
//     from the persisted `singletons` row → every cookie's signature breaks;
//   - the device row not surviving → the cookie verifies but findDevice fails.
func TestDeviceTrustSurvivesDaemonRestart(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	// Isolate this test's DB, and hand the suite a fresh handle afterwards so a
	// later test re-opens against its own HOME rather than this temp dir.
	reopenBaileyDBForTest(t)
	t.Cleanup(func() { reopenBaileyDBForTest(t) })

	const email = "dev@example.com"
	dev, err := addDevice(email, "Chrome on Linux")
	if err != nil {
		t.Fatalf("addDevice: %v", err)
	}

	cookie, err := signedDeviceCookie(email, dev.ID, time.Now())
	if err != nil {
		t.Fatalf("signedDeviceCookie: %v", err)
	}
	keyBefore, err := signingKey()
	if err != nil {
		t.Fatalf("signingKey: %v", err)
	}

	// --- simulate the upgrade/downgrade: new process, same on-disk DB ---
	reopenBaileyDBForTest(t)

	keyAfter, err := signingKey()
	if err != nil {
		t.Fatalf("signingKey after restart: %v", err)
	}
	if !bytes.Equal(keyBefore, keyAfter) {
		t.Fatal("signing key changed across daemon restart — every device cookie would be invalidated")
	}

	id, ok := verifyDeviceCookie(email, cookie)
	if !ok || id != dev.ID {
		t.Fatalf("device cookie no longer verifies after restart (ok=%v id=%q) — device trust was lost", ok, id)
	}

	rec, err := findDevice(email, dev.ID)
	if err != nil || rec == nil {
		t.Fatalf("device row missing after restart (err=%v) — device trust was lost", err)
	}
}

// TestSigningKeyIsPersistedNotEphemeral pins the underlying property directly:
// signingKey() must return the value stored in the DB's singletons row (so a new
// process reproduces it), and it must be write-once (re-reading never rotates
// it). If someone made the key process-random, trust would silently reset on
// every restart.
func TestSigningKeyIsPersistedNotEphemeral(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	reopenBaileyDBForTest(t)
	t.Cleanup(func() { reopenBaileyDBForTest(t) })

	k1, err := signingKey()
	if err != nil {
		t.Fatalf("signingKey: %v", err)
	}
	if len(k1) < 32 {
		t.Fatalf("signing key too short: %d bytes", len(k1))
	}

	db, err := openBaileyDB()
	if err != nil {
		t.Fatalf("openBaileyDB: %v", err)
	}
	var stored []byte
	if err := db.QueryRow(`SELECT value FROM singletons WHERE key='signing_key'`).Scan(&stored); err != nil {
		t.Fatalf("read persisted signing_key: %v", err)
	}
	if !bytes.Equal(k1, stored) {
		t.Fatal("signingKey() is not the persisted DB value — a fresh daemon process would sign differently and drop all device trust")
	}

	k2, err := signingKey()
	if err != nil {
		t.Fatalf("signingKey (2nd): %v", err)
	}
	if !bytes.Equal(k1, k2) {
		t.Fatal("signing key rotated on re-read — must be write-once")
	}
}
