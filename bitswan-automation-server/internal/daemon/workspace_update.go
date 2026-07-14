package daemon

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/bitswan-space/bitswan-workspaces/internal/automations"
	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/services"
	"github.com/bitswan-space/bitswan-workspaces/internal/workspace"
	"gopkg.in/yaml.v3"
)

// currentGitopsImage returns the gitops image recorded in the workspace's
// existing deployment docker-compose.yml, or "" if it can't be determined
// (no deployment yet, unreadable/malformed file, or no image set).
//
// The AUTOMATIC regeneration paths (volume migration, AOC connect/disconnect)
// use this to carry a workspace's current image forward. Without it those paths
// call UpdateWorkspaceDeployment with an empty image, which resolves the latest
// PRODUCTION gitops (ResolveGitopsImage(false)) — silently downgrading a
// workspace pinned to a staging or otherwise-newer gitops, since the staging
// track isn't persisted in metadata.yaml. When production lags a breaking change
// (e.g. the infra-driver docker-driver cut-over) that downgrade pairs a
// pre-cut-over image with a post-cut-over compose and breaks deploys/worktrees.
// The user-facing `bitswan workspace update` is unaffected: it passes its own
// args and still resolves the latest image per --staging / --gitops-image.
func currentGitopsImage(workspaceName string) string {
	composePath := filepath.Join(
		os.Getenv("HOME"), ".config", "bitswan", "workspaces", workspaceName,
		"deployment", "docker-compose.yml",
	)
	data, err := os.ReadFile(composePath)
	if err != nil {
		return ""
	}
	var compose struct {
		Services struct {
			Gitops struct {
				Image string `yaml:"image"`
			} `yaml:"bitswan-gitops"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(data, &compose); err != nil {
		return ""
	}
	return compose.Services.Gitops.Image
}

// runWorkspaceUpdate runs the workspace update logic with stdout already
// redirected. The request is fully typed — the CLI's cobra layer is the only
// flag parser (see WorkspaceUpdateRequest). Local copies keep the body
// unchanged.
func (s *Server) runWorkspaceUpdate(req WorkspaceUpdateRequest) error {
	gitopsImage := req.GitopsImage
	dashboardImage := req.DashboardImage
	kafkaImage := req.KafkaImage
	zookeeperImage := req.ZookeeperImage
	couchdbImage := req.CouchdbImage
	staging := req.Staging
	dev := req.Dev
	trustCA := req.TrustCA
	devMode := req.DevMode
	disableDevMode := req.DisableDevMode
	gitopsDevSourceDir := req.GitopsDevSourceDir
	dashboardDevSourceDir := req.DashboardDevSourceDir

	workspaceName := req.Workspace
	if workspaceName == "" {
		return fmt.Errorf("workspace name is required")
	}
	// Use HOME directly - inside container this is /root, on host it's the user's home
	// The workspace files are mounted at /root/.config/bitswan in the container
	homeDir := os.Getenv("HOME")
	workspacePath := filepath.Join(homeDir, ".config", "bitswan", "workspaces", workspaceName)
	metadataPath := filepath.Join(workspacePath, "metadata.yaml")

	// Handle dev mode settings - update metadata if dev mode flags are provided
	if devMode || disableDevMode || gitopsDevSourceDir != "" || dashboardDevSourceDir != "" {
		fmt.Println("Updating dev mode settings...")
		metadata, err := config.GetWorkspaceMetadata(workspaceName)
		if err != nil {
			return fmt.Errorf("failed to read workspace metadata: %w", err)
		}

		if devMode {
			metadata.DevMode = true
			fmt.Println("Dev mode enabled")
		}
		if disableDevMode {
			metadata.DevMode = false
			// Clear dev source directories when disabling dev mode
			metadata.GitopsDevSourceDir = nil
			metadata.DashboardDevSourceDir = nil
			fmt.Println("Dev mode disabled")
		}
		if gitopsDevSourceDir != "" {
			metadata.GitopsDevSourceDir = &gitopsDevSourceDir
			metadata.DevMode = true
			fmt.Printf("GitOps dev source directory set to: %s\n", gitopsDevSourceDir)
		}
		if dashboardDevSourceDir != "" {
			metadata.DashboardDevSourceDir = &dashboardDevSourceDir
			metadata.DevMode = true
			fmt.Printf("Dashboard dev source directory set to: %s\n", dashboardDevSourceDir)
		}

		if err := metadata.SaveToFile(metadataPath); err != nil {
			return fmt.Errorf("failed to save workspace metadata: %w", err)
		}
	}

	// Ensure the full set of workspace volume subpaths exists before we
	// regenerate the deployment. Volume-subpath mounts are strict (Docker refuses
	// to start a container if the subpath is missing), and the set grows over
	// time — e.g. the infra-driver's bare `deploy.git` was added after the
	// bind→volume migration, so workspaces migrated before it would otherwise be
	// missing it and the driver sidecar would fail to start. The one-time
	// migration only ensures these for not-yet-migrated workspaces; doing it here
	// too makes every update self-heal an already-migrated workspace.
	ensureWorkspaceVolumeDirs(workspaceName)

	// Update Docker images and docker-compose file
	fmt.Println("Updating Docker images and docker-compose file...")
	if err := workspace.UpdateWorkspaceDeployment(workspaceName, gitopsImage, "", "", staging, dev, trustCA); err != nil {
		return fmt.Errorf("failed to update workspace deployment: %w", err)
	}
	fmt.Println("Gitops service restarted!")

	// 3. Update services if they are enabled
	fmt.Println("Checking for enabled services to update...")
	if err := updateServices(workspaceName, dashboardImage, kafkaImage, zookeeperImage, couchdbImage, staging, dev, trustCA); err != nil {
		fmt.Printf("Warning: some services failed to update: %v\n", err)
	}

	fmt.Printf("Gitops %s updated successfully!\n", workspaceName)
	return nil
}

// updateServices updates all enabled services for the workspace
func updateServices(workspaceName, dashboardImage, kafkaImage, zookeeperImage, couchdbImage string, staging, dev, trustCA bool) error {
	// Always try to update dashboard service if enabled
	fmt.Println("Checking dashboard service...")
	if err := updateDashboardService(workspaceName, dashboardImage, staging, dev, trustCA); err != nil {
		fmt.Printf("Warning: failed to update dashboard service: %v\n", err)
	} else {
		fmt.Println("Dashboard service updated successfully!")
	}

	// Always try to update the coding-agent service if enabled
	fmt.Println("Checking coding-agent service...")
	if err := updateCodingAgentService(workspaceName); err != nil {
		fmt.Printf("Warning: failed to update coding-agent service: %v\n", err)
	} else {
		fmt.Println("Coding-agent service updated successfully!")
	}

	// Always try to update Kafka service if enabled
	fmt.Println("Checking Kafka service...")
	if err := updateKafkaService(workspaceName, kafkaImage, zookeeperImage); err != nil {
		fmt.Printf("Warning: failed to update Kafka service: %v\n", err)
	} else {
		fmt.Println("Kafka service updated successfully!")
	}

	// Always try to update CouchDB service if enabled
	fmt.Println("Checking CouchDB service...")
	if err := updateCouchDBService(workspaceName, couchdbImage); err != nil {
		fmt.Printf("Warning: failed to update CouchDB service: %v\n", err)
	} else {
		fmt.Println("CouchDB service updated successfully!")
	}

	return nil
}

// updateCodingAgentService regenerates and restarts the coding-agent service
// for a workspace if it's enabled. The coding-agent has no RegenerateDockerCompose
// helper, so we re-create the compose from the persisted secret/domain and
// restart — this is what moves its containers onto the named-volume mounts.
func updateCodingAgentService(workspaceName string) error {
	svc, err := services.NewCodingAgentService(workspaceName)
	if err != nil {
		return fmt.Errorf("failed to create coding-agent service: %w", err)
	}
	if !svc.IsEnabled() {
		fmt.Printf("Coding-agent service is not enabled for workspace '%s', skipping update\n", workspaceName)
		return nil
	}
	md, err := svc.GetMetadata()
	if err != nil {
		return fmt.Errorf("failed to read workspace metadata: %w", err)
	}
	fmt.Println("Stopping current coding-agent container...")
	if err := svc.StopContainer(); err != nil {
		return fmt.Errorf("failed to stop coding-agent container: %w", err)
	}
	fmt.Println("Regenerating coding-agent docker-compose configuration...")
	content, err := svc.CreateDockerCompose(md.CodingAgentSecret, "", md.Domain)
	if err != nil {
		return fmt.Errorf("failed to regenerate coding-agent docker-compose: %w", err)
	}
	if err := svc.SaveDockerCompose(content); err != nil {
		return fmt.Errorf("failed to save coding-agent docker-compose: %w", err)
	}
	fmt.Println("Starting coding-agent container...")
	if err := svc.StartContainer(); err != nil {
		return fmt.Errorf("failed to start coding-agent container: %w", err)
	}
	return nil
}

// updateDashboardService updates the workspace-dashboard service for a specific workspace.
// Stop, regenerate compose, start.
func updateDashboardService(workspaceName, dashboardImage string, staging bool, dev bool, trustCA bool) error {
	dashboardService, err := services.NewDashboardService(workspaceName)
	if err != nil {
		return fmt.Errorf("failed to create Dashboard service: %w", err)
	}

	if !dashboardService.IsEnabled() {
		fmt.Printf("Dashboard service is not enabled for workspace '%s', skipping update\n", workspaceName)
		return nil
	}

	fmt.Println("Stopping current dashboard container...")
	if err := dashboardService.StopContainer(); err != nil {
		return fmt.Errorf("failed to stop current dashboard container: %w", err)
	}

	fmt.Println("Regenerating dashboard docker-compose configuration...")
	if err := dashboardService.RegenerateDockerCompose(dashboardImage, staging, dev, trustCA); err != nil {
		return fmt.Errorf("failed to regenerate dashboard docker-compose file: %w", err)
	}

	fmt.Println("Starting dashboard container...")
	if err := dashboardService.StartContainer(); err != nil {
		return fmt.Errorf("failed to start dashboard container: %w", err)
	}

	return nil
}

// updateKafkaService updates the Kafka service via the gitops API
func updateKafkaService(workspaceName, kafkaImage, zookeeperImage string) error {
	body := gitopsServiceRequest{
		KafkaImage: kafkaImage,
	}
	return callGitopsService(workspaceName, "kafka", "update", body)
}

// updateCouchDBService updates the CouchDB service via the gitops API
func updateCouchDBService(workspaceName, couchdbImage string) error {
	body := gitopsServiceRequest{
		Image: couchdbImage,
	}
	return callGitopsService(workspaceName, "couchdb", "update", body)
}

// callGitopsService sends a POST request to a gitops service endpoint.
func callGitopsService(workspaceName, serviceType, action string, body interface{}) error {
	metadata, err := config.GetWorkspaceMetadata(workspaceName)
	if err != nil {
		return fmt.Errorf("failed to get workspace metadata: %w", err)
	}

	gitopsPath := fmt.Sprintf("/services/%s/%s", serviceType, action)
	reqURL := fmt.Sprintf("%s%s", metadata.GitopsURL, gitopsPath)
	reqURL = automations.TransformURLForDaemon(reqURL, workspaceName)

	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("POST", reqURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+metadata.GitopsSecret)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request to gitops: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode >= 400 {
		return fmt.Errorf("gitops returned %d: %s", resp.StatusCode, string(respBody))
	}

	return nil
}
