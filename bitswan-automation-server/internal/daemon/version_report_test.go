package daemon

import (
	"fmt"
	"testing"
	"time"
)

// What the AOC does with a reported version is decide whether a disaster-recovery
// command may pin it. So the thing worth pinning down here is which versions this
// daemon is willing to claim: reporting a string the binary mirror can never serve
// would replace a good record with a useless one.

func withReportSeam(t *testing.T) *[]string {
	t.Helper()
	original := reportVersionOnce
	reported := []string{}
	reportVersionOnce = func(version string) error {
		reported = append(reported, version)
		return nil
	}
	t.Cleanup(func() { reportVersionOnce = original })
	return &reported
}

func TestReportsAStampedVersion(t *testing.T) {
	reported := withReportSeam(t)
	(&Server{version: "v2026.07.29.50"}).reportVersionToAOC()

	if len(*reported) != 1 || (*reported)[0] != "v2026.07.29.50" {
		t.Fatalf("expected the release tag to be reported, got %v", *reported)
	}
}

func TestUnstampedBuildReportsNothing(t *testing.T) {
	// "dev" is the ldflags default. Reporting it would overwrite a real recorded
	// version with one the mirror cannot serve, so a recovery would silently fall
	// back to "newest" for a server that had previously reported properly.
	for _, version := range []string{"dev", ""} {
		reported := withReportSeam(t)
		(&Server{version: version}).reportVersionToAOC()
		if len(*reported) != 0 {
			t.Errorf("version %q should not be reported, got %v", version, *reported)
		}
	}
}

func TestAReportFailureIsNotFatal(t *testing.T) {
	// A server that cannot reach its AOC has bigger problems than a stale version
	// record, and this runs on the startup path.
	original := reportVersionOnce
	t.Cleanup(func() { reportVersionOnce = original })
	reportVersionOnce = func(string) error { return fmt.Errorf("aoc unreachable") }

	(&Server{version: "v2026.07.29.50"}).reportVersionToAOC() // must not panic
}

func TestThisBuildDeclaresRecoverySupport(t *testing.T) {
	// The AOC pins a recorded version only when the build that reported it can
	// actually recover a server. This binary has `recover server`, so it must say
	// so — otherwise every recovery silently installs "newest" instead of the
	// version it is meant to reproduce.
	// cmd's TestRecoveryCapabilityMatchesTheCommandTree ties this to the actual
	// command, which is the half this package cannot see.
	if !SupportsServerRecovery {
		t.Fatal("this build ships `bitswan recover server` and must declare it")
	}
}

func TestTheBackupEngineIsWiredToReport(t *testing.T) {
	// The report now rides on backup runs rather than a clock, which only works if
	// NewServer actually hands the engine the hook — a silent nil here would mean
	// the AOC's version record froze at whatever boot last set it.
	if NewServer("v2026.07.29.50").backupEngine.VersionReporter == nil {
		t.Fatal("the backup engine has no VersionReporter; runs would never report")
	}
}

func TestAHangingReportDoesNotBlockForever(t *testing.T) {
	// This runs inside a backup run and the AOC client sets no request timeout, so
	// the bound has to be here: an unreachable-but-not-refusing AOC must cost the
	// run one timeout, not the whole run.
	original := reportVersionOnce
	originalTimeout := versionReportTimeoutForTest
	t.Cleanup(func() {
		reportVersionOnce = original
		versionReportTimeoutForTest = originalTimeout
	})

	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	reportVersionOnce = func(string) error {
		<-release // never returns within the test
		return nil
	}
	versionReportTimeoutForTest = 20 * time.Millisecond

	done := make(chan struct{})
	go func() {
		(&Server{version: "v2026.07.29.50"}).reportVersionToAOC()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("reportVersionToAOC did not give up; a backup run would hang on it")
	}
}
