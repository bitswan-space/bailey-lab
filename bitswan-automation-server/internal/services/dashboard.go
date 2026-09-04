package services

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/certauthority"
	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/dockerhub"
	"gopkg.in/yaml.v3"
)

// DashboardService manages the workspace-dashboard sidecar deployment for a workspace.
// It owns its own docker-compose-dashboard.yml file and lifecycle.
type DashboardService struct {
	WorkspaceName string
	WorkspacePath string
}

// NewDashboardService creates a new Dashboard service manager.
func NewDashboardService(workspaceName string) (*DashboardService, error) {
	homeDir := os.Getenv("HOME")
	workspacePath := filepath.Join(homeDir, ".config", "bitswan", "workspaces", workspaceName)

	if _, err := os.Stat(workspacePath); os.IsNotExist(err) {
		return nil, fmt.Errorf("workspace '%s' does not exist", workspaceName)
	}

	return &DashboardService{
		WorkspaceName: workspaceName,
		WorkspacePath: workspacePath,
	}, nil
}

// DashboardDevConfig holds dev mode configuration for the dashboard.
// Dev mode is implied by a non-empty SourceDir — there's no separate flag.
type DashboardDevConfig struct {
	SourceDir string
}

// CreateDockerComposeWithDevMode generates the dashboard's docker-compose file with optional dev-mode mount.
func (d *DashboardService) CreateDockerComposeWithDevMode(gitopsSecretToken, bitswanDashboardImage string, trustCA bool, devConfig *DashboardDevConfig) (string, error) {
	workspaceName := d.WorkspaceName

	// Workspace data lives inside the named `bitswan` Docker volume at
	// workspaces/<name>/... — mounted via compose long-form volume + subpath.
	// The host docker daemon resolves the named volume directly, so there's no
	// container→host path translation to apply here anymore.
	wsVolume := func(subdir, target string, readOnly bool) map[string]interface{} {
		entry := map[string]interface{}{
			"type":   "volume",
			"source": "bitswan",
			"target": target,
			"volume": map[string]interface{}{
				"subpath": "workspaces/" + workspaceName + "/" + subdir,
			},
		}
		if readOnly {
			entry["read_only"] = true
		}
		return entry
	}

	bitswanDashboard := map[string]interface{}{
		"image":    bitswanDashboardImage,
		"restart":  "always",
		"hostname": workspaceName + "-dashboard",
		"networks": []string{"bitswan_network"},
		"environment": []string{
			"BITSWAN_WORKSPACE_NAME=" + workspaceName,
			"BITSWAN_DEPLOY_URL=" + fmt.Sprintf("http://%s-gitops:8079", workspaceName),
			"BITSWAN_DEPLOY_SECRET=" + gitopsSecretToken,
			"PORT=8080",
			"INTERNAL_PORT=8081",
		},
		"volumes": []interface{}{
			// The dashboard reads and writes business-process files in the
			// per-user copies (copies/<copy>/<bp>/…). The file routes resolve
			// them under WORKSPACE_ROOT as `<root>/copies/<copy>/…`, so mount
			// the workspace's copies tree at /workspace/workspace/copies. (The
			// old shared `workspace/` working tree is gone in the copy model.)
			wsVolume("copies", "/workspace/workspace/copies", false),
			// SSH key for connecting to the coding-agent container. The
			// dashboard authenticates as the same principal that's already
			// in the agent's authorized_keys. The TCP path runs through the
			// gitops agent-ssh proxy (:2222) because the agent sits on the
			// isolated <ws>-agent network — the dashboard stays off that
			// bridge deliberately (it trusts X-Forwarded-Email, and the
			// agent runs untrusted code).
			wsVolume("ssh", "/workspace/.ssh", true),
			// Read-only view of per-conversation session metadata
			// (<uuid>.meta.json) written by the coding-agent wrapper, for
			// the dashboard's resume-candidate lookup. (The agent's $HOME is
			// deliberately NOT mounted any more — it was only ever read to
			// extract conversation titles, a feature that is gone.)
			wsVolume("coding-agent-sessions", "/workspace/agent-sessions", true),
		},
	}

	// The dashboard runs NO auth of its own — no oauth2-proxy and no OIDC token
	// validation. It is a first-party app reached only inside the Bailey
	// chrome-wrap iframe on the workspace's protected (inner) host. The gate
	// (bitswan-protected-proxy → the daemon's :9080 gate) authenticates every
	// request and forwards the verified identity to the dashboard as a trusted
	// X-Forwarded-Email; the dashboard server simply reads that header. So
	// OAUTH_ENABLED stays unset (the app listens directly on PORT) and there is
	// no BITSWAN_OIDC_ISSUER_URL to inject — all protection comes from the gate.

	caVolumes, caEnvVars := certauthority.GetCACertMountConfig(trustCA)
	if len(caVolumes) > 0 {
		for _, v := range caVolumes {
			bitswanDashboard["volumes"] = append(bitswanDashboard["volumes"].([]interface{}), v)
		}
		bitswanDashboard["environment"] = append(bitswanDashboard["environment"].([]string), caEnvVars...)
	}

	sidebarEnabled := false
	enableAgentSidebar := func(extensionPathInContainer string) {
		sidebarEnabled = true
		bitswanDashboard["environment"] = append(bitswanDashboard["environment"].([]string),
			"CLAUDE_EXTENSION_PATH="+extensionPathInContainer,
			"SIDEBAR_CONFIG_ROOT=/claude-config",
		)
		bitswanDashboard["volumes"] = append(bitswanDashboard["volumes"].([]interface{}),
			wsVolume("claude-configs", "/claude-config", false))
		for _, key := range []string{"ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"} {
			if v := os.Getenv(key); v != "" {
				bitswanDashboard["environment"] = append(
					bitswanDashboard["environment"].([]string), key+"="+v)
			}
		}
	}

	// Hot-reload dev mode: mount the source directory and let the container's
	// entrypoint run `npm install` + `npm run dev` instead of the pre-built bundle.
	if devConfig != nil && devConfig.SourceDir != "" {
		dashboardDevContainerPath := "/workspace/dashboard-src"
		bitswanDashboard["volumes"] = append(bitswanDashboard["volumes"].([]interface{}),
			devConfig.SourceDir+":"+dashboardDevContainerPath+":z")
		bitswanDashboard["environment"] = append(bitswanDashboard["environment"].([]string),
			"BITSWAN_DEV_MODE=true",
			"BITSWAN_DASHBOARD_DEV_DIR="+dashboardDevContainerPath,
		)
		if _, err := os.Stat(filepath.Join(devConfig.SourceDir, ".claude-extension")); err == nil {
			enableAgentSidebar(dashboardDevContainerPath + "/.claude-extension")
		}
	}

	if hostExtension := os.Getenv("BITSWAN_CLAUDE_EXTENSION_DIR"); hostExtension != "" && !sidebarEnabled {
		if _, err := os.Stat(hostExtension); err == nil {
			bitswanDashboard["volumes"] = append(bitswanDashboard["volumes"].([]interface{}),
				hostExtension+":/claude-extension:ro")
			enableAgentSidebar("/claude-extension")
		}
	}

	dockerCompose := map[string]interface{}{
		"version": "3.8",
		"services": map[string]interface{}{
			"bitswan-dashboard": bitswanDashboard,
		},
		"networks": map[string]interface{}{
			"bitswan_network": map[string]interface{}{
				"external": true,
			},
		},
		"volumes": map[string]interface{}{
			"bitswan": map[string]interface{}{
				"external": true,
			},
		},
	}

	var buf bytes.Buffer
	encoder := yaml.NewEncoder(&buf)
	encoder.SetIndent(2)
	if err := encoder.Encode(dockerCompose); err != nil {
		return "", fmt.Errorf("failed to encode dashboard docker-compose: %w", err)
	}
	return buf.String(), nil
}

// SaveDockerCompose writes docker-compose-dashboard.yml to the workspace deployment directory.
func (d *DashboardService) SaveDockerCompose(content string) error {
	deploymentDir := filepath.Join(d.WorkspacePath, "deployment")
	if err := os.MkdirAll(deploymentDir, 0755); err != nil {
		return fmt.Errorf("failed to create deployment directory: %w", err)
	}
	dockerComposePath := filepath.Join(deploymentDir, "docker-compose-dashboard.yml")
	if err := os.WriteFile(dockerComposePath, []byte(content), 0755); err != nil {
		return fmt.Errorf("failed to write docker-compose-dashboard.yml: %w", err)
	}
	fmt.Printf("Dashboard docker-compose saved to: %s\n", dockerComposePath)
	return nil
}

// Enable generates docker-compose-dashboard.yml from metadata + the supplied image.
func (d *DashboardService) Enable(gitopsSecretToken, bitswanDashboardImage string, trustCA bool) error {
	if d.IsEnabled() {
		return fmt.Errorf("Dashboard service is already enabled for workspace '%s'", d.WorkspaceName)
	}

	metadata, _ := d.GetMetadata()

	// Dev-mode is purely a function of whether a source dir is set in metadata.
	var devConfig *DashboardDevConfig
	if metadata != nil && metadata.DashboardDevSourceDir != nil && *metadata.DashboardDevSourceDir != "" {
		devConfig = &DashboardDevConfig{SourceDir: *metadata.DashboardDevSourceDir}
		fmt.Printf("Dashboard dev mode enabled (source: %q)\n", devConfig.SourceDir)
	}

	content, err := d.CreateDockerComposeWithDevMode(gitopsSecretToken, bitswanDashboardImage, trustCA, devConfig)
	if err != nil {
		return fmt.Errorf("failed to create docker-compose content: %w", err)
	}
	if err := d.SaveDockerCompose(content); err != nil {
		return err
	}
	fmt.Printf("Dashboard service enabled for workspace '%s'\n", d.WorkspaceName)
	return nil
}

// Disable removes the docker-compose file and stops the container.
func (d *DashboardService) Disable() error {
	if !d.IsEnabled() {
		return fmt.Errorf("Dashboard service is not enabled for workspace '%s'", d.WorkspaceName)
	}
	if d.IsContainerRunning() {
		if err := d.StopContainer(); err != nil {
			return fmt.Errorf("failed to stop dashboard container: %w", err)
		}
	}
	dockerComposePath := filepath.Join(d.WorkspacePath, "deployment", "docker-compose-dashboard.yml")
	if err := os.Remove(dockerComposePath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to remove docker-compose-dashboard.yml: %w", err)
	}
	fmt.Printf("Dashboard service disabled for workspace '%s'\n", d.WorkspaceName)
	return nil
}

// IsEnabled returns true when the workspace has a docker-compose-dashboard.yml.
func (d *DashboardService) IsEnabled() bool {
	dockerComposePath := filepath.Join(d.WorkspacePath, "deployment", "docker-compose-dashboard.yml")
	_, err := os.Stat(dockerComposePath)
	return err == nil
}

// IsContainerRunning returns true when the dashboard container is running.
func (d *DashboardService) IsContainerRunning() bool {
	cmd := exec.Command("docker", "ps", "--filter", fmt.Sprintf("name=%s-dashboard", d.WorkspaceName), "--format", "{{.Names}}")
	output, err := cmd.Output()
	if err != nil {
		return false
	}
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	return len(lines) > 0 && lines[0] != ""
}

// StartContainer runs `docker compose up -d` against docker-compose-dashboard.yml.
func (d *DashboardService) StartContainer() error {
	deploymentDir := filepath.Join(d.WorkspacePath, "deployment")
	projectName := d.WorkspaceName + "-dashboard"
	fmt.Printf("Starting Dashboard container for workspace '%s'...\n", d.WorkspaceName)
	// Same race as the coding-agent's: init and the reconciler can both bring
	// this project up while the image is still pulling (see compose.go).
	return composeUpSidecar(deploymentDir, "docker-compose-dashboard.yml", projectName, "--pull", "missing")
}

// StopContainer runs `docker compose down` against docker-compose-dashboard.yml.
func (d *DashboardService) StopContainer() error {
	deploymentDir := filepath.Join(d.WorkspacePath, "deployment")
	projectName := d.WorkspaceName + "-dashboard"
	cmd := exec.Command("docker", "compose", "-f", "docker-compose-dashboard.yml", "-p", projectName, "down")
	cmd.Dir = deploymentDir
	fmt.Printf("Stopping Dashboard container for workspace '%s'...\n", d.WorkspaceName)
	return d.runCommand(cmd)
}

// RegenerateDockerCompose fully regenerates docker-compose-dashboard.yml from metadata.
func (d *DashboardService) RegenerateDockerCompose(dashboardImage string, staging bool, dev bool, trustCA bool) error {
	if !d.IsEnabled() {
		return fmt.Errorf("Dashboard service is not enabled for workspace '%s'", d.WorkspaceName)
	}

	metadata, err := d.GetMetadata()
	if err != nil {
		return fmt.Errorf("failed to read metadata: %w", err)
	}

	var bitswanDashboardImage string
	if dashboardImage != "" {
		bitswanDashboardImage = dashboardImage
	} else {
		bitswanDashboardImage, err = dockerhub.ResolveDashboardImage(staging, dev)
		if err != nil {
			return fmt.Errorf("failed to get latest workspace-dashboard image: %w", err)
		}
	}

	var devConfig *DashboardDevConfig
	if metadata.DashboardDevSourceDir != nil && *metadata.DashboardDevSourceDir != "" {
		devConfig = &DashboardDevConfig{SourceDir: *metadata.DashboardDevSourceDir}
		fmt.Printf("Dashboard dev mode enabled (source: %q)\n", devConfig.SourceDir)
	}

	content, err := d.CreateDockerComposeWithDevMode(
		metadata.GitopsSecret,
		bitswanDashboardImage,
		trustCA,
		devConfig,
	)
	if err != nil {
		return fmt.Errorf("failed to create docker-compose content: %w", err)
	}
	if err := d.SaveDockerCompose(content); err != nil {
		return err
	}
	fmt.Printf("Dashboard docker-compose regenerated for workspace '%s'\n", d.WorkspaceName)
	return nil
}

// UpdateImage rewrites docker-compose-dashboard.yml with a new image tag.
// Used by `bitswan service dashboard update --dashboard-image`.
func (d *DashboardService) UpdateImage(newImage string) error {
	if newImage == "" {
		v, err := dockerhub.GetLatestDashboardVersion()
		if err != nil {
			return fmt.Errorf("failed to get latest dashboard version: %w", err)
		}
		newImage = "bitswan/workspace-dashboard:" + v
	}

	composePath := filepath.Join(d.WorkspacePath, "deployment", "docker-compose-dashboard.yml")
	data, err := os.ReadFile(composePath)
	if err != nil {
		return fmt.Errorf("failed to read docker-compose-dashboard.yml: %w", err)
	}
	var compose map[string]interface{}
	if err := yaml.Unmarshal(data, &compose); err != nil {
		return fmt.Errorf("failed to parse docker-compose-dashboard.yml: %w", err)
	}
	svcs, ok := compose["services"].(map[string]interface{})
	if !ok {
		return fmt.Errorf("services section not found in docker-compose-dashboard.yml")
	}
	entry, ok := svcs["bitswan-dashboard"].(map[string]interface{})
	if !ok {
		return fmt.Errorf("bitswan-dashboard service not found in docker-compose-dashboard.yml")
	}
	entry["image"] = newImage

	updated, err := yaml.Marshal(compose)
	if err != nil {
		return fmt.Errorf("failed to marshal updated docker-compose: %w", err)
	}
	if err := os.WriteFile(composePath, updated, 0644); err != nil {
		return fmt.Errorf("failed to write updated docker-compose-dashboard.yml: %w", err)
	}
	return nil
}

// UpdateToLatest pulls the latest non-staging tag.
func (d *DashboardService) UpdateToLatest() error {
	return d.UpdateImage("")
}

// GetMetadata reads workspace metadata using the centralized helper.
func (d *DashboardService) GetMetadata() (*config.WorkspaceMetadata, error) {
	metadata, err := config.GetWorkspaceMetadata(d.WorkspaceName)
	if err != nil {
		return nil, err
	}
	return &metadata, nil
}

func (d *DashboardService) runCommand(cmd *exec.Cmd) error {
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("command failed: %w\nOutput: %s", err, string(output))
	}
	return nil
}
