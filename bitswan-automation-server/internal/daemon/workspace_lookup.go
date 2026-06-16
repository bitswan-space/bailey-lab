package daemon

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// findWorkspaceNameByID resolves a workspace's local name from its AOC
// workspace ID by scanning the per-workspace metadata under
// ~/.config/bitswan/workspaces. Returns an error if no workspace matches.
func findWorkspaceNameByID(workspaceID string) (string, error) {
	homeDir := os.Getenv("HOME")
	workspacesDir := filepath.Join(homeDir, ".config", "bitswan", "workspaces")

	if _, err := os.Stat(workspacesDir); os.IsNotExist(err) {
		return "", fmt.Errorf("workspaces directory does not exist")
	}

	files, err := os.ReadDir(workspacesDir)
	if err != nil {
		return "", fmt.Errorf("failed to read workspaces directory: %w", err)
	}

	for _, file := range files {
		if !file.IsDir() {
			continue
		}
		workspaceName := file.Name()
		metadata, err := config.GetWorkspaceMetadata(workspaceName)
		if err != nil {
			continue // skip workspaces without metadata
		}
		if metadata.WorkspaceId != nil && *metadata.WorkspaceId == workspaceID {
			return workspaceName, nil
		}
	}

	return "", fmt.Errorf("workspace with ID %s not found", workspaceID)
}
