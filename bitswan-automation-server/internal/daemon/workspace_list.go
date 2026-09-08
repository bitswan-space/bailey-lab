package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/ssh"
)

// workspaceInventory is the workspace list the ACL-filtered views start from
// (the accessible-workspaces list, the admin Updates view and the endpoints
// page's workspace grouping). It is a var so tests can install a fixed
// inventory: the real implementation walks ~/.config/bitswan/workspaces on the
// machine, which under test is empty, and a view whose loop never runs cannot
// prove anything about what it lists or withholds (#367).
//
// Only READ views use this seam. syncWorkspaceListToAOC deliberately keeps
// calling GetWorkspaceList directly: AOC deletes every workspace the list
// omits, so that caller must always see the real machine, never a fake.
var workspaceInventory = func() (*WorkspaceListResponse, error) {
	return GetWorkspaceList(false, false)
}

// GetWorkspaceList returns a list of workspaces with optional detailed information
func GetWorkspaceList(long, showPasswords bool) (*WorkspaceListResponse, error) {
	// Use HOME for file operations (works inside container and outside)
	// The workspace files are accessible via the container path
	homeDir := os.Getenv("HOME")
	bitswanDir := filepath.Join(homeDir, ".config", "bitswan")
	workspacesDir := filepath.Join(bitswanDir, "workspaces")

	var workspaces []WorkspaceInfo

	// Check if workspaces directory exists
	if _, err := os.Stat(workspacesDir); !os.IsNotExist(err) {
		files, err := os.ReadDir(workspacesDir)
		if err != nil {
			return nil, fmt.Errorf("failed to read workspaces directory: %w", err)
		}
		for _, file := range files {
			if file.IsDir() {
				workspaceName := file.Name()
				workspaceInfo := WorkspaceInfo{
					Name: workspaceName,
				}

				if long {
					// Get metadata
					domain, gitopsURL := getMetaData(workspaceName, workspacesDir)
					workspaceInfo.Domain = domain
					workspaceInfo.GitopsURL = gitopsURL

					// Get SSH public key
					workspacePath := filepath.Join(workspacesDir, workspaceName)
					if ssh.SSHKeyExists(workspacePath) {
						publicKey, err := ssh.GetSSHPublicKey(workspacePath)
						if err == nil {
							workspaceInfo.SSHPublicKey = strings.TrimSpace(publicKey)
						}
					}
				}

				if showPasswords {
					// Get GitOps secret
					gitopsSecret, _ := getGitOpsSecret(workspaceName)
					workspaceInfo.GitopsSecret = gitopsSecret
				}

				workspaces = append(workspaces, workspaceInfo)
			}
		}
	}

	// Get active workspace
	cfg := config.NewAutomationServerConfig()
	activeWorkspace, _ := cfg.GetActiveWorkspace()

	return &WorkspaceListResponse{
		Workspaces:      workspaces,
		ActiveWorkspace: activeWorkspace,
	}, nil
}

func getMetaData(workspaceName string, workspacesDir string) (string, string) {
	// Path to metadata.yaml file
	metadataPath := filepath.Join(workspacesDir, workspaceName, "metadata.yaml")

	// Check if metadata file exists
	if _, err := os.Stat(metadataPath); os.IsNotExist(err) {
		return "", ""
	}

	// Read metadata file
	data, err := os.ReadFile(metadataPath)
	if err != nil {
		return "", ""
	}

	// Parse YAML
	var metadata struct {
		Domain    string `yaml:"domain"`
		GitopsURL string `yaml:"gitops-url"`
	}

	if err := yaml.Unmarshal(data, &metadata); err != nil {
		return "", ""
	}

	return metadata.Domain, metadata.GitopsURL
}

func getGitOpsSecret(workspace string) (string, error) {
	return config.ComposeGitopsEnvValue(workspace, "BITSWAN_GITOPS_SECRET")
}
