package daemon

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/dockercompose"
	"github.com/bitswan-space/bitswan-workspaces/internal/dockerhub"
)

// The daemon owns the grype vulnerability DB: it downloads + refreshes it once
// per host per day into a shared Docker volume (dockercompose.GrypeDBVolume),
// which every workspace's gitops container mounts READ-ONLY. This moves the
// ~40s DB download out of a workspace's first (interactive) CVE scan and into
// the daemon's background startup, and — because the mount is read-only and
// there is exactly one writer — no workspace can corrupt or poison the DB the
// others scan against.
//
// It refreshes by running `grype db update` inside a throwaway container of the
// pinned gitops image, so the grype binary and DB schema always match what the
// workspaces actually run (rather than baking a DB into an image, which would
// go stale, or coupling this Go daemon to grype's DB URL/format).

const (
	grypeRefreshInterval = 24 * time.Hour
	// A FAILED refresh used to wait the full grypeRefreshInterval before trying
	// again. On a host that was briefly not ready when the daemon started — a
	// laptop with no egress yet, Docker Hub unreachable, the gitops image not
	// pulled — that single miss meant no vulnerability DB for a whole day, and
	// every workspace scan in that window failed. That is what issues #370/#271
	// look like from the dashboard. Retry on a short exponential backoff until
	// the DB is actually there, then settle back to the daily cadence.
	grypeRetryMin = 2 * time.Minute
	grypeRetryMax = 30 * time.Minute
)

// grypeDBHealth is the daemon's own record of the shared DB's state. The
// workspaces can only observe the DB's *effects* (a scan works or it doesn't),
// so when it is missing the operator needs the daemon's side of the story:
// when it last tried, whether it has ever succeeded, and the exact error.
type grypeDBHealth struct {
	LastAttempt time.Time
	LastSuccess time.Time
	LastError   string
}

var (
	grypeDBMu     sync.Mutex
	grypeDBLast   grypeDBHealth
	grypeDBFailed int
)

func recordGrypeDBRefresh(err error) {
	grypeDBMu.Lock()
	defer grypeDBMu.Unlock()
	grypeDBLast.LastAttempt = time.Now()
	if err != nil {
		grypeDBLast.LastError = err.Error()
		grypeDBFailed++
		return
	}
	grypeDBLast.LastSuccess = grypeDBLast.LastAttempt
	grypeDBLast.LastError = ""
	grypeDBFailed = 0
}

// grypeDBStatus reports the last refresh outcome and how many attempts have
// failed in a row.
func grypeDBStatus() (grypeDBHealth, int) {
	grypeDBMu.Lock()
	defer grypeDBMu.Unlock()
	return grypeDBLast, grypeDBFailed
}

// nextGrypeRefreshDelay picks how long to wait before the next attempt, and the
// backoff to carry into the one after that. A success resets to the daily
// cadence; a failure doubles the retry interval up to grypeRetryMax so a host
// that comes online later recovers within minutes, not a day.
func nextGrypeRefreshDelay(err error, backoff time.Duration) (wait, next time.Duration) {
	if err == nil {
		return grypeRefreshInterval, grypeRetryMin
	}
	if backoff < grypeRetryMin {
		backoff = grypeRetryMin
	}
	next = backoff * 2
	if next > grypeRetryMax {
		next = grypeRetryMax
	}
	return backoff, next
}

// gitopsImageForGrype resolves the gitops image whose grype populates the shared
// DB volume: the operator's pin (BITSWAN_GITOPS_IMAGE) if set, else the resolved
// default ON THE SAME TRACK the daemon deploys workspaces on. Tracking the deploy
// track matters — a staging-track host's production `bitswan/gitops` tag can be
// far older than what workspaces actually run and may predate the bundled grype
// binary entirely (older images have no grype at all), which would make every
// refresh fail with "grype: not found" and let the shared DB rot until grype
// rejects it as too old. Returns "" if neither is available.
func gitopsImageForGrype() string {
	if img := os.Getenv("BITSWAN_GITOPS_IMAGE"); img != "" {
		return img
	}
	img, err := dockerhub.ResolveGitopsImage(useStagingTrack(), false)
	if err != nil {
		return ""
	}
	return img
}

// The refresh runs as root (the throwaway container's default user), and grype
// creates its schema directory mode 0700 — root-only. But a workspace's gitops
// does NOT scan as root: start.sh drops the app to user1000. So a DB downloaded
// perfectly still left every scan on every workspace failing with
//
//	failed to access database file: stat /grype-db/6/vulnerability.db: permission denied
//
// permanently, on every host — the real cause of issues #370 / #271, and the
// reason #323's staleness fix did not make scans work. Whoever writes the shared
// volume owns leaving it readable, so the refresh chmods it afterwards.
// `a+rX` adds read for everyone and traverse on DIRECTORIES only (capital X), so
// the DB file itself never becomes executable.
//
// The chmod runs even when `grype db update` fails, and the update's exit code is
// preserved: an existing DB with bad permissions must be repaired on the next
// cycle whether or not there was a new database to fetch. That makes already-broken
// hosts self-heal on the daemon's next refresh, with no manual intervention.
const grypeRefreshScript = `grype db update; rc=$?; chmod -R a+rX /grype-db 2>/dev/null || true; exit $rc`

// grypeRefreshArgs builds the `docker run` argv that refreshes the shared DB.
// Split out from refreshGrypeDB so the contract above is unit-testable without
// a Docker daemon.
func grypeRefreshArgs(img string) []string {
	return []string{"run", "--rm",
		"-v", dockercompose.GrypeDBVolume + ":/grype-db",
		"-e", "GRYPE_DB_CACHE_DIR=/grype-db",
		"--entrypoint", "sh",
		img, "-c", grypeRefreshScript,
	}
}

// refreshGrypeDB runs `grype db update` into the shared volume using the pinned
// gitops image's grype, then makes the result readable by the unprivileged user
// the workspaces actually scan as. Best-effort by contract: a failure leaves the
// previous DB in place (scans then match against the last-good DB) and is never
// fatal.
func refreshGrypeDB(ctx context.Context) error {
	img := gitopsImageForGrype()
	if img == "" {
		return fmt.Errorf("no gitops image available to source grype from")
	}
	cmd := exec.CommandContext(ctx, "docker", grypeRefreshArgs(img)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("grype db update (%s): %w: %s", img, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// startGrypeDBRefresher creates the shared DB volume synchronously (instant, no
// network — so any workspace whose external-volume compose comes up afterwards
// finds it), then populates + refreshes the DB in the background. Startup never
// blocks on the ~40s download.
func startGrypeDBRefresher() {
	// Create the volume up front so `docker compose up` (external: true) for a
	// workspace never fails on a missing volume. Idempotent.
	if out, err := exec.Command("docker", "volume", "create", dockercompose.GrypeDBVolume).CombinedOutput(); err != nil {
		fmt.Printf("Warning: could not create shared grype DB volume: %v: %s\n", err, strings.TrimSpace(string(out)))
	}
	go grypeDBRefreshLoop(context.Background())
}

// grypeDBRefreshLoop refreshes now, then on the daily cadence — but retries on a
// short backoff for as long as the refresh keeps failing, so the host is never
// left without a vulnerability DB for a full day because of one bad moment at
// startup. Every outcome is recorded (grypeDBStatus) and logged with the exact
// error, since a missing DB is otherwise only visible as "scan unavailable" in
// somebody else's dashboard.
func grypeDBRefreshLoop(ctx context.Context) {
	backoff := grypeRetryMin
	for {
		err := func() error {
			c, cancel := context.WithTimeout(ctx, 10*time.Minute)
			defer cancel()
			return refreshGrypeDB(c)
		}()
		recordGrypeDBRefresh(err)
		var wait time.Duration
		wait, backoff = nextGrypeRefreshDelay(err, backoff)
		if err != nil {
			_, failures := grypeDBStatus()
			fmt.Printf("Warning: grype DB refresh failed (attempt %d, retrying in %s) — workspace CVE scans stay unavailable until it succeeds: %v\n",
				failures, wait, err)
		} else {
			fmt.Println("Shared grype vulnerability DB refreshed (daemon-managed)")
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}
