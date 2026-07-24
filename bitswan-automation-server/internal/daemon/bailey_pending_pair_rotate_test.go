package daemon

import (
	"testing"
	"time"
)

// TestPendingPairReusesLiveCodeThenRotates guards the device-pairing code
// lifecycle a user hit in practice: a code read to an admin "expired" before it
// could be approved because every fetch minted a brand-new code.
//
//   - While a code is comfortably live, re-fetching must REUSE it (stable code —
//     the admin approves the same one the user is looking at).
//   - Once it drops under the refresh threshold, a fetch must MINT A FRESH code
//     with a full TTL — that's what lets the approval screen auto-rotate off a
//     nearly-expired code instead of getting stuck on a dead one.
func TestPendingPairReusesLiveCodeThenRotates(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	reopenBaileyDBForTest(t)
	t.Cleanup(func() { reopenBaileyDBForTest(t) })

	const email = "dev@example.com"

	e1, err := generatePendingPairUA(email, "UA1")
	if err != nil {
		t.Fatalf("generate: %v", err)
	}

	// Comfortably live → reuse.
	e2, err := generatePendingPairUA(email, "UA1")
	if err != nil {
		t.Fatalf("generate 2: %v", err)
	}
	if e2.Code != e1.Code {
		t.Fatalf("code churned while still live: %s -> %s (must reuse)", e1.Code, e2.Code)
	}

	// Push it near expiry (under pairingRefreshThreshold) → next fetch rotates.
	e1.ExpiresAt = time.Now().Add(30 * time.Second)
	if err := dbUpsertPendingPair(e1); err != nil {
		t.Fatalf("upsert near-expiry: %v", err)
	}
	e3, err := generatePendingPairUA(email, "UA1")
	if err != nil {
		t.Fatalf("generate 3: %v", err)
	}
	if e3.Code == e1.Code {
		t.Fatal("code did not rotate when near expiry — the approval screen would stay stuck on a dying code")
	}
	if e3.ExpiresAt.Sub(time.Now()) < 4*time.Minute {
		t.Fatalf("rotated code got a truncated TTL: %v remaining", e3.ExpiresAt.Sub(time.Now()))
	}
}
