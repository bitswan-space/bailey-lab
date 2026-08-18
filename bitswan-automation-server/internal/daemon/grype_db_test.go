package daemon

import (
	"errors"
	"testing"
)

// gitopsImageForGrype prefers the operator's explicit pin. (The fallback path
// resolves a track-aware image from Docker Hub — network-dependent, so it isn't
// asserted here; the fix is that it uses the DEPLOY track, not the stale
// production channel, so the refresh image actually carries a grype binary.)
func TestGitopsImageForGrype_PrefersEnvPin(t *testing.T) {
	t.Setenv("BITSWAN_GITOPS_IMAGE", "bitswan/gitops-staging:pinned")
	if got := gitopsImageForGrype(); got != "bitswan/gitops-staging:pinned" {
		t.Errorf("gitopsImageForGrype() = %q, want the env pin", got)
	}
}

// A failed refresh must come back on the retry backoff, not a day later: until
// it succeeds the host has no vulnerability DB and every workspace CVE scan
// reports "unavailable" (issues #370 / #271).
func TestNextGrypeRefreshDelay_BacksOffOnFailureAndResetsOnSuccess(t *testing.T) {
	err := errors.New("docker unreachable")

	wait, next := nextGrypeRefreshDelay(err, grypeRetryMin)
	if wait != grypeRetryMin {
		t.Errorf("first retry waits %s, want %s", wait, grypeRetryMin)
	}
	if next != 2*grypeRetryMin {
		t.Errorf("backoff after a failure = %s, want %s", next, 2*grypeRetryMin)
	}

	// Backoff grows but is capped, so retries stay frequent enough to recover
	// within minutes of the host becoming reachable.
	if _, next = nextGrypeRefreshDelay(err, grypeRetryMax); next != grypeRetryMax {
		t.Errorf("backoff = %s, want it capped at %s", next, grypeRetryMax)
	}

	// A success returns to the daily cadence and forgets the backoff.
	wait, next = nextGrypeRefreshDelay(nil, grypeRetryMax)
	if wait != grypeRefreshInterval {
		t.Errorf("wait after success = %s, want %s", wait, grypeRefreshInterval)
	}
	if next != grypeRetryMin {
		t.Errorf("backoff after success = %s, want it reset to %s", next, grypeRetryMin)
	}
}

// The daemon keeps its own record of the shared DB's state — from a workspace
// the only symptom is "scan unavailable", so the operator needs the error here.
func TestRecordGrypeDBRefresh_TracksLastErrorAndSuccess(t *testing.T) {
	t.Cleanup(func() { recordGrypeDBRefresh(nil) })

	recordGrypeDBRefresh(errors.New("grype: not found"))
	recordGrypeDBRefresh(errors.New("grype: not found"))
	health, failures := grypeDBStatus()
	if failures != 2 {
		t.Errorf("consecutive failures = %d, want 2", failures)
	}
	if health.LastError != "grype: not found" {
		t.Errorf("LastError = %q, want the refresh error", health.LastError)
	}
	if !health.LastSuccess.IsZero() {
		t.Error("LastSuccess set although the refresh never succeeded")
	}

	recordGrypeDBRefresh(nil)
	health, failures = grypeDBStatus()
	if failures != 0 || health.LastError != "" {
		t.Errorf("after success: failures=%d err=%q, want 0 and empty", failures, health.LastError)
	}
	if health.LastSuccess.IsZero() {
		t.Error("LastSuccess not recorded after a successful refresh")
	}
}
