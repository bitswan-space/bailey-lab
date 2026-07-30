package daemon

import (
	"fmt"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
)

// Telling the AOC which build this server runs.
//
// A disaster recovery has to fetch a binary onto a bare machine before it can do
// anything else, and the version it should fetch is the one the lost server was
// running. That version IS recorded in every backup — the server manifest carries
// it — but restic encrypts contents and metadata and its key is never escrowed,
// so the AOC cannot read it there. Nor can the recovery: it would need a running
// binary to find out which binary to fetch. The only copy that both outlives the
// server and is legible to the AOC is one the server reported while it was alive.
//
// Hence a report, not a lookup.

// versionReportTimeout bounds one report.
//
// The AOC client sets no per-request timeout, and this now runs inside a backup
// run — so without a bound a black-holed AOC would hang the run rather than the
// report. Generous, because failing to report is not worth a retry: the next run
// reports again.
const versionReportTimeout = 30 * time.Second

// versionReportTimeoutForTest is the timeout actually used; a var so a test can
// prove the bound exists without waiting for it.
var versionReportTimeoutForTest = versionReportTimeout

// SupportsServerRecovery reports whether THIS build can rebuild a whole server.
//
// A constant rather than a runtime probe of the command tree: it is a fact about
// the binary, and the AOC uses it to decide whether pinning this version is safe.
// It exists because `bitswan recover server` is newer than version reporting
// itself, so there are builds that can report a version but not act on one — and
// pinning to those would hand an operator a CLI that exits on the installer's
// last line.
//
// Exported so the cmd package can hold it against the actual command tree
// (TestRecoveryCapabilityMatchesTheCommandTree): were `recover server` removed
// while this stayed true, every recovery would fetch a binary that cannot run it.
const SupportsServerRecovery = true

// reportVersionInBackground reports the running version once, off the caller's
// goroutine.
//
// Used on the startup path so a server that has never backed up still tells the
// AOC what it is — otherwise the record would not exist until the first nightly,
// and a server lost on day one would be unrecoverable-at-version. Every later
// report rides on a backup run instead (Engine.VersionReporter), which is the
// event that actually changes what a recovery would restore.
//
// Best-effort throughout: a server that cannot reach its AOC has larger problems
// than a stale version record, and nothing here may delay or fail startup.
func (s *Server) reportVersionInBackground() {
	go s.reportVersionToAOC()
}

// reportVersionOnce is a seam so tests can drive the reporting decision without
// an AOC.
var reportVersionOnce = func(version string) error {
	client, err := aoc.NewAOCClient()
	if err != nil {
		return err
	}
	return client.ReportServerVersion(version, SupportsServerRecovery)
}

func (s *Server) reportVersionToAOC() {
	// "dev" is the ldflags default — an un-stamped build. Reporting it would
	// overwrite a real recorded version with a string the mirror can never serve,
	// so a build that does not know what it is says nothing at all.
	if s.version == "" || s.version == "dev" {
		return
	}

	// Bounded rather than simply awaited: this runs inside a backup run, and the
	// AOC client has no request timeout of its own. The goroutine may outlive the
	// wait — one abandoned request per run, which is the cheaper failure.
	done := make(chan error, 1)
	go func() { done <- reportVersionOnce(s.version) }()

	select {
	case err := <-done:
		if err != nil {
			fmt.Printf("Warning: could not report this server's version to the AOC: %v\n", err)
		}
	case <-time.After(versionReportTimeoutForTest):
		fmt.Printf("Warning: reporting this server's version to the AOC timed out after %s\n",
			versionReportTimeoutForTest)
	}
}
