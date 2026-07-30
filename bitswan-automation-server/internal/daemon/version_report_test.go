package daemon

import (
	"fmt"
	"testing"
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
