package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// migrateWorkspaceDeploymentsToVolumes regenerates each workspace's
// docker-compose onto the named-volume subpath mounts and recreates its
// containers. It's a one-time follow-up to the daemon's bind→volume data
// migration: until a workspace is regenerated its containers keep binding the
// (now-backup) host directory, so writes would diverge from the volume the
// daemon reads. Regenerating + recreating points them at the volume.
//
// Idempotent and best-effort: it skips workspaces whose compose already uses
// the `bitswan` volume, runs in the background so it never blocks daemon
// startup, and logs (rather than fails) per-workspace errors.
func (s *Server) migrateWorkspaceDeploymentsToVolumes() {
	// Small delay so the daemon finishes coming up first.
	time.Sleep(3 * time.Second)

	list, err := GetWorkspaceList(false, false)
	if err != nil || list == nil {
		return
	}

	homeDir := os.Getenv("HOME")
	for _, ws := range list.Workspaces {
		composePath := filepath.Join(homeDir, ".config", "bitswan", "workspaces", ws.Name, "deployment", "docker-compose.yml")
		data, err := os.ReadFile(composePath)
		if err != nil {
			continue // not a fully-deployed workspace
		}
		// Already on the named volume → nothing to do.
		if strings.Contains(string(data), "source: bitswan") {
			continue
		}
		fmt.Printf("Migrating workspace %q deployment to docker volume mounts...\n", ws.Name)
		if err := s.runWorkspaceUpdate([]string{ws.Name}); err != nil {
			fmt.Printf("Warning: failed to migrate workspace %q to volume mounts: %v\n", ws.Name, err)
			continue
		}
		fmt.Printf("Workspace %q now runs off the bitswan docker volume.\n", ws.Name)
	}
}
