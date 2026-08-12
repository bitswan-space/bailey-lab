package services

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/docker"
	"github.com/bitswan-space/bitswan-workspaces/internal/dockerhub"
	"gopkg.in/yaml.v3"
)

// CodingAgentService manages Coding Agent service deployment for workspaces
type CodingAgentService struct {
	WorkspaceName string
	WorkspacePath string
}

// NewCodingAgentService creates a new Coding Agent service manager
func NewCodingAgentService(workspaceName string) (*CodingAgentService, error) {
	// Always use HOME for file operations (works inside container and outside)
	homeDir := os.Getenv("HOME")
	workspacePath := filepath.Join(homeDir, ".config", "bitswan", "workspaces", workspaceName)

	// Check if workspace exists
	if _, err := os.Stat(workspacePath); os.IsNotExist(err) {
		return nil, fmt.Errorf("workspace '%s' does not exist", workspaceName)
	}

	return &CodingAgentService{
		WorkspaceName: workspaceName,
		WorkspacePath: workspacePath,
	}, nil
}

// CodingAgentDevConfig holds dev mode configuration
type CodingAgentDevConfig struct {
	DevMode   bool
	SourceDir string // path to bitswan-agent source directory
}

// CreateDockerCompose generates a docker-compose-coding-agent.yml file for Coding Agent
func (c *CodingAgentService) CreateDockerCompose(gitopsAgentSecret, codingAgentImage, domain string) (string, error) {
	return c.CreateDockerComposeWithDevMode(gitopsAgentSecret, codingAgentImage, domain, nil)
}

// CreateDockerComposeWithDevMode generates docker-compose with optional dev mode support
func (c *CodingAgentService) CreateDockerComposeWithDevMode(gitopsAgentSecret, codingAgentImage, domain string, devConfig *CodingAgentDevConfig) (string, error) {
	workspaceName := c.WorkspaceName

	// Workspace data lives inside the named `bitswan` Docker volume at
	// workspaces/<name>/... — mounted via compose long-form volume + subpath.
	// The host docker daemon resolves the named volume directly, so there's no
	// container→host path translation to apply here anymore.
	wsVolume := func(subdir, target string) map[string]interface{} {
		return map[string]interface{}{
			"type":   "volume",
			"source": "bitswan",
			"target": target,
			"volume": map[string]interface{}{
				"subpath": "workspaces/" + workspaceName + "/" + subdir,
			},
		}
	}

	if codingAgentImage == "" {
		codingAgentImage = "bitswan/coding-agent:latest"
	}

	// Read the editor's public SSH key
	sshPubKey := ""
	pubKeyPath := filepath.Join(c.WorkspacePath, "ssh", "id_ed25519.pub")
	if data, err := os.ReadFile(pubKeyPath); err == nil {
		sshPubKey = strings.TrimSpace(string(data))
	}

	envVars := []string{
		"BITSWAN_GITOPS_URL=" + fmt.Sprintf("http://%s-gitops:8079", workspaceName),
		"BITSWAN_GITOPS_AGENT_SECRET=" + gitopsAgentSecret,
		"BITSWAN_WORKSPACE_NAME=" + workspaceName,
		// BASE URL of the per-BP git repos (each clone's origin is
		// <base>/<bp>.git). The agent's entrypoint reduces this to a host-only
		// credential line, so HTTP Basic (password = agent secret) covers
		// every BP repo served from that host.
		"BITSWAN_GIT_REMOTE=" + fmt.Sprintf("http://%s-gitops:8079/git", workspaceName),
	}
	if sshPubKey != "" {
		envVars = append(envVars, "EDITOR_SSH_PUBLIC_KEY="+sshPubKey)
	}

	volumes := []interface{}{
		// Each agent session works in its own copy at /workspace/copies/<name>.
		wsVolume("copies", "/workspace/copies"),
		wsVolume("coding-agent-home", "/home/agent"),
		wsVolume("coding-agent-sessions", "/var/log/agent-sessions"),
	}

	// Dev mode: mount source files directly into the container. The dev source
	// is a real host directory the user supplies, so it stays a bind mount —
	// translate the container HOME prefix to HOST_HOME for the host daemon.
	if devConfig != nil && devConfig.DevMode && devConfig.SourceDir != "" {
		homeDir := os.Getenv("HOME")
		hostHomeDir := os.Getenv("HOST_HOME")
		if hostHomeDir == "" {
			hostHomeDir = homeDir
		}
		srcDir := devConfig.SourceDir
		// Convert to host path if needed
		if homeDir != hostHomeDir && strings.HasPrefix(srcDir, homeDir) {
			srcDir = strings.Replace(srcDir, homeDir, hostHomeDir, 1)
		}
		volumes = append(volumes,
			srcDir+"/agent-session-wrapper:/usr/local/bin/agent-session-wrapper:z",
			srcDir+"/AGENTS-inside-container.md:/AGENTS.md:z",
		)
	}

	bitswanCodingAgent := map[string]interface{}{
		"image":   codingAgentImage,
		"restart": "always",
		// gitops' verify_agent_token discovers the agent secret via
		// `docker inspect {workspace}-coding-agent`, which resolves container
		// names, not hostnames — without container_name compose would name
		// this `{project}-bitswan-coding-agent-1` and discovery would fail,
		// 401-ing every /agent/* request.
		"container_name": workspaceName + "-coding-agent",
		"hostname":       workspaceName + "-coding-agent",
		// SECURITY: the coding agent runs untrusted (member-/AI-authored) code
		// and MUST NOT sit on bitswan_network (the control-plane inner ring),
		// where it could reach the daemon gate (:8080/:9080) and every other
		// control-plane container. It joins ONLY this dedicated per-workspace
		// bridge, shared solely with gitops, so its entire reachable surface is
		// the authenticated gitops API (/agent, Bearer token) + git (/git). See
		// dockercompose.go (gitops also joins <ws>-agent) and StartContainer
		// (network ensured + gitops attached at bring-up).
		//
		// The workspace dashboard (bitswan_network only — it trusts
		// X-Forwarded-Email, so it must never share a network with the agent)
		// reaches the agent's sshd through a raw TCP proxy gitops runs on
		// :2222 (bitswan-gitops app/services/agent_ssh_proxy.py). Only
		// inbound-to-agent connections flow through it; do NOT "fix" dashboard
		// connectivity by attaching either container to the other's network.
		"networks":    []string{workspaceName + "-agent"},
		"environment": envVars,
		"volumes":     volumes,
	}

	// Construct the docker-compose data structure
	dockerCompose := map[string]interface{}{
		"version": "3.8",
		"services": map[string]interface{}{
			"bitswan-coding-agent": bitswanCodingAgent,
		},
		"networks": map[string]interface{}{
			workspaceName + "-agent": map[string]interface{}{
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
		return "", fmt.Errorf("failed to encode coding-agent docker-compose: %w", err)
	}

	return buf.String(), nil
}

// composePath is the workspace's coding-agent compose file.
func (c *CodingAgentService) composePath() string {
	return filepath.Join(c.WorkspacePath, "deployment", "docker-compose-coding-agent.yml")
}

// CurrentImage returns the coding-agent image recorded in the workspace's
// existing compose, or "" when it can't be determined (not enabled yet,
// unreadable/malformed file, no image set).
//
// Mirrors daemon.currentGitopsImage, and exists for the same reason: a
// regeneration path that can't resolve an image must carry the workspace's
// CURRENT one forward. Anything else silently moves a running workspace onto a
// different image than the one the operator chose.
func (c *CodingAgentService) CurrentImage() string {
	data, err := os.ReadFile(c.composePath())
	if err != nil {
		return ""
	}
	var compose struct {
		Services struct {
			CodingAgent struct {
				Image string `yaml:"image"`
			} `yaml:"bitswan-coding-agent"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(data, &compose); err != nil {
		return ""
	}
	return compose.Services.CodingAgent.Image
}

// RegenerateDockerCompose rewrites the coding-agent compose for an ALREADY
// enabled workspace, resolving the image the same staging/dev-aware way
// DashboardService.RegenerateDockerCompose does.
//
// It exists because the update path had no such helper and open-coded the
// regeneration with an empty image — which fell through to the hard-coded
// "bitswan/coding-agent:latest" below, so `workspace update --dev` (and
// --staging, and a plain update) put every workspace onto a floating
// production tag regardless of the channel asked for. On this sandbox that was
// a year-old image with no git in it, and the agent said so.
func (c *CodingAgentService) RegenerateDockerCompose(codingAgentImage string, staging, dev bool) error {
	if !c.IsEnabled() {
		return fmt.Errorf("Coding Agent service is not enabled for workspace '%s'", c.WorkspaceName)
	}

	metadata, err := c.GetMetadata()
	if err != nil {
		return fmt.Errorf("failed to read metadata: %w", err)
	}

	image := codingAgentImage
	if image == "" {
		image, err = dockerhub.ResolveCodingAgentImage(staging, dev)
		if err != nil {
			// Hub is unreachable or has no matching tag. Keep what the
			// workspace is running rather than reaching for a floating tag —
			// an update that can't find a NEWER image must not install an
			// OLDER one.
			if current := c.CurrentImage(); current != "" {
				fmt.Printf("Could not resolve a coding-agent image (%v); keeping %s\n", err, current)
				image = current
			} else {
				return fmt.Errorf("failed to get latest coding-agent image: %w", err)
			}
		}
	}

	content, err := c.CreateDockerCompose(metadata.CodingAgentSecret, image, metadata.Domain)
	if err != nil {
		return fmt.Errorf("failed to regenerate coding-agent docker-compose: %w", err)
	}
	return c.SaveDockerCompose(content)
}

// SaveDockerCompose saves the docker-compose-coding-agent.yml file
func (c *CodingAgentService) SaveDockerCompose(content string) error {
	deploymentDir := filepath.Join(c.WorkspacePath, "deployment")
	dockerComposePath := filepath.Join(deploymentDir, "docker-compose-coding-agent.yml")

	if err := os.WriteFile(dockerComposePath, []byte(content), 0755); err != nil {
		return fmt.Errorf("failed to write docker-compose-coding-agent.yml: %w", err)
	}

	fmt.Printf("Coding Agent docker-compose saved to: %s\n", dockerComposePath)
	return nil
}

// Enable enables the Coding Agent service for the workspace
func (c *CodingAgentService) Enable(gitopsAgentSecret, codingAgentImage, domain string, devConfig *CodingAgentDevConfig) error {
	// Check if already enabled
	if c.IsEnabled() {
		return fmt.Errorf("Coding Agent service is already enabled for workspace '%s'", c.WorkspaceName)
	}

	// Create coding-agent-home directory
	codingAgentHomeDir := filepath.Join(c.WorkspacePath, "coding-agent-home")
	if err := os.MkdirAll(codingAgentHomeDir, 0755); err != nil {
		return fmt.Errorf("failed to create coding-agent-home directory: %w", err)
	}

	// Create coding-agent-sessions directory
	codingAgentSessionsDir := filepath.Join(c.WorkspacePath, "coding-agent-sessions")
	if err := os.MkdirAll(codingAgentSessionsDir, 0755); err != nil {
		return fmt.Errorf("failed to create coding-agent-sessions directory: %w", err)
	}

	hostOsTmp := runtime.GOOS

	if hostOsTmp == "linux" {
		// Change ownership for Linux. The per-copy checkouts live under the
		// `copies` volume subpath (created/owned by gitops); the agent only
		// needs its home + session dirs here.
		dirs := []struct {
			path string
			name string
		}{
			{codingAgentHomeDir, "coding-agent-home"},
			{codingAgentSessionsDir, "coding-agent-sessions"},
		}

		for _, dir := range dirs {
			var chownCom *exec.Cmd
			if os.Geteuid() == 0 {
				chownCom = exec.Command("chown", "-R", "1000:1000", dir.path)
			} else {
				chownCom = exec.Command("sudo", "chown", "-R", "1000:1000", dir.path)
			}
			if err := c.runCommand(chownCom); err != nil {
				return fmt.Errorf("failed to change ownership of %s folder: %w", dir.name, err)
			}
		}
	}

	// Generate docker-compose content
	dockerComposeContent, err := c.CreateDockerComposeWithDevMode(gitopsAgentSecret, codingAgentImage, domain, devConfig)
	if err != nil {
		return fmt.Errorf("failed to create docker-compose content: %w", err)
	}

	// Save docker-compose file
	if err := c.SaveDockerCompose(dockerComposeContent); err != nil {
		return fmt.Errorf("failed to save docker-compose file: %w", err)
	}

	fmt.Printf("Coding Agent service enabled for workspace '%s'\n", c.WorkspaceName)
	return nil
}

// Disable disables the Coding Agent service for the workspace
func (c *CodingAgentService) Disable() error {
	// Check if enabled
	if !c.IsEnabled() {
		return fmt.Errorf("Coding Agent service is not enabled for workspace '%s'", c.WorkspaceName)
	}

	// Stop containers if running
	if c.IsContainerRunning() {
		if err := c.StopContainer(); err != nil {
			return fmt.Errorf("failed to stop coding-agent container: %w", err)
		}
	}

	// Remove docker-compose file
	dockerComposePath := filepath.Join(c.WorkspacePath, "deployment", "docker-compose-coding-agent.yml")
	if err := os.Remove(dockerComposePath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to remove docker-compose-coding-agent.yml: %w", err)
	}

	fmt.Printf("Coding Agent service disabled for workspace '%s'\n", c.WorkspaceName)
	return nil
}

// IsEnabled checks if the Coding Agent service is enabled
func (c *CodingAgentService) IsEnabled() bool {
	dockerComposePath := filepath.Join(c.WorkspacePath, "deployment", "docker-compose-coding-agent.yml")
	_, err := os.Stat(dockerComposePath)
	return err == nil
}

// IsContainerRunning checks if Coding Agent containers are running
func (c *CodingAgentService) IsContainerRunning() bool {
	cmd := exec.Command("docker", "ps", "--filter", fmt.Sprintf("name=%s-coding-agent", c.WorkspaceName), "--format", "{{.Names}}")
	output, err := cmd.Output()
	if err != nil {
		return false
	}

	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	return len(lines) > 0 && lines[0] != ""
}

// AgentNetworkName returns the dedicated, isolated per-workspace bridge that
// the coding agent shares ONLY with gitops. Keeping the agent off
// bitswan_network is the whole point: untrusted agent code must not be able to
// reach the control-plane inner ring (daemon gate, other workspaces' gitops,
// etc.). Its sole reachable dependency is the authenticated gitops API/git.
func AgentNetworkName(workspaceName string) string {
	return workspaceName + "-agent"
}

// gitopsContainerFilterArgs are the `docker ps` filters that select EXACTLY the
// workspace's gitops container — and nothing else. Scoping by
// `gitops.workspace` alone is NOT enough: every automation gitops deploys
// (live-dev previews, blue/green/staging app containers, garage, postgres,
// firewall gateways) also carries that label, so a bare filter matches dozens of
// containers. Many of those share another container's network namespace
// (network_mode: container:…) and Docker refuses to attach an extra network to
// such a container — so attaching them would abort the whole agent bring-up.
// The compose service label pins it to the single gitops service container.
func gitopsContainerFilterArgs(workspaceName string) []string {
	return []string{
		"--filter", "label=gitops.workspace=" + workspaceName,
		"--filter", "label=com.docker.compose.service=bitswan-gitops",
	}
}

// EnsureAgentNetwork creates the dedicated agent↔gitops bridge (idempotent) and
// attaches the currently-running gitops container to it. The gitops compose
// also declares this network (dockercompose.go), so the wiring survives a
// gitops recreate; this attach covers the window where the agent is enabled on
// a workspace whose gitops has not yet been re-upped onto the new network.
func (c *CodingAgentService) EnsureAgentNetwork() error {
	net := AgentNetworkName(c.WorkspaceName)
	if _, err := docker.EnsureDockerNetwork(net, false); err != nil {
		return fmt.Errorf("failed to ensure agent network %q: %w", net, err)
	}
	// Find the gitops container — and ONLY gitops (see gitopsContainerFilterArgs
	// for why the compose-service filter is load-bearing).
	psArgs := append([]string{"ps", "-q"}, gitopsContainerFilterArgs(c.WorkspaceName)...)
	out, err := exec.Command("docker", psArgs...).Output()
	if err != nil {
		return fmt.Errorf("failed to locate gitops container for %q: %w", c.WorkspaceName, err)
	}
	ids := strings.Fields(string(out))
	if len(ids) == 0 {
		// gitops not running yet — the declarative compose wiring will attach it
		// when the workspace comes up. Nothing to do here.
		return nil
	}
	for _, id := range ids {
		connectOut, cerr := exec.Command("docker", "network", "connect", net, id).CombinedOutput()
		if cerr != nil && !strings.Contains(string(connectOut), "already exists in network") {
			return fmt.Errorf("failed to attach gitops %s to %q: %w: %s", id, net, cerr, string(connectOut))
		}
	}
	return nil
}

// StartContainer starts the Coding Agent containers
func (c *CodingAgentService) StartContainer() error {
	deploymentDir := filepath.Join(c.WorkspacePath, "deployment")
	projectName := c.WorkspaceName + "-coding-agent"

	// The agent compose references the <ws>-agent network as external, so it
	// must exist (and gitops must be reachable on it) before we bring the agent
	// up. Fail loudly if we can't wire it — a silently-started agent that can't
	// reach gitops is worse than a clear error.
	if err := c.EnsureAgentNetwork(); err != nil {
		return err
	}

	cmd := exec.Command("docker", "compose", "-f", "docker-compose-coding-agent.yml", "-p", projectName, "up", "-d")
	cmd.Dir = deploymentDir

	fmt.Printf("Starting Coding Agent container for workspace '%s'...\n", c.WorkspaceName)
	return c.runCommand(cmd)
}

// StopContainer stops the Coding Agent containers
func (c *CodingAgentService) StopContainer() error {
	deploymentDir := filepath.Join(c.WorkspacePath, "deployment")
	projectName := c.WorkspaceName + "-coding-agent"

	cmd := exec.Command("docker", "compose", "-f", "docker-compose-coding-agent.yml", "-p", projectName, "down")
	cmd.Dir = deploymentDir

	fmt.Printf("Stopping Coding Agent container for workspace '%s'...\n", c.WorkspaceName)
	return c.runCommand(cmd)
}

// GetMetadata reads workspace metadata using the centralized function
func (c *CodingAgentService) GetMetadata() (*config.WorkspaceMetadata, error) {
	metadata, err := config.GetWorkspaceMetadata(c.WorkspaceName)
	if err != nil {
		return nil, err
	}
	return &metadata, nil
}

// runCommand executes a command with error handling
func (c *CodingAgentService) runCommand(cmd *exec.Cmd) error {
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("command failed: %w\nOutput: %s", err, string(output))
	}
	return nil
}

// UpdateImage updates the docker-compose-coding-agent.yml file with a new image
func (c *CodingAgentService) UpdateImage(newImage string) error {
	if newImage == "" {
		newImage = "bitswan/coding-agent:latest"
	}

	// Read the current docker-compose-coding-agent.yml file
	composePath := filepath.Join(c.WorkspacePath, "deployment", "docker-compose-coding-agent.yml")
	data, err := os.ReadFile(composePath)
	if err != nil {
		return fmt.Errorf("failed to read docker-compose-coding-agent.yml: %w", err)
	}

	// Parse the YAML
	var compose map[string]interface{}
	if err := yaml.Unmarshal(data, &compose); err != nil {
		return fmt.Errorf("failed to parse docker-compose-coding-agent.yml: %w", err)
	}

	// Update the image in the bitswan-coding-agent service
	if services, ok := compose["services"].(map[string]interface{}); ok {
		if codingAgentService, ok := services["bitswan-coding-agent"].(map[string]interface{}); ok {
			codingAgentService["image"] = newImage
		} else {
			return fmt.Errorf("bitswan-coding-agent service not found in docker-compose-coding-agent.yml")
		}
	} else {
		return fmt.Errorf("services section not found in docker-compose-coding-agent.yml")
	}

	// Write the updated file back
	updatedData, err := yaml.Marshal(compose)
	if err != nil {
		return fmt.Errorf("failed to marshal updated docker-compose: %w", err)
	}

	if err := os.WriteFile(composePath, updatedData, 0644); err != nil {
		return fmt.Errorf("failed to write updated docker-compose-coding-agent.yml: %w", err)
	}

	return nil
}

// UpdateToLatest updates the coding-agent service to the latest version from DockerHub
func (c *CodingAgentService) UpdateToLatest() error {
	return c.UpdateImage("")
}

// UpdateToLatestWithStaging updates the coding-agent service to the latest version from DockerHub, optionally using staging
func (c *CodingAgentService) UpdateToLatestWithStaging(staging bool) error {
	if staging {
		version, err := dockerhub.GetLatestCodingAgentStagingVersion()
		if err != nil {
			return fmt.Errorf("failed to get latest staging version: %w", err)
		}
		return c.UpdateImage("bitswan/coding-agent-staging:" + version)
	}
	return c.UpdateToLatest()
}
