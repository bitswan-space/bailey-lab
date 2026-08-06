package daemon

import (
	"testing"
	"time"
)

// The whole-server recovery marker stands the AOC list sync and the catch-up
// backup down. Both go quiet without logging, and the marker is closed by a
// deferred call in a CLI process that can be killed — talking to a daemon that
// the recovery itself just deployed, so it will not restart and clear it. A
// marker stuck on is therefore invisible and permanent, which is why it expires.

func TestServerRecoveryMarkerHoldsThenClears(t *testing.T) {
	t.Cleanup(endServerRecovery)

	if serverRecoveryInProgress() {
		t.Fatal("no recovery should be in flight to begin with")
	}
	beginServerRecovery()
	if !serverRecoveryInProgress() {
		t.Error("the marker should hold once opened")
	}
	if !anyRecoveryInProgress() {
		t.Error("anyRecoveryInProgress must see the server marker — it is what stands the AOC sync down")
	}
	endServerRecovery()
	if serverRecoveryInProgress() || anyRecoveryInProgress() {
		t.Error("closing the marker should release it")
	}
}

func TestAnAbandonedServerRecoveryMarkerExpires(t *testing.T) {
	t.Cleanup(endServerRecovery)

	// A recovery that opened the marker and then died: nothing ever closes it.
	beginServerRecovery()
	recoveryMu.Lock()
	serverRecoveryUntil = time.Now().Add(-time.Minute)
	recoveryMu.Unlock()

	if serverRecoveryInProgress() {
		t.Fatal("a lapsed marker must not keep suppressing the AOC sync and backups")
	}
	if anyRecoveryInProgress() {
		t.Error("anyRecoveryInProgress must agree once the marker has lapsed")
	}
	// Expiry clears the deadline, so status stops advertising a recovery too.
	if !ServerRecoveryDeadline().IsZero() {
		t.Error("an expired marker should leave no deadline behind")
	}
}

func TestServerRecoveryDeadlineIsReportable(t *testing.T) {
	t.Cleanup(endServerRecovery)

	if !ServerRecoveryDeadline().IsZero() {
		t.Fatal("no deadline should be reported when nothing is recovering")
	}
	beginServerRecovery()
	deadline := ServerRecoveryDeadline()
	if deadline.IsZero() {
		t.Fatal("backup status needs the deadline to show an abandoned marker")
	}
	if remaining := time.Until(deadline); remaining <= 0 || remaining > serverRecoveryWindow {
		t.Errorf("deadline is %s away, want within the %s window", remaining, serverRecoveryWindow)
	}
}
