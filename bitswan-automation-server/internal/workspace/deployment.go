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

// UpdateWorkspaceDeployment updates the workspace deployment with new AOC configuration
func UpdateWorkspaceDeployment(workspaceName string, customGitopsImage string, customEgressGatewayImage string, staging bool, dev bool, trustCA bool) error {
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

	// Resolve the egress-gateway image the same staging/dev-aware way, so a
	// `workspace update` re-pins it to a current version instead of leaving it at
	// whatever was baked before (or falling back to :latest).
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
