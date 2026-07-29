package daemon

import (
	"context"
	"fmt"
	"math/rand"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/daemon/backup"
)

// Nightly server-level backups (see internal/daemon/backup). The daemon owns
// the schedule — workspaces run no backup jobs. Grype-refresher style:
// best-effort, background, never blocks startup.

// backupRunHour is the nightly run time (02:00 UTC — the slot gitops used).
const backupRunHour = 2

// backupJitterMax spreads fleets sharing one AOC/S3 endpoint so they don't
// all hit it at exactly 02:00.
const backupJitterMax = 10 * time.Minute

// backupCatchUpAge: on daemon start, a last run older than this (or none at
// all) triggers a catch-up run after a short settle delay — a server that
// was off overnight still gets its backup.
const backupCatchUpAge = 26 * time.Hour

// backupRunTimeout bounds one whole run; generous — a large workspace set
// with cold restic caches can be slow.
const backupRunTimeout = 4 * time.Hour

// untilNextBackup computes the wait until the next HH:00 UTC slot.
func untilNextBackup(now time.Time) time.Duration {
	next := time.Date(now.Year(), now.Month(), now.Day(), backupRunHour, 0, 0, 0, time.UTC)
	if !next.After(now) {
		next = next.Add(24 * time.Hour)
	}
	return next.Sub(now)
}

// startBackupScheduler self-enables backups (AOC-connected servers get them
// by default), runs a catch-up when the last run is missing/stale, then runs
// nightly at 02:00 UTC + jitter.
func (s *Server) startBackupScheduler(engine *backup.Engine) {
	go func() {
		// Self-enable off the startup path (it does network I/O: key
		// escrow check, repo init).
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		status, err := backup.EnsureEnabled(ctx)
		cancel()
		if err != nil {
			fmt.Printf("Warning: backup self-enable: %v\n", err)
		}
		if !status.Runnable() && status.Reason != "" {
			fmt.Printf("Server-level backups inactive: %s\n", status.Reason)
		}

		run := func(kind string) {
			ctx, cancel := context.WithTimeout(context.Background(), backupRunTimeout)
			defer cancel()
			report, err := engine.RunAll(ctx, func(line string) {
				fmt.Println("[backup] " + line)
			})
			if err != nil {
				fmt.Printf("Warning: %s backup run failed: %v\n", kind, err)
				return
			}
			if !report.OK {
				fmt.Printf("Warning: %s backup run finished with errors\n", kind)
			}
		}

		// Catch-up: no run recorded, or the last one is stale.
		if status.Runnable() {
			last, err := backup.LoadLastRun()
			if err != nil {
				fmt.Printf("Warning: could not read last backup run: %v\n", err)
			}
			if last == nil || time.Since(last.FinishedAt) > backupCatchUpAge {
				time.Sleep(5 * time.Minute) // let workspaces come up first
				run("catch-up")
			}
		}

		for {
			time.Sleep(untilNextBackup(time.Now().UTC()) + time.Duration(rand.Int63n(int64(backupJitterMax))))
			status, err := backup.EnsureEnabled(context.Background())
			if err != nil {
				fmt.Printf("Warning: backup ensure: %v\n", err)
			}
			if !status.Runnable() {
				continue
			}
			run("nightly")
		}
	}()
}
