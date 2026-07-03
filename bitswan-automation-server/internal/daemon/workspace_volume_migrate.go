package daemon

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/automations"
	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// workspaceVolumeSubdirs are the per-workspace directories that workspace
// containers mount as subpaths of the `bitswan` volume. Volume subpath mounts
// are strict — Docker fails to start a container if the subpath doesn't exist
// (unlike bind mounts, which auto-create the source). Older workspaces may be
// missing newer dirs (e.g. snapshots, worktrees), so we ensure the full set
// exists before (re)generating a workspace's deployment.
var workspaceVolumeSubdirs = []string{
	"workspace",   // legacy shared working tree (kept for the gitops state worktree)
	"gitops",      // promoted-deployment materialization/state
	"deploy.git",   // legacy single infra-driver bare deploy repo (superseded by deploy-repos/<bp>.deploy.git; kept one release for stale-compose mountability)
	"deploy-repos", // per-BP infra-driver bare deploy repos (<bp>.deploy.git; the subpath must exist before the driver sidecar mounts it)
	"git-repos",    // per-BP canonical bare repos (<bp>.git, created by gitops at BP creation / by migration)
	"repo.git",    // legacy single canonical repo (archived by the per-BP migration; kept one release so stale composes can still mount the subpath)
	"copies",      // per-copy checkouts base
	"copies/main", // the main copy (per-BP checkouts of each repo's main)
	"secrets",
	"snapshots",
	// Egress-firewall attempt telemetry (per-BP JSONL the egress gateways
	// append to and the gitops dashboard reads for "Needs review"). Shared
	// between the gitops container and the gateway containers via this volume
	// subpath, so it must exist before the gitops container mounts it.
	"firewall",
	"ssh",
	"coder-home",
	"coding-agent-home",
	"coding-agent-sessions",
}

// ensureWorkspaceVolumeDirs creates any missing standard subdirectories for a
// workspace so the volume-subpath mounts resolve. Existing dirs are left as-is.
func ensureWorkspaceVolumeDirs(workspaceName string) {
	base := filepath.Join(os.Getenv("HOME"), ".config", "bitswan", "workspaces", workspaceName)
	for _, d := range workspaceVolumeSubdirs {
		_ = os.MkdirAll(filepath.Join(base, d), 0o755)
	}
}

// migrateWorkspaceDeploymentsToVolumes regenerates each workspace's
// docker-compose onto the named-volume subpath mounts and recreates its
// containers. It's a one-time follow-up to the daemon's bind→volume data
// migration: until a workspace is regenerated its containers keep binding the
// (now-backup) host directory, so writes would diverge from the volume the
// daemon reads.
//
// Best-effort and idempotent via a per-workspace marker file: a workspace is
// processed until it succeeds (a failure leaves no marker and is retried on the
// next daemon start), and already-migrated workspaces are skipped. Runs in the
// background so it never blocks daemon startup.
func (s *Server) migrateWorkspaceDeploymentsToVolumes() {
	// Small delay so the daemon finishes coming up first.
	time.Sleep(3 * time.Second)

	list, err := GetWorkspaceList(false, false)
	if err != nil || list == nil {
		return
	}

	home := os.Getenv("HOME")
	for _, ws := range list.Workspaces {
		wsDir := filepath.Join(home, ".config", "bitswan", "workspaces", ws.Name)
		// `.gitserver-migrated` covers the bind→volume move; the per-BP-repos
		// migration has its own marker so already-volume-migrated workspaces
		// are reprocessed exactly once to split the shared repo.
		volumeMarker := filepath.Join(wsDir, ".gitserver-migrated")
		_, volumeErr := os.Stat(volumeMarker)
		volumeDone := volumeErr == nil
		perBPDone := false
		if _, err := os.Stat(filepath.Join(wsDir, perBPMigratedMarker)); err == nil {
			perBPDone = true
		}
		deploySplitDone := false
		if _, err := os.Stat(filepath.Join(wsDir, deploySplitMarker)); err == nil {
			deploySplitDone = true
		}
		if volumeDone && perBPDone && deploySplitDone {
			continue // fully migrated
		}
		// Skip anything that isn't a fully-deployed workspace.
		if _, err := os.Stat(filepath.Join(wsDir, "deployment", "docker-compose.yml")); err != nil {
			continue
		}

		fmt.Printf("Migrating workspace %q to docker volumes + per-BP git repos...\n", ws.Name)
		// Guarantee every subpath the compose will mount exists in the volume.
		ensureWorkspaceVolumeDirs(ws.Name)
		// A workspace that never got the (now legacy) canonical-repo migration
		// jumps straight to per-BP repos: seed the main copy's content from the
		// legacy working tree so the importer below has something to split.
		if !volumeDone {
			if err := seedMainCopyFromLegacyTree(wsDir); err != nil {
				fmt.Printf("Warning: failed to seed main copy for %q (will retry): %v\n", ws.Name, err)
				continue
			}
		}
		// Split the shared repo into per-BP repos (fresh-start import; the old
		// repo.git is archived). Idempotent + marker-guarded.
		if !perBPDone {
			if err := migrateToPerBPRepos(ws.Name, wsDir, user1000Runner(false)); err != nil {
				fmt.Printf("Warning: per-BP repo migration failed for %q (will retry on next start): %v\n", ws.Name, err)
				continue
			}
		}
		// Split the single deploy-state file into one bitswan.yaml + local repo
		// per BP (deploy repos are created on demand at first deploy). Idempotent
		// + marker-guarded.
		if _, err := os.Stat(filepath.Join(wsDir, deploySplitMarker)); err != nil {
			if err := migrateToPerBPDeployState(ws.Name, wsDir, user1000Runner(false)); err != nil {
				fmt.Printf("Warning: per-BP deploy-state split failed for %q (will retry on next start): %v\n", ws.Name, err)
				continue
			}
		}
		// Carry the workspace's current gitops image forward — this is a
		// mechanical data-layout regeneration, not an image upgrade. Passing no
		// image would resolve the latest PRODUCTION gitops and silently downgrade
		// a staging/newer-pinned workspace (see currentGitopsImage).
		updateArgs := []string{ws.Name}
		if img := currentGitopsImage(ws.Name); img != "" {
			updateArgs = append(updateArgs, "--gitops-image", img)
		}
		if err := s.runWorkspaceUpdate(updateArgs); err != nil {
			fmt.Printf("Warning: failed to migrate workspace %q to volume mounts (will retry on next start): %v\n", ws.Name, err)
			continue
		}

		// The host→volume move needs a redeploy so the block-processor containers
		// stop binding the old host directory. But a workspace that is ALREADY on
		// volumes (only being reprocessed to split repos / deploy state) has its
		// containers in the right place already — force-redeploying every BP there
		// is pointless AND harmful: deploy-all is synchronous per BP and the first
		// deploy of each BP waits on its DB/bucket provisioning, so a large
		// workspace stalls for many minutes and leaves BPs half-reprovisioned. Skip
		// it — each BP redeploys per-BP on its next user-triggered deploy.
		if !volumeDone {
			if err := redeployWorkspaceAutomations(ws.Name); err != nil {
				fmt.Printf("Warning: failed to redeploy automations for workspace %q onto volume mounts (will retry on next start): %v\n", ws.Name, err)
				continue
			}
		}

		_ = os.WriteFile(volumeMarker, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o644)
		fmt.Printf("Workspace %q now runs off the bitswan docker volume with per-BP repos.\n", ws.Name)
	}
}

// seedMainCopyFromLegacyTree populates copies/main with the legacy shared
// working tree's BP directories (content only, no git) when the workspace
// predates even the canonical-repo layout. The per-BP importer then splits
// them into their own repos.
func seedMainCopyFromLegacyTree(wsDir string) error {
	mainCopy := filepath.Join(wsDir, "copies", "main")
	if len(listSubdirs(mainCopy)) > 0 {
		return nil // main copy already has content
	}
	legacyTree := filepath.Join(wsDir, "workspace")
	for _, bp := range listSubdirs(legacyTree) {
		src := filepath.Join(legacyTree, bp)
		dst := filepath.Join(mainCopy, bp)
		cmd := fmt.Sprintf(`mkdir -p %q && cd %q && tar --exclude=./.git -cf - . | (cd %q && tar -xf -)`, dst, src, dst)
		if out, err := exec.Command("sh", "-c", cmd).CombinedOutput(); err != nil { //nolint:gosec
			return fmt.Errorf("seed %s: %v (%s)", bp, err, strings.TrimSpace(string(out)))
		}
	}
	_ = exec.Command("chown", "-R", "1000:1000", mainCopy).Run()
	return nil
}

// redeployWorkspaceAutomations asks the workspace's gitops service to redeploy
// all automations off its current (post-migration) docker-compose, recreating
// the block-processor containers on the bitswan volume.
//
// The gitops container was just recreated by runWorkspaceUpdate, so it may need a
// moment to start serving — we poll its automations list until it responds, which
// doubles as the readiness gate. A workspace with no deployed automations (e.g.
// infra-only) has nothing to redeploy, so we return once gitops is reachable: the
// deploy endpoint rejects an empty selection with a 500, and there are genuinely
// no block-processor containers to move off the host path.
func redeployWorkspaceAutomations(workspaceName string) error {
	metadata, err := config.GetWorkspaceMetadata(workspaceName)
	if err != nil {
		return fmt.Errorf("failed to get workspace metadata: %w", err)
	}

	const (
		attempts = 30
		interval = 3 * time.Second
	)

	// Wait for gitops to come back up, using its automations list as both the
	// readiness probe and the has-anything-to-deploy signal.
	var deployed []automations.Automation
	var lastErr error
	ready := false
	for i := 0; i < attempts; i++ {
		deployed, lastErr = automations.GetAutomations(workspaceName)
		if lastErr == nil {
			ready = true
			break
		}
		time.Sleep(interval)
	}
	if !ready {
		return fmt.Errorf("gitops did not become ready in time: %w", lastErr)
	}

	if len(deployed) == 0 {
		fmt.Printf("Workspace %q has no deployed automations; nothing to redeploy.\n", workspaceName)
		return nil
	}

	fmt.Printf("Redeploying %d automation(s) for workspace %q onto volume mounts...\n", len(deployed), workspaceName)
	return deployAutomations(metadata.GitopsURL, metadata.GitopsSecret, workspaceName, os.Stdout)
}
