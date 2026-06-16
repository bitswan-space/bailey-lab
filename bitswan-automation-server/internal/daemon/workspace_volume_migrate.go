package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// workspaceVolumeSubdirs are the per-workspace directories that workspace
// containers mount as subpaths of the `bitswan` volume. Volume subpath mounts
// are strict — Docker fails to start a container if the subpath doesn't exist
// (unlike bind mounts, which auto-create the source). Older workspaces may be
// missing newer dirs (e.g. snapshots, worktrees), so we ensure the full set
// exists before (re)generating a workspace's deployment.
var workspaceVolumeSubdirs = []string{
	"workspace",
	"workspace/worktrees",
	"gitops",
	"secrets",
	"snapshots",
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
		marker := filepath.Join(wsDir, ".volume-migrated")
		if _, err := os.Stat(marker); err == nil {
			continue // already migrated
		}
		// Skip anything that isn't a fully-deployed workspace.
		if _, err := os.Stat(filepath.Join(wsDir, "deployment", "docker-compose.yml")); err != nil {
			continue
		}

		fmt.Printf("Migrating workspace %q deployment to docker volume mounts...\n", ws.Name)
		// Guarantee every subpath the compose will mount exists in the volume.
		ensureWorkspaceVolumeDirs(ws.Name)
		if err := s.runWorkspaceUpdate([]string{ws.Name}); err != nil {
			fmt.Printf("Warning: failed to migrate workspace %q to volume mounts (will retry on next start): %v\n", ws.Name, err)
			continue
		}
		_ = os.WriteFile(marker, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o644)
		fmt.Printf("Workspace %q now runs off the bitswan docker volume.\n", ws.Name)
	}
}
