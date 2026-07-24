package workspace

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/dockercompose"
	"github.com/bitswan-space/bitswan-workspaces/internal/dockerhub"
	"gopkg.in/yaml.v3"
)

// composeRollbackSuffix names the single previous-version snapshot kept beside a
// workspace's docker-compose.yml. `bitswan workspace update` saves the current
// compose here before regenerating; `bitswan rollback` restores it.
const composeRollbackSuffix = ".rollback"

func workspaceDeploymentDir(workspaceName string) string {
	return filepath.Join(os.Getenv("HOME"), ".config", "bitswan", "workspaces", workspaceName, "deployment")
}

// SnapshotWorkspaceCompose saves the workspace's current docker-compose.yml as a
// rollback point. Called right before a user-initiated `workspace update`
// regenerates the compose, so a rollback can return to the exact pre-update
// image pins. A missing compose (never deployed) is a no-op — there is nothing
// to roll back to yet.
func SnapshotWorkspaceCompose(workspaceName string) error {
	composePath := filepath.Join(workspaceDeploymentDir(workspaceName), "docker-compose.yml")
	data, err := os.ReadFile(composePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("failed to read docker-compose.yml for snapshot: %w", err)
	}
	if err := os.WriteFile(composePath+composeRollbackSuffix, data, 0644); err != nil {
		return fmt.Errorf("failed to write rollback snapshot: %w", err)
	}
	return nil
}

// RollbackWorkspaceDeployment restores the previous docker-compose.yml snapshot
// and re-deploys. The swap is reversible: the current (post-update) compose
// becomes the new rollback target, so a second `bitswan rollback` re-applies the
// update. This is deliberately CLI-only — a wrong rollback should require host
// access, not a browser click.
func RollbackWorkspaceDeployment(workspaceName string) error {
	deployDir := workspaceDeploymentDir(workspaceName)
	composePath := filepath.Join(deployDir, "docker-compose.yml")
	backupPath := composePath + composeRollbackSuffix

	snapshot, err := os.ReadFile(backupPath)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("no rollback snapshot for %q — nothing to roll back to (one is saved automatically on the next `bitswan workspace update`)", workspaceName)
		}
		return fmt.Errorf("failed to read rollback snapshot: %w", err)
	}
	current, err := os.ReadFile(composePath)
	if err != nil {
		return fmt.Errorf("failed to read current docker-compose.yml: %w", err)
	}

	if err := os.WriteFile(composePath, snapshot, 0644); err != nil {
		return fmt.Errorf("failed to restore rollback snapshot: %w", err)
	}
	// Keep the just-replaced version as the new rollback target so rollback is
	// reversible rather than one-way.
	if err := os.WriteFile(backupPath, current, 0644); err != nil {
		return fmt.Errorf("failed to update rollback snapshot: %w", err)
	}

	projectName := workspaceName + "-site"
	fmt.Println("Rolling back to the previous deployment...")
	downCmd := exec.Command("docker", "compose", "down")
	downCmd.Dir = deployDir
	downCmd.Stdout = os.Stdout
	downCmd.Stderr = os.Stderr
	if err := downCmd.Run(); err != nil {
		return fmt.Errorf("failed to stop containers: %w", err)
	}
	upCmd := exec.Command("docker", "compose", "-p", projectName, "up", "-d", "--remove-orphans")
	upCmd.Dir = deployDir
	upCmd.Stdout = os.Stdout
	upCmd.Stderr = os.Stderr
	if err := upCmd.Run(); err != nil {
		return fmt.Errorf("failed to start containers: %w", err)
	}
	fmt.Println("Rollback complete.")
	return nil
}

// UpdateWorkspaceDeployment updates the workspace deployment with new AOC configuration
func UpdateWorkspaceDeployment(workspaceName string, customGitopsImage string, customInfraDriverImage string, customEgressGatewayImage string, staging bool, dev bool, trustCA bool) error {
	// Use HOME for file operations (works inside container and outside)
	// The workspace files are accessible via the container path
	homeDir := os.Getenv("HOME")
	workspacePath := filepath.Join(homeDir, ".config", "bitswan", "workspaces", workspaceName)
	metadataPath := filepath.Join(workspacePath, "metadata.yaml")

	// Read metadata
	data, err := os.ReadFile(metadataPath)
	if err != nil {
		return fmt.Errorf("failed to read metadata.yaml: %w", err)
	}

	var metadata config.WorkspaceMetadata
	if err := yaml.Unmarshal(data, &metadata); err != nil {
		return fmt.Errorf("failed to unmarshal metadata.yaml: %w", err)
	}

	// Prepare AOC environment variables
	var aocEnvVars []string
	aocClient, err := aoc.NewAOCClient()
	if err == nil && metadata.WorkspaceId != nil {
		automationServerToken, err := aocClient.GetAutomationServerToken()
		if err != nil {
			// AOC is not configured or token is not available, skip AOC env vars
			// This is not a fatal error - workspace can function without AOC
		} else {
			aocEnvVars = aocClient.GetAOCEnvironmentVariables(*metadata.WorkspaceId, automationServerToken)
		}
	}

	// Get gitops image - use custom image if provided, otherwise get latest
	var gitopsImage string
	if customGitopsImage != "" {
		gitopsImage = customGitopsImage
		fmt.Printf("Using custom gitops image: %s\n", gitopsImage)
	} else {
		var err error
		gitopsImage, err = dockerhub.ResolveGitopsImage(staging, dev)
		if err != nil {
			fmt.Printf("    ⚠️  Failed to get latest gitops image, using 'latest': %v\n", err)
			if dev {
				gitopsImage = "bitswan/gitops-dev:latest"
			} else if staging {
				gitopsImage = "bitswan/gitops-staging:latest"
			} else {
				gitopsImage = "bitswan/gitops:latest"
			}
		}
	}

	// Resolve the infra-driver + egress-gateway images the same staging/dev-aware
	// way, so a `workspace update` re-pins them to a current version instead of
	// leaving them at whatever was baked before (or falling back to :latest).
	infraDriverImage := customInfraDriverImage
	if infraDriverImage == "" {
		var err error
		infraDriverImage, err = dockerhub.ResolveInfraDriverImage(staging, dev)
		if err != nil {
			fmt.Printf("    ⚠️  Failed to get latest infra-driver image, using 'latest': %v\n", err)
			if dev {
				infraDriverImage = "bitswan/infra-driver-dev:latest"
			} else if staging {
				infraDriverImage = "bitswan/infra-driver-staging:latest"
			} else {
				infraDriverImage = "bitswan/infra-driver:latest"
			}
		}
	}
	egressGatewayImage := customEgressGatewayImage
	if egressGatewayImage == "" {
		var err error
		egressGatewayImage, err = dockerhub.ResolveEgressGatewayImage(staging, dev)
		if err != nil {
			fmt.Printf("    ⚠️  Failed to get latest egress-gateway image, using 'latest': %v\n", err)
			if dev {
				egressGatewayImage = "bitswan/egress-gateway-dev:latest"
			} else if staging {
				egressGatewayImage = "bitswan/egress-gateway-staging:latest"
			} else {
				egressGatewayImage = "bitswan/egress-gateway:latest"
			}
		}
	}

	// Get GitOps dev source directory if set
	var gitopsDevSourceDir string
	if metadata.GitopsDevSourceDir != nil {
		gitopsDevSourceDir = *metadata.GitopsDevSourceDir
	}

	// Pass container path to CreateDockerComposeFileWithSecret
	// It needs container path for file operations, but will convert to host path for volume mounts
	// Create docker-compose configuration
	config := &dockercompose.DockerComposeConfig{
		GitopsPath:    workspacePath,
		WorkspaceName: workspaceName,
		GitopsImage:   gitopsImage,
		Domain:        metadata.Domain,
		// Carry the coding-agent secret into gitops's env so it can verify agent
		// requests. Post-cut-over gitops has no docker.sock to discover it by
		// inspecting the coding-agent container, so it relies SOLELY on this env;
		// omitting it (as this update path used to) makes every coding-agent call
		// 401 "Invalid agent token" after a `workspace update`. The init path
		// already sets this — the update path must too, or it strips it.
		CodingAgentSecret:  metadata.CodingAgentSecret,
		InfraDriverImage:   infraDriverImage,
		EgressGatewayImage: egressGatewayImage,
		AocEnvVars:         aocEnvVars,
		GitopsDevSourceDir: gitopsDevSourceDir,
		TrustCA:            trustCA,
	}

	// Use existing gitops secret
	compose, _, err := config.CreateDockerComposeFileWithSecret(metadata.GitopsSecret)
	if err != nil {
		return fmt.Errorf("failed to create docker-compose file: %w", err)
	}

	// Write the new docker-compose file
	dockerComposeFilePath := filepath.Join(workspacePath, "deployment", "docker-compose.yml")
	if err := os.WriteFile(dockerComposeFilePath, []byte(compose), 0755); err != nil {
		return fmt.Errorf("failed to write docker-compose file: %w", err)
	}

	// Restart gitops service
	dockerComposePath := filepath.Join(workspacePath, "deployment")
	projectName := workspaceName + "-site"

	fmt.Println("Stopping existing GitOps containers...")
	downCmd := exec.Command("docker", "compose", "down")
	downCmd.Dir = dockerComposePath
	downCmd.Stdout = os.Stdout
	downCmd.Stderr = os.Stderr
	if err := downCmd.Run(); err != nil {
		return fmt.Errorf("failed to stop containers: %w", err)
	}
	fmt.Println("GitOps containers stopped.")

	fmt.Println("Starting GitOps containers...")
	upCmd := exec.Command("docker", "compose", "-p", projectName, "up", "-d", "--remove-orphans")
	upCmd.Dir = dockerComposePath
	upCmd.Stdout = os.Stdout
	upCmd.Stderr = os.Stderr
	if err := upCmd.Run(); err != nil {
		return fmt.Errorf("failed to start containers: %w", err)
	}
	fmt.Println("GitOps containers restarted successfully!")

	return nil
}
