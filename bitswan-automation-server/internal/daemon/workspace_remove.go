package daemon

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/traefikapi"
)

// RunWorkspaceRemove tears down EVERYTHING a workspace consists of, entirely
// daemon-side — it never talks to the workspace's gitops container (which may
// already be stopped, broken, or half-removed).
//
// Teardown keys on what the runtime actually stamps on resources, not on
// compose files that may no longer exist:
//   - every runtime container (automations, per-stage infra services like
//     <ws>__postgres-dev, egress gateways, the gitops container itself)
//     carries the label `gitops.workspace=<ws>`;
//   - compose-managed volumes carry `com.docker.compose.project`;
//   - the per-workspace stage networks are exactly <ws>-{dev,staging,production}.
//
// Order: metadata first (files die later) → compose downs (belt & braces —
// they also delete project networks/volumes) → label sweep → volumes →
// networks → ingress routes/TLS → images → files → active-workspace repoint →
// /etc/hosts. Every step is best-effort with a log line; a failed step never
// aborts the rest (an aborted teardown leaves strictly more garbage).
//
// NEVER deleted here (shared across all workspaces): the `bitswan` volume
// (every workspace and the daemon's own config live in it as subpaths — this
// workspace's bytes go away via rm -rf of its subdirectory), the
// `bitswan-mkcert` volume, and the `bitswan_network` network.
func RunWorkspaceRemove(workspaceName string, writer io.Writer) error {
	// Get the real user's home directory (host home, not container home)
	homeDir, err := config.GetRealUserHomeDir()
	if err != nil {
		// Fallback to HOME if we can't determine the real user
		homeDir = os.Getenv("HOME")
	}
	bitswanPath := filepath.Join(homeDir, ".config", "bitswan")
	workspacesFolder := filepath.Join(bitswanPath, "workspaces")
	workspaceDir := filepath.Join(workspacesFolder, workspaceName)
	dockerComposePath := filepath.Join(workspaceDir, "deployment")
	gitopsDir := filepath.Join(workspaceDir, "gitops")
	// Docker compose project names must be lowercase
	projectName := strings.ToLower(workspaceName)

	// 1. Read metadata (domain) BEFORE anything deletes files. A workspace
	// whose init failed early has no metadata.yaml yet (certs and files can
	// exist before it is written) — fall back to the server's configured
	// domain, the same default init resolves, so route/TLS cleanup still
	// knows the platform hostnames.
	domain := ""
	if md, merr := config.GetWorkspaceMetadata(workspaceName); merr == nil {
		domain = md.Domain
	}
	if domain == "" {
		if sc, cerr := config.NewAutomationServerConfig().LoadConfig(); cerr == nil && sc != nil {
			domain = sc.ProtectedHostnameDomain()
		}
	}

	// 2. Compose downs — belt & braces: each `down --volumes` also removes the
	// project's own networks and volumes. The label sweep below catches
	// whatever these miss (e.g. when the compose files are already gone).
	fmt.Fprintln(writer, "Removing docker containers and volumes...")

	// 2a. The whole-workspace runtime compose, if gitops ever wrote one. The
	// driver deploys under the RAW workspace name as the project; older code
	// used the lowercased form — try both when they differ.
	gitopsProjects := []string{workspaceName}
	if projectName != workspaceName {
		gitopsProjects = append(gitopsProjects, projectName)
	}
	if _, err := os.Stat(filepath.Join(gitopsDir, "docker-compose.yaml")); err == nil {
		for _, proj := range gitopsProjects {
			cmd := exec.Command("docker", "compose", "-f", "docker-compose.yaml", "-p", proj, "down", "--volumes")
			cmd.Dir = gitopsDir
			cmd.Stdout = writer
			cmd.Stderr = writer
			if err := cmd.Run(); err != nil {
				fmt.Fprintf(writer, "Warning: Failed to remove gitops-deployed containers/volumes (project %s): %v\n", proj, err)
			}
		}
	}

	// 2b. Per-BP runtime compose files: per-BP deploys write the compiled
	// compose to gitops/bp/<bp>/docker-compose.yaml (NOT the root file), which
	// is where the automation + infra (database) + gateway containers of a
	// modern workspace actually come from.
	if bpComposeFiles, gerr := filepath.Glob(filepath.Join(gitopsDir, "bp", "*", "docker-compose.yaml")); gerr == nil {
		for _, composeFile := range bpComposeFiles {
			fmt.Fprintf(writer, "Removing containers deployed from %s...\n", composeFile)
			for _, proj := range gitopsProjects {
				cmd := exec.Command("docker", "compose", "-f", "docker-compose.yaml", "-p", proj, "down", "--volumes")
				cmd.Dir = filepath.Dir(composeFile)
				cmd.Stdout = writer
				cmd.Stderr = writer
				if err := cmd.Run(); err != nil {
					fmt.Fprintf(writer, "Warning: Failed compose down for %s (project %s): %v\n", composeFile, proj, err)
				}
			}
		}
	}

	// 2c. The daemon-managed deployment projects (site = gitops+infra-driver,
	// dashboard, coding-agent).
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

	// 2d. The workspace sub-traefik, under both historical project names.
	for _, proj := range []string{fmt.Sprintf("bitswan-%s-traefik", workspaceName), fmt.Sprintf("%s__traefik", workspaceName)} {
		cmd := exec.Command("docker", "compose", "-p", proj, "down", "--volumes")
		cmd.Stdout = writer
		cmd.Stderr = writer
		_ = cmd.Run()
	}
	_ = exec.Command("docker", "rm", "-f", fmt.Sprintf("%s__traefik", workspaceName)).Run()

	// 3. Label sweep — the authoritative teardown. Every container the
	// workspace ever ran carries gitops.workspace=<ws>, so this removes
	// automations, infra services, gateways and platform containers even when
	// every compose file above was already gone.
	if ids, lerr := dockerContainerIDsByLabel("gitops.workspace=" + workspaceName); lerr != nil {
		fmt.Fprintf(writer, "Warning: could not list workspace containers: %v\n", lerr)
	} else if len(ids) > 0 {
		fmt.Fprintf(writer, "Removing %d remaining workspace container(s) by label...\n", len(ids))
		dockerRemoveContainers(ids, writer)
	}
	fmt.Fprintln(writer, "Docker containers removed.")

	// 4. Volume sweep by compose-project label (naming-agnostic; catches the
	// per-stage infra data volumes like <ws>-postgres-dev-data-data).
	for _, proj := range workspaceComposeProjects(workspaceName) {
		vols, verr := dockerVolumesByComposeProject(proj)
		if verr != nil {
			fmt.Fprintf(writer, "Warning: could not list volumes for project %s: %v\n", proj, verr)
			continue
		}
		dockerRemoveVolumes(vols, writer)
	}
	fmt.Fprintln(writer, "Docker volumes removed.")

	// 5. Per-workspace stage networks (shared bitswan_network is guarded).
	dockerRemoveNetworks(workspaceStageNetworks(workspaceName), writer)
	fmt.Fprintln(writer, "Docker networks removed.")

	// 6. Ingress records — synchronously, from the daemon's OWN Bailey DB, so
	// cleanup never depends on gitops. Candidates are the UNION of the
	// endpoints table AND the protected_routes table: infra-service routes
	// (minio/postgres admin UIs) and other site services are routes without
	// owned endpoints and would be invisible to an endpoints-only sweep (see
	// listProtectedRoutes). ALL of the workspace's hosts are removed
	// regardless of source ('gitops' or 'manual'): the workspace is gone, so
	// a route that was never promoted to source='gitops' must not survive it.
	// Hosts of a SIBLING workspace whose name extends this one (ws "pr" vs ws
	// "pr-two" → "pr-two-gitops....") are excluded.
	fmt.Fprintln(writer, "Removing ingress records...")
	var candidates []string
	if endpoints, eerr := listAllEndpoints(); eerr != nil {
		fmt.Fprintf(writer, "Warning: could not list endpoints: %v\n", eerr)
	} else {
		for _, ep := range endpoints {
			candidates = append(candidates, ep.Hostname)
		}
	}
	if routes, rerr := listProtectedRoutes(); rerr != nil {
		fmt.Fprintf(writer, "Warning: could not list protected routes: %v\n", rerr)
	} else {
		for _, r := range routes {
			candidates = append(candidates, r.Hostname)
		}
	}
	hosts := workspaceHostsToRemove(candidates, workspaceName, domain, listSiblingWorkspaces(workspacesFolder, workspaceName))
	for _, h := range hosts {
		if rerr := removeRouteFromIngress(h); rerr != nil {
			fmt.Fprintf(writer, "Warning: failed to remove route %s: %v\n", h, rerr)
		} else {
			fmt.Fprintf(writer, "Removed route %s\n", h)
		}
	}
	// Sweep residual workspace routes + per-workspace TLS cert entries from
	// the ingress state (reads metadata.yaml itself — the files still exist).
	// TLS entries + cert files are matched by the EXACT host set derived
	// above; the workspace's `*.<domain>` wildcard cert is included only when
	// no remaining workspace declares the same domain (a shared domain's
	// wildcard must survive siblings).
	tlsHosts := append([]string{}, hosts...)
	if domain != "" && !domainUsedByAnotherWorkspace(workspacesFolder, workspaceName, domain) {
		tlsHosts = append(tlsHosts, "*."+domain)
	}
	// The --local convention's wildcard (`*.bs-<ws>.localhost`, installed by
	// mkcerts BEFORE metadata.yaml exists) embeds the full workspace name, so
	// it can never belong to a sibling — always a safe exact candidate, and
	// the only way to find it when a failed init left no metadata behind.
	tlsHosts = append(tlsHosts, fmt.Sprintf("*.bs-%s.localhost", workspaceName))
	traefikapi.DeleteTraefikRecordsWithWriter(workspaceName, tlsHosts, writer)
	fmt.Fprintln(writer, "Ingress records removed.")

	// 7. Images: ONLY the workspace's own automation images (tagged
	// internal/<ws>-..., per the driver's imageTagPrefix; the lowercased form
	// is swept too for safety). The platform images the deployment compose
	// files reference (bitswan/gitops, dashboard, coding-agent, infra-driver)
	// are SHARED across workspaces — the old per-compose-file removal deleted
	// them whenever the last workspace using them was removed, forcing a
	// re-pull (or, for the locally-built -dev:latest images, a full rebuild)
	// on the next init.
	fmt.Fprintln(writer, "Removing images...")
	removeImagesByPrefix("internal/"+workspaceName+"-", writer)
	if projectName != workspaceName {
		removeImagesByPrefix("internal/"+projectName+"-", writer)
	}
	fmt.Fprintln(writer, "Image removal process completed.")

	// 8. Remove the workspace directory (its subtree of the shared volume).
	if _, err := os.Stat(workspaceDir); os.IsNotExist(err) {
		fmt.Fprintf(writer, "Warning: Workspace directory %s does not exist, nothing to remove.\n", workspaceDir)
	} else {
		fmt.Fprintln(writer, "Removing workspace folder...")
		cmd := exec.Command("rm", "-rf", workspaceName)
		cmd.Dir = workspacesFolder
		cmd.Stdout = writer
		cmd.Stderr = writer
		if err := cmd.Run(); err != nil {
			fmt.Fprintf(writer, "Warning: Failed to remove workspace folder: %v\n", err)
		} else {
			fmt.Fprintln(writer, "Workspace folder removed successfully.")
		}
	}

	// 8b. If the active workspace pointed at the one we just removed, repoint it
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

	// 9. Remove entries from /etc/hosts (honouring the workspace's real domain).
	fmt.Fprintln(writer, "Removing entries from /etc/hosts...")
	if err := deleteHostsEntry(workspaceName, domain, writer); err != nil {
		return fmt.Errorf("error removing entries from /etc/hosts: %w", err)
	}
	fmt.Fprintln(writer, "Entries removed from /etc/hosts successfully.")

	// Note: Workspace list sync to AOC is handled separately after the result is reported.

	fmt.Fprintln(writer, "Workspace removal completed.")
	return nil
}

// ── teardown inventory (pure — unit-testable) ───────────────────────────────

// workspaceComposeProjects returns every docker-compose project name that may
// hold the workspace's resources: the runtime project (raw + legacy lowercase)
// plus the daemon-managed deployment and sub-traefik projects.
func workspaceComposeProjects(workspaceName string) []string {
	lc := strings.ToLower(workspaceName)
	out := []string{workspaceName}
	if lc != workspaceName {
		out = append(out, lc)
	}
	return append(out,
		lc+"-site",
		lc+"-dashboard",
		lc+"-coding-agent",
		"bitswan-"+workspaceName+"-traefik",
		workspaceName+"__traefik",
	)
}

// workspaceStageNetworks returns the per-workspace stage networks created by
// the sub-traefik init and the driver's reconcile.
func workspaceStageNetworks(workspaceName string) []string {
	return []string{
		workspaceName + "-dev",
		workspaceName + "-staging",
		workspaceName + "-production",
	}
}

// isProtectedDockerVolume guards the volumes shared by ALL workspaces (and the
// daemon itself) against a workspace-scoped sweep.
func isProtectedDockerVolume(name string) bool {
	return name == "bitswan" || name == "bitswan-mkcert"
}

// isProtectedDockerNetwork guards the shared platform network.
func isProtectedDockerNetwork(name string) bool {
	return name == "bitswan_network"
}

// workspaceHostsToRemove selects, from candidate hostnames (the union of the
// Bailey endpoints and protected_routes tables), the hosts a workspace
// removal must drop: every host under the `<ws>-` prefix regardless of
// source (gitops-managed or manual — the workspace is gone either way),
// excluding hosts that belong to a SIBLING workspace whose name extends this
// one (removing "pr" must not take "pr-two-gitops..." with it), plus the
// platform gitops/dashboard hosts derived from the metadata domain.
func workspaceHostsToRemove(candidates []string, workspaceName, domain string, siblingWorkspaces []string) []string {
	prefix := strings.ToLower(workspaceName) + "-"
	var siblingPrefixes []string
	for _, s := range siblingWorkspaces {
		ls := strings.ToLower(s)
		if s != workspaceName && strings.HasPrefix(ls, prefix) {
			siblingPrefixes = append(siblingPrefixes, ls+"-")
		}
	}

	seen := map[string]bool{}
	var out []string
	add := func(host string) {
		h := strings.ToLower(strings.TrimSpace(host))
		if h == "" || seen[h] {
			return
		}
		seen[h] = true
		out = append(out, h)
	}

	for _, candidate := range candidates {
		h := strings.ToLower(candidate)
		if !strings.HasPrefix(h, prefix) {
			continue
		}
		sibling := false
		for _, sp := range siblingPrefixes {
			if strings.HasPrefix(h, sp) {
				sibling = true
				break
			}
		}
		if sibling {
			continue
		}
		add(h)
	}
	if domain != "" {
		for _, svc := range []string{"gitops", "dashboard"} {
			add(fmt.Sprintf("%s-%s.%s", workspaceName, svc, domain))
		}
	}
	return out
}

// listSiblingWorkspaces returns the OTHER workspace directory names, used to
// protect a sibling whose name extends the one being removed.
func listSiblingWorkspaces(workspacesFolder, workspaceName string) []string {
	entries, err := os.ReadDir(workspacesFolder)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() && e.Name() != workspaceName {
			out = append(out, e.Name())
		}
	}
	return out
}

// domainUsedByAnotherWorkspace reports whether any remaining workspace's
// metadata declares the same domain. When it does, the domain's wildcard
// TLS cert is shared and must survive this workspace's removal.
func domainUsedByAnotherWorkspace(workspacesFolder, workspaceName, domain string) bool {
	for _, sibling := range listSiblingWorkspaces(workspacesFolder, workspaceName) {
		if md, err := config.GetWorkspaceMetadata(sibling); err == nil && md.Domain == domain {
			return true
		}
	}
	return false
}

// filterHostsFileLines drops every line containing one of the entry tokens.
// Returns the kept lines and whether anything was removed.
func filterHostsFileLines(lines []string, entries []string) ([]string, bool) {
	var kept []string
	found := false
	for _, line := range lines {
		remove := false
		for _, entry := range entries {
			if entry != "" && strings.Contains(line, entry) {
				remove = true
				break
			}
		}
		if remove {
			found = true
			continue
		}
		kept = append(kept, line)
	}
	return kept, found
}

// ── docker sweeps (thin exec wrappers — best-effort) ─────────────────────────

func dockerContainerIDsByLabel(label string) ([]string, error) {
	cmd := exec.Command("docker", "ps", "-aq", "--filter", "label="+label)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	return strings.Fields(out.String()), nil
}

func dockerRemoveContainers(ids []string, writer io.Writer) {
	for _, id := range ids {
		if err := exec.Command("docker", "rm", "-f", id).Run(); err != nil {
			fmt.Fprintf(writer, "Warning: failed to remove container %s: %v\n", id, err)
		}
	}
}

func dockerVolumesByComposeProject(project string) ([]string, error) {
	cmd := exec.Command("docker", "volume", "ls", "-q", "--filter", "label=com.docker.compose.project="+project)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	return strings.Fields(out.String()), nil
}

func dockerRemoveVolumes(names []string, writer io.Writer) {
	for _, name := range names {
		if isProtectedDockerVolume(name) {
			fmt.Fprintf(writer, "Refusing to remove shared volume %s.\n", name)
			continue
		}
		if err := exec.Command("docker", "volume", "rm", name).Run(); err != nil {
			fmt.Fprintf(writer, "Warning: failed to remove volume %s: %v\n", name, err)
		} else {
			fmt.Fprintf(writer, "Removed volume %s\n", name)
		}
	}
}

func dockerRemoveNetworks(names []string, writer io.Writer) {
	for _, name := range names {
		if isProtectedDockerNetwork(name) {
			fmt.Fprintf(writer, "Refusing to remove shared network %s.\n", name)
			continue
		}
		// Missing networks are a silent no-op (idempotent re-runs).
		if err := exec.Command("docker", "network", "inspect", name).Run(); err != nil {
			continue
		}
		if err := exec.Command("docker", "network", "rm", name).Run(); err != nil {
			fmt.Fprintf(writer, "Warning: failed to remove network %s: %v\n", name, err)
		} else {
			fmt.Fprintf(writer, "Removed network %s\n", name)
		}
	}
}

// removeImagesByPrefix best-effort removes every image whose repository:tag
// starts with the prefix (the workspace's automation-image namespace),
// skipping images still used by a container.
func removeImagesByPrefix(prefix string, writer io.Writer) {
	cmd := exec.Command("docker", "images", "--format", "{{.Repository}}:{{.Tag}}")
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(writer, "Warning: could not list images: %v\n", err)
		return
	}
	for _, tag := range strings.Fields(out.String()) {
		if !strings.HasPrefix(tag, prefix) {
			continue
		}
		inUse, err := checkContainerExists(tag)
		if err == nil && inUse {
			fmt.Fprintf(writer, "Image %s is still in use by a container. Skipping deletion.\n", tag)
			continue
		}
		if err := deleteDockerImage(tag, writer); err != nil {
			fmt.Fprintf(writer, "Warning: Failed to delete docker image %s: %v. Continuing with removal.\n", tag, err)
		} else {
			fmt.Fprintf(writer, "Deleted image: %s\n", tag)
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

// deleteHostsEntry removes the workspace's /etc/hosts entries, matching on the
// hostname token under the workspace's REAL domain (falling back to the legacy
// bitswan.local for entries written before domains were recorded).
func deleteHostsEntry(workspaceName, domain string, writer io.Writer) error {
	hostsFilePath := "/etc/hosts"
	input, err := os.ReadFile(hostsFilePath)
	if err != nil {
		fmt.Fprintf(writer, "failed to read /etc/hosts: %v\n", err)
		return nil
	}

	entries := []string{workspaceName + "-gitops.bitswan.local"}
	if domain != "" && domain != "bitswan.local" {
		entries = append(entries, workspaceName+"-gitops."+domain)
	}

	lines := strings.Split(string(input), "\n")
	outputLines, found := filterHostsFileLines(lines, entries)
	if !found {
		fmt.Fprintln(writer, "No entries found in /etc/hosts to remove.")
		return nil
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
