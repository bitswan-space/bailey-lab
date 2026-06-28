package daemon

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/bitswan-space/bitswan-workspaces/internal/automations"
	"github.com/bitswan-space/bitswan-workspaces/internal/caddyapi"
	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/traefikapi"
)

// Compose represents docker-compose structure for parsing
type Compose struct {
	Services map[string]struct {
		Image string `yaml:"image"`
	} `yaml:"services"`
}

// RunWorkspaceRemove runs the workspace remove logic
func RunWorkspaceRemove(workspaceName string, writer io.Writer) error {
	// Get the real user's home directory (host home, not container home)
	homeDir, err := config.GetRealUserHomeDir()
	if err != nil {
		// Fallback to HOME if we can't determine the real user
		homeDir = os.Getenv("HOME")
	}
	bitswanPath := filepath.Join(homeDir, ".config", "bitswan")

	// 1. Ask user for confirmation (handled by CLI, but we need to check automations first)
	// Use public URL during deletion since containers may be stopping/stopped
	automationSet, err := automations.GetListAutomationsWithOptions(workspaceName, true)
	var skipAutomationRemoval bool
	if err != nil {
		// Check if this is a WorkspaceMisbehavingError
		var misbehavingErr *automations.WorkspaceMisbehavingError
		if errors.As(err, &misbehavingErr) {
			fmt.Fprintf(writer, "This workspace seems to be misbehaving. Cannot detect which automations are running within it. Would you like to stop it anyway with the risk of leaving some orphaned automations running? [y/N]: ")
			// Note: User confirmation is handled by CLI, so we'll skip for now
			skipAutomationRemoval = true
			automationSet = nil
		} else {
			// For any other error, just skip automation removal and continue
			fmt.Fprintf(writer, "Warning: Cannot connect to workspace to retrieve automations (%v). Continuing with removal process.\n", err)
			skipAutomationRemoval = true
			automationSet = nil
		}
	}

	// 2. Remove the automations from the server
	if !skipAutomationRemoval && len(automationSet) > 0 {
		fmt.Fprintln(writer, "Removing automations...")
		for _, automation := range automationSet {
			err := automation.Remove()
			if err != nil {
				return fmt.Errorf("error removing automation %s: %w", automation.Name, err)
			}
		}
		fmt.Fprintln(writer, "Automations removed successfully.")
	} else if skipAutomationRemoval {
		fmt.Fprintln(writer, "Skipping automation removal due to workspace misbehavior.")
	} else {
		fmt.Fprintln(writer, "No automations to remove.")
	}

	// 3. Remove GitOps docker containers and volumes
	fmt.Fprintln(writer, "Removing docker containers and volumes...")
	workspacesFolder := filepath.Join(bitswanPath, "workspaces")
	dockerComposePath := filepath.Join(workspacesFolder, workspaceName, "deployment")
	// Docker compose project names must be lowercase
	projectName := strings.ToLower(workspaceName)

	// Tear down the automations + infra (database) containers that gitops
	// deployed at runtime. This runs regardless of whether the gitops API
	// automation removal above succeeded, so it also covers the case where
	// gitops is unreachable. gitops launches these under
	// COMPOSE_PROJECT_NAME=<workspace> (Docker lowercases it) from
	// <workspace>/gitops/docker-compose.yaml; the infra/DB services carry no
	// gitops.* labels, so a compose-file down is the only reliable way to
	// remove them.
	gitopsDir := filepath.Join(workspacesFolder, workspaceName, "gitops")
	gitopsCompose := filepath.Join(gitopsDir, "docker-compose.yaml")
	if _, err := os.Stat(gitopsCompose); err == nil {
		fmt.Fprintln(writer, "Removing automations and infra (database) containers deployed by gitops...")
		cmd := exec.Command("docker", "compose", "-f", "docker-compose.yaml", "-p", projectName, "down", "--volumes")
		cmd.Dir = gitopsDir
		cmd.Stdout = writer
		cmd.Stderr = writer
		if err := cmd.Run(); err != nil {
			fmt.Fprintf(writer, "Warning: Failed to remove gitops-deployed containers/volumes: %v\n", err)
		}
	}

	if _, err := os.Stat(dockerComposePath); os.IsNotExist(err) {
		fmt.Fprintf(writer, "Warning: Deployment directory %s does not exist, skipping docker compose down.\n", dockerComposePath)
		// Still try to remove containers by project name in case they exist
		for _, projSuffix := range []string{"-site", "-dashboard", "-coding-agent"} {
			cmd := exec.Command("docker", "compose", "-p", projectName+projSuffix, "down", "--volumes")
			cmd.Stdout = writer
			cmd.Stderr = writer
			if err := cmd.Run(); err != nil {
				fmt.Fprintf(writer, "Warning: Failed to remove containers for project %s%s: %v\n", projectName, projSuffix, err)
			}
		}
	} else {
		composeArgs := [][]string{
			{"-p", projectName + "-site", "down", "--volumes"},
		}
		// Dashboard and coding-agent each have their own compose file
		// and project; tear down whichever are present.
		for _, svc := range []struct{ file, suffix string }{
			{"docker-compose-dashboard.yml", "-dashboard"},
			{"docker-compose-coding-agent.yml", "-coding-agent"},
		} {
			if _, err := os.Stat(filepath.Join(dockerComposePath, svc.file)); err == nil {
				composeArgs = append(composeArgs, []string{"-f", svc.file, "-p", projectName + svc.suffix, "down", "--volumes"})
			}
		}
		for _, args := range composeArgs {
			cmd := exec.Command("docker", append([]string{"compose"}, args...)...)
			cmd.Dir = dockerComposePath
			cmd.Stdout = writer
			cmd.Stderr = writer
			if err := cmd.Run(); err != nil {
				fmt.Fprintf(writer, "Warning: Failed to remove docker containers and volumes (%v): %v\n", args, err)
			}
		}
	}
	fmt.Fprintln(writer, "Docker containers and volumes removed successfully.")

	// 4. Remove images used by docker-compose
	fmt.Fprintln(writer, "Removing images used by docker-compose...")
	composeFiles := []string{"docker-compose.yml"}
	for _, f := range []string{"docker-compose-dashboard.yml", "docker-compose-coding-agent.yml"} {
		if _, err := os.Stat(filepath.Join(dockerComposePath, f)); err == nil {
			composeFiles = append(composeFiles, f)
		}
	}
	for _, composeFile := range composeFiles {
		removeImagesFromComposeFile(filepath.Join(dockerComposePath, composeFile), writer)
	}
	fmt.Fprintln(writer, "Image removal process completed.")

	// 5. Remove ingress records. Done SYNCHRONOUSLY (before the workspace dir +
	// its metadata are removed below) and sourced from the daemon's OWN Bailey
	// DB, so cleanup never depends on gitops being reachable.
	fmt.Fprintln(writer, "Removing ingress records...")

	// (a) Every per-endpoint route this workspace registered, straight from the
	// Bailey DB (source='gitops', hostname '<ws>-%'). removeRouteFromIngress
	// drops the outer+inner Traefik/Caddy routers AND the Bailey endpoint +
	// protected_route rows; an unreachable ingress is treated as success. This
	// is the fix for the routes that leaked when gitops was unreachable.
	if hosts, herr := listGitopsManagedHosts(workspaceName); herr != nil {
		fmt.Fprintf(writer, "Warning: could not list managed routes for %s: %v\n", workspaceName, herr)
	} else {
		for _, h := range hosts {
			if rerr := removeRouteFromIngress(h); rerr != nil {
				fmt.Fprintf(writer, "Warning: failed to remove route %s: %v\n", h, rerr)
			} else {
				fmt.Fprintf(writer, "Removed route %s\n", h)
			}
		}
	}

	// (b) The platform service routes, in case they weren't recorded as
	// gitops-managed above. Idempotent; needs the domain from metadata, which is
	// still on disk at this point.
	if md, merr := config.GetWorkspaceMetadata(workspaceName); merr == nil && md.Domain != "" {
		for _, svc := range []string{"gitops", "dashboard"} {
			host := fmt.Sprintf("%s-%s.%s", workspaceName, svc, md.Domain)
			if rerr := removeRouteFromIngress(host); rerr != nil {
				fmt.Fprintf(writer, "Warning: failed to remove route %s: %v\n", host, rerr)
			}
		}
	}

	// (c) Sweep residual workspace routes + per-workspace TLS cert entries from
	// the ingress state, and tear down the workspace's own sub-traefik.
	switch DetectIngressType() {
	case IngressCaddy:
		caddyapi.DeleteCaddyRecordsWithWriter(workspaceName, writer)
	case IngressTraefik:
		traefikapi.DeleteTraefikRecordsWithWriter(workspaceName, writer)
		// Also stop workspace sub-traefik if it exists
		containerName := fmt.Sprintf("%s__traefik", workspaceName)
		traefikProjectName := fmt.Sprintf("bitswan-%s-traefik", workspaceName)
		stopCmd := exec.Command("docker", "compose", "-p", traefikProjectName, "down")
		stopCmd.Stdout = writer
		stopCmd.Stderr = writer
		if err := stopCmd.Run(); err != nil {
			// Try force remove
			exec.Command("docker", "rm", "-f", containerName).Run()
		}
	}
	fmt.Fprintln(writer, "Ingress records removed.")

	// 6. Remove the gitops folder
	workspaceDir := filepath.Join(workspacesFolder, workspaceName)
	if _, err := os.Stat(workspaceDir); os.IsNotExist(err) {
		fmt.Fprintf(writer, "Warning: Workspace directory %s does not exist, nothing to remove.\n", workspaceDir)
	} else {
		fmt.Fprintln(writer, "Removing gitops folder...")
		cmd := exec.Command("rm", "-rf", workspaceName)
		cmd.Dir = workspacesFolder
		cmd.Stdout = writer
		cmd.Stderr = writer
		if err := cmd.Run(); err != nil {
			fmt.Fprintf(writer, "Warning: Failed to remove gitops folder: %v\n", err)
		} else {
			fmt.Fprintln(writer, "GitOps folder removed successfully.")
		}
	}

	// 6b. If the active workspace pointed at the one we just removed, repoint it
	// (to a remaining workspace, else clear) so later CLI defaults don't resolve
	// to a deleted workspace. The removed dir is already gone, so GetWorkspaceList
	// won't return it.
	cfg := config.NewAutomationServerConfig()
	if active, aerr := cfg.GetActiveWorkspace(); aerr == nil && active == workspaceName {
		next := ""
		if list, lerr := GetWorkspaceList(false, false); lerr == nil {
			for _, ws := range list.Workspaces {
				if ws.Name != workspaceName {
					next = ws.Name
					break
				}
			}
		}
		if serr := cfg.SetActiveWorkspace(next); serr != nil {
			fmt.Fprintf(writer, "Warning: failed to update active workspace: %v\n", serr)
		} else if next == "" {
			fmt.Fprintln(writer, "Cleared active workspace (it was the removed one).")
		} else {
			fmt.Fprintf(writer, "Active workspace was removed; switched to %s.\n", next)
		}
	}

	// 7. Remove entries from /etc/hosts
	fmt.Fprintln(writer, "Removing entries from /etc/hosts...")
	err = deleteHostsEntry(workspaceName, writer)
	if err != nil {
		return fmt.Errorf("error removing entries from /etc/hosts: %w", err)
	}
	fmt.Fprintln(writer, "Entries removed from /etc/hosts successfully.")

	// Note: Workspace list sync to AOC is handled separately after the result is reported.

	fmt.Fprintln(writer, "Workspace removal completed.")
	return nil
}

func removeImagesFromComposeFile(composeFilePath string, writer io.Writer) {
	data, err := os.ReadFile(composeFilePath)
	if err != nil {
		if os.IsNotExist(err) {
			fmt.Fprintf(writer, "Warning: %s not found, skipping image removal\n", composeFilePath)
		} else {
			fmt.Fprintf(writer, "Warning: error reading %s: %v\n", composeFilePath, err)
		}
		return
	}
	var compose Compose
	if err := yaml.Unmarshal(data, &compose); err != nil {
		fmt.Fprintf(writer, "Warning: error unmarshalling %s: %v\n", composeFilePath, err)
		return
	}
	for _, service := range compose.Services {
		if service.Image == "" {
			continue
		}
		exists, err := checkContainerExists(service.Image)
		if err != nil {
			fmt.Fprintf(writer, "Warning: Error checking if image exists: %v. Continuing with removal.\n", err)
			continue
		}
		if exists {
			fmt.Fprintf(writer, "Image %s is still in use by a different container. Skipping deletion.\n", service.Image)
			continue
		}
		if err := deleteDockerImage(service.Image, writer); err != nil {
			fmt.Fprintf(writer, "Warning: Failed to delete docker image %s: %v. Continuing with removal.\n", service.Image, err)
		} else {
			fmt.Fprintf(writer, "Deleted image: %s\n", service.Image)
		}
	}
}

func checkContainerExists(imageName string) (bool, error) {
	cmd := exec.Command("docker", "ps", "-a", "--filter", "ancestor="+imageName, "--format", "{{.ID}}")

	var out bytes.Buffer
	cmd.Stdout = &out

	err := cmd.Run()
	if err != nil {
		return false, err
	}

	// Trim space and check if the output is empty
	output := strings.TrimSpace(out.String())
	return output != "", nil
}

func deleteDockerImage(image string, writer io.Writer) error {
	// First check if the image exists
	cmd := exec.Command("docker", "images", "-q", image)
	var out bytes.Buffer
	cmd.Stdout = &out
	err := cmd.Run()
	if err != nil {
		return fmt.Errorf("error checking if image exists: %w", err)
	}

	// If image doesn't exist, return a specific error that we can handle
	imageID := strings.TrimSpace(out.String())
	if imageID == "" {
		return fmt.Errorf("image %s does not exist", image)
	}

	// Image exists, try to delete it
	cmd = exec.Command("docker", "rmi", image)
	cmd.Stdout = writer
	cmd.Stderr = writer
	err = cmd.Run()
	if err != nil {
		return fmt.Errorf("error deleting image %s: %w", image, err)
	}
	return nil
}

func deleteHostsEntry(workspaceName string, writer io.Writer) error {
	hostsFilePath := "/etc/hosts"
	input, err := os.ReadFile(hostsFilePath)
	if err != nil {
		fmt.Fprintf(writer, "failed to read /etc/hosts: %v\n", err)
		return nil
	}

	lines := strings.Split(string(input), "\n")
	var outputLines []string

	// Define the entries to be removed
	hostsEntries := []string{
		"127.0.0.1 " + workspaceName + "-gitops.bitswan.local",
	}

	found := false
	for _, entry := range hostsEntries {
		if exec.Command("grep", "-wq", entry, "/etc/hosts").Run() == nil {
			found = true
			break
		}
	}

	// No entries found to remove
	if !found {
		fmt.Fprintln(writer, "No entries found in /etc/hosts to remove.")
		return nil
	}

	// Filter out the lines that match the entries
	for _, line := range lines {
		shouldRemove := false
		for _, entry := range hostsEntries {
			if strings.Contains(line, entry) {
				shouldRemove = true
				break
			}
		}
		if !shouldRemove {
			outputLines = append(outputLines, line)
		}
	}

	// Write the updated content back to /etc/hosts
	output := strings.Join(outputLines, "\n")
	cmd := exec.Command("sh", "-c", fmt.Sprintf("echo '%s' | tee %s", output, hostsFilePath))
	cmd.Stdout = writer
	cmd.Stderr = writer
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(writer, "failed to write to /etc/hosts: %v\n", err)
		return nil
	}
	return nil
}
