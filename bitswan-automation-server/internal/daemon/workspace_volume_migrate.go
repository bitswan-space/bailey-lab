package daemon

import (
	"fmt"
	"os"
	"path/filepath"
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
	"deploy.git",  // infra-driver bare deploy repo (git init --bare on serve; the subpath must exist before the sidecar mounts it)
	"repo.git",    // canonical bare repo (real content created by init/migration)
	"copies",      // per-copy checkouts base
	"copies/main", // the main copy (editor working tree / main live-dev source)
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
		// `.gitserver-migrated` covers both the bind→volume move and the
		// worktree→copy / canonical-repo move, so workspaces already volume-
		// migrated under the old marker are reprocessed once to gain repo.git +
		// copies (otherwise their regenerated gitops compose can't mount them).
		marker := filepath.Join(wsDir, ".gitserver-migrated")
		if _, err := os.Stat(marker); err == nil {
			continue // already migrated
		}
		// Skip anything that isn't a fully-deployed workspace.
		if _, err := os.Stat(filepath.Join(wsDir, "deployment", "docker-compose.yml")); err != nil {
			continue
		}

		fmt.Printf("Migrating workspace %q to docker volumes + git server...\n", ws.Name)
		// Guarantee every subpath the compose will mount exists in the volume.
		ensureWorkspaceVolumeDirs(ws.Name)
		// Create the canonical bare repo + main copy from the legacy working
		// tree if they don't exist yet (idempotent — skipped once repo.git is a
		// real bare repo). Leaves the legacy workspace/ + worktrees as backup.
		if _, err := os.Stat(filepath.Join(wsDir, "repo.git", "objects")); err != nil {
			if err := setupCanonicalRepoAndMainCopy(
				ws.Name, wsDir, filepath.Join(wsDir, "workspace"), false,
			); err != nil {
				fmt.Printf("Warning: failed to set up canonical repo for %q (will retry): %v\n", ws.Name, err)
				continue
			}
		}
		if err := s.runWorkspaceUpdate([]string{ws.Name}); err != nil {
			fmt.Printf("Warning: failed to migrate workspace %q to volume mounts (will retry on next start): %v\n", ws.Name, err)
			continue
		}

		// runWorkspaceUpdate regenerates the gitops/editor/dashboard/coding-agent
		// containers onto the volume, but the deployed block-processor containers
		// keep binding the old host directory until gitops redeploys them off the
		// freshly-regenerated compose. Trigger that deploy now so no container is
		// left writing to the (backup) host path.
		if err := redeployWorkspaceAutomations(ws.Name); err != nil {
			fmt.Printf("Warning: failed to redeploy automations for workspace %q onto volume mounts (will retry on next start): %v\n", ws.Name, err)
			continue
		}

		_ = os.WriteFile(marker, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o644)
		fmt.Printf("Workspace %q now runs off the bitswan docker volume.\n", ws.Name)
	}
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
