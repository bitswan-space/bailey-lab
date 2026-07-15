package daemon

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
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

const grypeRefreshInterval = 24 * time.Hour

// gitopsImageForGrype resolves the gitops image whose grype populates the shared
// DB volume: the operator's pin (BITSWAN_GITOPS_IMAGE) if set, else the resolved
// default. Returns "" if neither is available.
func gitopsImageForGrype() string {
	if img := os.Getenv("BITSWAN_GITOPS_IMAGE"); img != "" {
		return img
	}
	img, err := dockerhub.ResolveGitopsImage(false, false)
	if err != nil {
		return ""
	}
	return img
}

// refreshGrypeDB runs `grype db update` into the shared volume using the pinned
// gitops image's grype. Best-effort by contract: a failure leaves the previous
// DB in place (scans then match against the last-good DB) and is never fatal.
func refreshGrypeDB(ctx context.Context) error {
	img := gitopsImageForGrype()
	if img == "" {
		return fmt.Errorf("no gitops image available to source grype from")
	}
	cmd := exec.CommandContext(ctx, "docker", "run", "--rm",
		"-v", dockercompose.GrypeDBVolume+":/grype-db",
		"-e", "GRYPE_DB_CACHE_DIR=/grype-db",
		"--entrypoint", "grype",
		img, "db", "update",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("grype db update (%s): %w: %s", img, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// startGrypeDBRefresher creates the shared DB volume synchronously (instant, no
// network — so any workspace whose external-volume compose comes up afterwards
// finds it), then populates + refreshes the DB in the background: once now, then
// every grypeRefreshInterval. Startup never blocks on the ~40s download.
func startGrypeDBRefresher() {
	// Create the volume up front so `docker compose up` (external: true) for a
	// workspace never fails on a missing volume. Idempotent.
	if out, err := exec.Command("docker", "volume", "create", dockercompose.GrypeDBVolume).CombinedOutput(); err != nil {
		fmt.Printf("Warning: could not create shared grype DB volume: %v: %s\n", err, strings.TrimSpace(string(out)))
	}
	go func() {
		refresh := func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
			defer cancel()
			if err := refreshGrypeDB(ctx); err != nil {
				fmt.Printf("Warning: grype DB refresh failed: %v\n", err)
				return
			}
			fmt.Println("Shared grype vulnerability DB refreshed (daemon-managed)")
		}
		refresh()
		t := time.NewTicker(grypeRefreshInterval)
		defer t.Stop()
		for range t.C {
			refresh()
		}
	}()
}
