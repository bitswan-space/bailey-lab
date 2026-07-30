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

// versionReportInterval re-reports periodically so an upgrade does not leave the
// AOC pinning a version this server no longer runs. Slow on purpose: the value
// changes only when the binary is replaced, and a recovery that fetches a build
// one interval stale is a far smaller problem than a chatty daemon.
const versionReportInterval = 6 * time.Hour

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

// startVersionReporter reports the running version now, then on a slow ticker.
//
// Best-effort throughout: a server that cannot reach its AOC has larger problems
// than a stale version record, and nothing here may delay or fail startup.
func (s *Server) startVersionReporter() {
	go func() {
		s.reportVersionToAOC()
		for range time.Tick(versionReportInterval) {
			s.reportVersionToAOC()
		}
	}()
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
	if err := reportVersionOnce(s.version); err != nil {
		fmt.Printf("Warning: could not report this server's version to the AOC: %v\n", err)
	}
}
