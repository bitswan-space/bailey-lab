package cmd

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/cmd/automationserverdaemon"
	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
	"github.com/bitswan-space/bitswan-workspaces/internal/daemon"
	"github.com/bitswan-space/bitswan-workspaces/internal/daemon/backup"
)

// Phases 1-5 of `bitswan recover server`, plus the step printer they share.
// Phase 0 and the flag surface live in recover_server.go.

// stepFunc runs one named step, records it and reports whether it succeeded.
type stepFunc func(name string, fn func() (string, error)) bool

// newStepPrinter produces the same `[step] outcome` stream the workspace recovery
// prints, so a server recovery reads the way operators already expect. The report
// is persisted after every step: a recovery that dies halfway should still leave a
// record of how far it got.
func newStepPrinter(report *daemon.RecoverReport) stepFunc {
	return func(name string, fn func() (string, error)) bool {
		started := time.Now()
		out, err := fn()
		entry := daemon.RecoverStep{
			Name:     name,
			Success:  err == nil,
			Output:   out,
			Duration: time.Since(started).Round(time.Millisecond).String(),
		}
		if err != nil {
			entry.Output = strings.TrimSpace(out + " " + err.Error())
			fmt.Printf("[%s] FAILED: %s\n", name, entry.Output)
		} else if out != "" {
			fmt.Printf("[%s] %s\n", name, out)
		} else {
			fmt.Printf("[%s] ok\n", name)
		}
		report.Steps = append(report.Steps, entry)
		daemon.PersistServerRecoverReport(report)
		return err == nil
	}
}

// stepFailure is the reason the most recent failing step gave.
//
// Phases wrap it into the error they return, so the cause survives into a log or
// a script's stderr instead of only reaching the operator's screen.
func stepFailure(report *daemon.RecoverReport) string {
	for i := len(report.Steps) - 1; i >= 0; i-- {
		if !report.Steps[i].Success {
			return report.Steps[i].Output
		}
	}
	return ""
}

// failedPhase builds a phase-level error that carries the step's own reason.
func failedPhase(report *daemon.RecoverReport, what string) error {
	if reason := stepFailure(report); reason != "" {
		return fmt.Errorf("%s: %s", what, reason)
	}
	return fmt.Errorf("%s", what)
}

func skipStep(report *daemon.RecoverReport, name, why string) {
	report.Steps = append(report.Steps, daemon.RecoverStep{
		Name: name, Success: true, Skipped: true, Output: why,
	})
	fmt.Printf("[%s] skipped: %s\n", name, why)
}

func finishServerReport(report *daemon.RecoverReport) {
	report.FinishedAt = time.Now().UTC()
	daemon.PersistServerRecoverReport(report)
}

// --- phase 1: the server's own state, before any daemon exists ---------------

func recoverServerRestoreState(ctx context.Context, st *recoverServerState, step stepFunc) error {
	o := st.opts
	image := o.image
	if image == "" {
		// The manifest names the image whose restic wrote this repo, which is the
		// one guaranteed to read it back.
		image = st.manifest.DaemonImage
	}

	if !step("volume", func() (string, error) {
		if err := automationserverdaemon.EnsureDockerVolume(backup.BitswanConfigVolume); err != nil {
			return "", err
		}
		return backup.BitswanConfigVolume + " ready", nil
	}) {
		return failedPhase(st.report, "could not create the config volume")
	}

	if !step("state", func() (string, error) {
		restoreCtx, cancel := context.WithTimeout(ctx, recoverServerRestoreWait)
		defer cancel()

		restic := newDaemonlessResticWithVolume(
			o.aocAPI, o.serverID, st.token, st.key, image)

		summary, err := backup.RestoreServerState(restoreCtx, restic, o.snapshot)
		if err != nil {
			return "", err
		}
		if err := backup.CheckRestoredServerState(restoreCtx, image); err != nil {
			return "", err
		}
		return summary, nil
	}) {
		return failedPhase(st.report, "could not restore the server's state")
	}

	if !step("database", func() (string, error) {
		return backup.PromoteBaileyDatabase(ctx, image)
	}) {
		return failedPhase(st.report, "could not put the Bailey database in place")
	}

	if !step("key", func() (string, error) {
		return backup.InstallResticKey(ctx, image, st.key)
	}) {
		return failedPhase(st.report, "could not install the backup encryption key")
	}

	return nil
}

// --- phase 2: the daemon ------------------------------------------------------

func recoverServerDeployDaemon(ctx context.Context, st *recoverServerState, step stepFunc) error {
	if !step("image-pins", func() (string, error) {
		// These live ONLY in the daemon container's environment, and
		// startDaemonContainer forwards whatever is in ours — so a recovery that
		// doesn't re-export them silently rebuilds the server on Docker Hub
		// `latest` instead of the operator's pinned images.
		if len(st.manifest.ImagePins) == 0 {
			return "none recorded", nil
		}
		var applied []string
		for _, name := range sortedKeys(st.manifest.ImagePins) {
			if err := os.Setenv(name, st.manifest.ImagePins[name]); err != nil {
				return "", err
			}
			applied = append(applied, name)
		}
		return "re-applied " + strings.Join(applied, ", "), nil
	}) {
		return failedPhase(st.report, "could not re-apply the recorded image pins")
	}

	if !step("daemon", func() (string, error) {
		if err := automationserverdaemon.EnsureDaemonRunning(); err != nil {
			return "", err
		}
		client, err := newDaemonClientWithRetry()
		if err != nil {
			return "", err
		}
		st.client = client
		return "running and reachable", nil
	}) {
		return failedPhase(st.report, "the daemon did not come up")
	}

	return nil
}

// --- phase 3: credentials, ingress, protected proxy, relay -------------------

func recoverServerBringUpIngress(ctx context.Context, st *recoverServerState, step stepFunc) error {
	o := st.opts

	// The restored config carries the OLD token. Swap in the new one and nothing
	// else: domain, proxied and the relay details are already right, and half of
	// them aren't recorded anywhere but that file.
	if st.resumed {
		skipStep(st.report, "credentials", "the stored token is already current")
	} else if !step("credentials", func() (string, error) {
		if err := st.client.SetAOCCredentials(st.token, st.expires); err != nil {
			return "", err
		}
		return "new token stored; the rest of the registration untouched", nil
	}) {
		return failedPhase(st.report, "could not store the new AOC credentials")
	}

	domain := st.manifest.Domain
	if domain == "" {
		skipStep(st.report, "ingress", "this server has no domain configured")
		return nil
	}

	if !step("ingress", func() (string, error) {
		if _, err := st.client.InitIngress(false); err != nil {
			return "", err
		}
		return "Traefik reconfigured on the restored route table", nil
	}) {
		// Not fatal: the routes are restored on disk and the daemon retries this
		// on its own schedule. Losing the wildcard resolver is worth reporting,
		// not worth abandoning a recovery for.
		st.report.Warnings = append(st.report.Warnings,
			"ingress init failed; routes are restored but TLS may be incomplete")
	}

	if !step("ingress-ready", func() (string, error) {
		if err := st.client.WaitForIngress("bailey."+domain, recoverServerIngressWait); err != nil {
			return "", err
		}
		return "serving bailey." + domain, nil
	}) {
		// Everything below talks to the AOC through this ingress on a
		// self-hosted-AOC topology, so say so plainly and carry on — the steps
		// are idempotent and re-runnable.
		st.report.Warnings = append(st.report.Warnings,
			"ingress was not serving yet; the steps below may need a re-run")
	}

	// Nothing on the daemon's boot path ever creates this. Without it every
	// protected hostname — the Bailey console included — answers 502.
	if !step("protected-proxy", func() (string, error) {
		if err := st.client.ProvisionProtectedProxy(); err != nil {
			return "", err
		}
		return "provisioned; endpoints authenticate through Bailey again", nil
	}) {
		st.todo = append(st.todo,
			"run `bitswan ingress provision-protected-proxy` — protected endpoints "+
				"(including the Bailey console) will answer 502 until it succeeds")
	}

	// The AOC has to repoint DNS: this is a different machine with a different IP.
	if !step("dns", func() (string, error) {
		client, err := aoc.NewAOCClientWithToken(o.aocAPI, o.serverID, st.token)
		if err != nil {
			return "", err
		}
		status, err := client.ReportBaileyURL("https://bailey."+domain, false)
		if err != nil {
			return "", err
		}
		if status == "proxied" {
			if err := st.client.StartRelayTunnel(); err != nil {
				return "proxied", fmt.Errorf("relay tunnel did not start: %w", err)
			}
			return "reported; reached through the AOC relay (tunnel started)", nil
		}
		return "reported; the AOC points DNS at this machine", nil
	}) {
		st.todo = append(st.todo,
			"tell the AOC where this server is: DNS may still point at the lost machine")
	}

	return nil
}

// --- phase 4: workspaces ------------------------------------------------------

// listWorkspacesForRecovery reads the live workspace list, tolerating a daemon we
// never reached. The result only feeds an advisory note.
func listWorkspacesForRecovery(st *recoverServerState) (*daemon.WorkspaceListResponse, error) {
	if st.client == nil {
		return nil, fmt.Errorf("no daemon client")
	}
	return st.client.ListWorkspaces(false, false)
}

// recoverServerLoadImages loads the saved business-process images back onto this
// machine, so the workspace converges find the tags their bitswan.yaml pins already
// present. A seam so the phase order can be tested without docker.
var recoverServerLoadImages = func(ctx context.Context, st *recoverServerState) (string, error) {
	o := st.opts
	image := o.image
	if image == "" {
		image = st.manifest.DaemonImage
	}
	loadCtx, cancel := context.WithTimeout(ctx, recoverServerRestoreWait)
	defer cancel()

	restic := newDaemonlessRestic(o.aocAPI, o.serverID, st.token, st.key, image)
	result, err := backup.RestoreImages(loadCtx, restic, o.snapshot)
	if err != nil {
		return "", err
	}
	if result.Missing {
		// A snapshot from before image backups existed, or a server with them
		// switched off. Every image is still reachable through a rebuild.
		return "the backup holds no image archive — images will be rebuilt", nil
	}
	return fmt.Sprintf("%d image tag(s) loaded", len(result.Loaded)), nil
}

func recoverServerWorkspaces(ctx context.Context, st *recoverServerState, step stepFunc) error {
	if st.opts.skipWS {
		skipStep(st.report, "workspaces", "--skip-workspaces")
		return nil
	}

	// Before any workspace converges. The compiler emits `image:` for BP app
	// services with no `build:` and no `pull_policy`, so a missing image makes
	// compose try to pull `internal/…` from Docker Hub and the whole converge
	// fails — a load afterwards would never be reached. gitops still rebuilds
	// whatever is not in the archive, so this step never blocks the recovery.
	if !step("images", func() (string, error) {
		return recoverServerLoadImages(ctx, st)
	}) {
		// Recorded red and carried on deliberately: everything here is
		// reconstructible from the recorded revisions, which is what the rebuild
		// pass is for.
		fmt.Println("Note: continuing without the saved images — gitops will rebuild " +
			"what the deployments pin.")
		st.report.Warnings = append(st.report.Warnings,
			"saved business-process images could not be loaded; they will be rebuilt")
	}

	names := recoverServerWorkspaceNames(st)
	if len(names) == 0 {
		skipStep(st.report, "workspaces", "the backup records no workspaces")
		return nil
	}

	// A workspace in the manifest but absent from the restored server is a real
	// finding — its own snapshot may be missing — so name it instead of quietly
	// recovering fewer workspaces than the operator expects. Advisory only: never
	// let the cross-check itself stop a recovery.
	if live, err := listWorkspacesForRecovery(st); err == nil && live != nil {
		present := map[string]bool{}
		for _, ws := range live.Workspaces {
			present[ws.Name] = true
		}
		var missing []string
		for _, name := range names {
			if !present[name] {
				missing = append(missing, name)
			}
		}
		if len(missing) > 0 {
			fmt.Printf("Note: %s recorded in the backup but not yet on this server — "+
				"recovering will restore them from their own snapshots\n", strings.Join(missing, ", "))
		}
	}

	for i, name := range names {
		fmt.Printf("\n--- workspace %d/%d: %s\n", i+1, len(names), name)
		ws := name
		if !step("workspace:"+ws, func() (string, error) {
			req := daemon.RecoverRequest{
				Workspace: ws,
				Force:     true,
				// Images only ever existed on the lost machine, so unless the
				// operator opted out, the converge has to build them or it fails
				// on a pull of a local-only tag.
				RebuildImages: !st.opts.skipBuild,
			}
			if err := recoverServerRecoverOneWorkspace(st.client, req); err != nil {
				return "", err
			}
			return "recovered", nil
		}) {
			// Fail-fast: a half-recovered workspace usually means something
			// systemic (an unreadable snapshot, a wedged driver), and grinding
			// through the rest buries the cause.
			remaining := names[i+1:]
			if len(remaining) > 0 {
				fmt.Printf("\nStopping: %d workspace(s) not attempted (%s)\n",
					len(remaining), strings.Join(remaining, ", "))
			}
			finishServerReport(st.report)
			return fmt.Errorf("workspace %s failed to recover; re-run this command to "+
				"continue where it stopped", ws)
		}
	}

	if st.opts.skipBuild {
		st.todo = append(st.todo,
			"rebuild business-process images (--skip-image-rebuild was set): their "+
				"containers cannot start until an image exists for each")
	}
	return nil
}

// --- phase 5: verify ----------------------------------------------------------

// recoverServerVerify never fails the recovery: everything here is a check on
// work already done, and an operator mid-incident is better served by a report
// than by a non-zero exit.
func recoverServerVerify(ctx context.Context, st *recoverServerState, step stepFunc) {
	domain := st.manifest.Domain
	if domain == "" {
		return
	}

	// The same acceptance gate register uses: the certificate the world is served
	// must be byte-identical to our own Traefik's, so a rebuilt server is not
	// declared recovered while DNS still points at the machine it replaced.
	step("endpoint", func() (string, error) {
		deadline := time.Now().Add(recoverServerVerifyWait)
		var lastReason string
		for {
			result, err := st.client.VerifyEndpoint()
			switch {
			case err == nil && result.OK:
				return fmt.Sprintf("https://bailey.%s is live — certificate issued by %q, "+
					"verified end to end", domain, result.Issuer), nil
			case err != nil:
				lastReason = err.Error()
			default:
				// Pending is normal while DNS settles or a cert issues.
				lastReason = result.Error
			}
			if time.Now().After(deadline) {
				return "", fmt.Errorf("not verified within %s: %s",
					recoverServerVerifyWait, lastReason)
			}
			time.Sleep(5 * time.Second)
		}
	})

	step("routes", func() (string, error) {
		if len(st.manifest.Routes) == 0 {
			return "none recorded to compare against", nil
		}
		return fmt.Sprintf("%d hostname(s) recorded in the backup; the restored "+
			"route table drives Traefik", len(st.manifest.Routes)), nil
	})

	// The mkcert CA is deliberately not backed up — a CA signing key does not
	// belong in off-site storage — so on a .localhost setup this differs BY
	// DESIGN. Say that, rather than letting it read as corruption.
	if st.manifest.MkcertCAFingerprint != "" {
		skipStep(st.report, "local-ca",
			"the mkcert CA is deliberately not backed up; a new one was minted")
		st.todo = append(st.todo,
			"re-trust the new local CA on developer machines if this server serves "+
				".localhost names (the old one was "+st.manifest.MkcertCAFingerprint+")")
	}
}

func printRecoverServerSummary(st *recoverServerState) {
	fmt.Println("\n" + strings.Repeat("─", 68))
	fmt.Printf("Recovered automation server %s", orDash(st.manifest.ServerID))
	if st.manifest.Domain != "" {
		fmt.Printf(" (%s)", st.manifest.Domain)
	}
	fmt.Printf(" in %s\n", st.report.FinishedAt.Sub(st.report.StartedAt).Round(time.Second))

	var failed []string
	for _, s := range st.report.Steps {
		if !s.Success {
			failed = append(failed, s.Name)
		}
	}
	if len(failed) > 0 {
		fmt.Printf("\nSteps that did not succeed: %s\n", strings.Join(failed, ", "))
	}
	for _, w := range st.report.Warnings {
		fmt.Printf("Warning: %s\n", w)
	}

	if len(st.todo) > 0 {
		fmt.Println("\nYou must still do:")
		for _, item := range st.todo {
			fmt.Printf("  • %s\n", item)
		}
	}
	if st.manifest.Domain != "" {
		fmt.Printf("\nConsole: https://bailey.%s\n", st.manifest.Domain)
	}
	fmt.Println("Verify production business processes by hand before trusting them.")
}
