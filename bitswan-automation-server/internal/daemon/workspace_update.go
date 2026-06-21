package daemon

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/bitswan-space/bitswan-workspaces/internal/automations"
	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/services"
	"github.com/bitswan-space/bitswan-workspaces/internal/workspace"
)

// runWorkspaceUpdate runs the workspace update logic with stdout already redirected
func (s *Server) runWorkspaceUpdate(args []string) error {
	// Parse flags
	fs := flag.NewFlagSet("workspace-update", flag.ContinueOnError)
	gitopsImage := fs.String("gitops-image", "", "")
	dashboardImage := fs.String("dashboard-image", "", "")
	kafkaImage := fs.String("kafka-image", "", "")
	zookeeperImage := fs.String("zookeeper-image", "", "")
	couchdbImage := fs.String("couchdb-image", "", "")
	staging := fs.Bool("staging", false, "")
	trustCA := fs.Bool("trust-ca", false, "")
	devMode := fs.Bool("dev-mode", false, "")
	disableDevMode := fs.Bool("disable-dev-mode", false, "")
	gitopsDevSourceDir := fs.String("gitops-dev-source-dir", "", "")
	dashboardDevSourceDir := fs.String("dashboard-dev-source-dir", "", "")

	// Go's flag package stops parsing at the first non-flag token, so a flag
	// placed after the workspace name (e.g. `update wraptest --gitops-image X`)
	// would be silently ignored. Parse flags interspersed with positionals by
	// re-parsing the remainder after each positional, so flag order relative to
	// the workspace name doesn't matter.
	var positionals []string
	rest := args
	for len(rest) > 0 {
		if err := fs.Parse(rest); err != nil {
			return fmt.Errorf("failed to parse flags: %w", err)
		}
		rest = fs.Args()
		if len(rest) == 0 {
			break
		}
		positionals = append(positionals, rest[0])
		rest = rest[1:]
	}

	if len(positionals) < 1 {
		return fmt.Errorf("workspace name is required")
	}

	workspaceName := positionals[0]
	// Use HOME directly - inside container this is /root, on host it's the user's home
	// The workspace files are mounted at /root/.config/bitswan in the container
	homeDir := os.Getenv("HOME")
	workspacePath := filepath.Join(homeDir, ".config", "bitswan", "workspaces", workspaceName)
	metadataPath := filepath.Join(workspacePath, "metadata.yaml")

	// Handle dev mode settings - update metadata if dev mode flags are provided
	if *devMode || *disableDevMode || *gitopsDevSourceDir != "" || *dashboardDevSourceDir != "" {
		fmt.Println("Updating dev mode settings...")
		metadata, err := config.GetWorkspaceMetadata(workspaceName)
		if err != nil {
			return fmt.Errorf("failed to read workspace metadata: %w", err)
		}

		if *devMode {
			metadata.DevMode = true
			fmt.Println("Dev mode enabled")
		}
		if *disableDevMode {
			metadata.DevMode = false
			// Clear dev source directories when disabling dev mode
			metadata.GitopsDevSourceDir = nil
			metadata.DashboardDevSourceDir = nil
			fmt.Println("Dev mode disabled")
		}
		if *gitopsDevSourceDir != "" {
			metadata.GitopsDevSourceDir = gitopsDevSourceDir
			metadata.DevMode = true
			fmt.Printf("GitOps dev source directory set to: %s\n", *gitopsDevSourceDir)
		}
		if *dashboardDevSourceDir != "" {
			metadata.DashboardDevSourceDir = dashboardDevSourceDir
			metadata.DevMode = true
			fmt.Printf("Dashboard dev source directory set to: %s\n", *dashboardDevSourceDir)
		}

		if err := metadata.SaveToFile(metadataPath); err != nil {
			return fmt.Errorf("failed to save workspace metadata: %w", err)
		}
	}

	// Update Docker images and docker-compose file
	fmt.Println("Updating Docker images and docker-compose file...")
	if err := workspace.UpdateWorkspaceDeployment(workspaceName, *gitopsImage, *staging, *trustCA); err != nil {
		return fmt.Errorf("failed to update workspace deployment: %w", err)
	}
	fmt.Println("Gitops service restarted!")

	// 3. Update services if they are enabled
	fmt.Println("Checking for enabled services to update...")
	if err := updateServices(workspaceName, *dashboardImage, *kafkaImage, *zookeeperImage, *couchdbImage, *staging, *trustCA); err != nil {
		fmt.Printf("Warning: some services failed to update: %v\n", err)
	}

	fmt.Printf("Gitops %s updated successfully!\n", workspaceName)
	return nil
}

// updateServices updates all enabled services for the workspace
func updateServices(workspaceName, dashboardImage, kafkaImage, zookeeperImage, couchdbImage string, staging, trustCA bool) error {
	// Always try to update dashboard service if enabled
	fmt.Println("Checking dashboard service...")
	if err := updateDashboardService(workspaceName, dashboardImage, staging, trustCA); err != nil {
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
func updateDashboardService(workspaceName, dashboardImage string, staging bool, trustCA bool) error {
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
	if err := dashboardService.RegenerateDockerCompose(dashboardImage, staging, trustCA); err != nil {
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
