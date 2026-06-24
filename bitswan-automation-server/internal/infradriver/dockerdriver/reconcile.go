package dockerdriver

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/docker"
	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

// oauth2ProxyPath is the host binary docker-copied into oauth2-enabled
// containers (gitops oauth2_helpers.OAUTH2_PROXY_PATH).
const oauth2ProxyPath = "/usr/local/bin/oauth2-proxy"

// reconcile brings the generated compose project up and applies the post-up
// container mutations (CA certs, oauth2 sidecars). Port of
// automation_service.apply_compose_for_deployments' operational tail.
func reconcile(ctx context.Context, wctx infradriver.WorkspaceContext, bs *Bitswan, composeYAML string, routes []infradriver.Route, report func(step, msg string)) error {
	// 1. Ensure the per-(workspace, stage) networks the compose references as
	//    external exist (automation_service._ensure_stage_networks).
	report("networks", "Ensuring stage networks...")
	for _, realm := range []string{"dev", "staging", "production"} {
		net := wctx.WorkspaceName + "-" + realm
		if _, err := docker.EnsureDockerNetwork(net, false); err != nil {
			return fmt.Errorf("ensure network %s: %w", net, err)
		}
	}

	// 2. Write the generated compose to the gitops dir (the daemon also keeps it
	//    for debugging — _save_docker_compose).
	composePath := filepath.Join(wctx.GitopsDir, "docker-compose.yaml")
	if err := os.WriteFile(composePath, []byte(composeYAML), 0o644); err != nil {
		return fmt.Errorf("write docker-compose.yaml: %w", err)
	}

	// 3. docker compose up -d, streaming output to prog.
	report("compose_up", "Bringing up docker-compose project...")
	if err := composeUp(ctx, wctx, composePath, report); err != nil {
		return err
	}

	// 3b. Fail-fast: ensure the live Postgres DB each backend connects to exists
	//     before it settles into a connect-retry loop (bp_databases.
	//     ensure_live_postgres_dbs). Raises if Postgres is enabled but the DB
	//     can't be created — a clear deploy error beats a silent crash-loop.
	report("provision", "Ensuring live databases...")
	if err := ensureLivePostgresDBs(ctx, wctx, bs, report); err != nil {
		return fmt.Errorf("ensure live postgres dbs: %w", err)
	}

	// 4. Install CA certs + start oauth2 sidecars in the freshly-(re)started
	//    containers selected by their gitops labels.
	report("certs", "Installing CA certificates...")
	if err := installCertificatesInContainers(ctx, wctx, report); err != nil {
		return err
	}
	report("oauth2", "Starting oauth2 sidecars...")
	if err := startOAuth2ProxyInContainers(ctx, wctx, report); err != nil {
		return err
	}

	// 4b. Best-effort per-BP namespaces: MinIO buckets + the standby blue-green
	//     Postgres DB (bp_databases.provision_for_deployments). Never fails the
	//     deploy — these back snapshots/restore, not the live path.
	report("provision", "Provisioning per-BP namespaces...")
	provisionForDeployments(ctx, wctx, bs, report)

	// 5. Configure ingress: converge the daemon's gitops-managed routes to the
	//    desired set. The applier owns the Ingress (k8s-style), so this is the
	//    single ingress side effect of an apply — gitops no longer registers
	//    routes. Fail loudly: a route the deploy implies but the ingress lacks
	//    means the endpoint 404s, which must surface, not be swallowed.
	report("ingress", "Reconciling ingress routes...")
	if err := reconcileIngress(ctx, wctx.WorkspaceName, routes); err != nil {
		return err
	}
	return nil
}

// composeUp runs `docker compose -p <ws> -f <file> up -d` and streams output.
func composeUp(ctx context.Context, wctx infradriver.WorkspaceContext, composePath string, report func(step, msg string)) error {
	args := []string{"compose", "-p", wctx.WorkspaceName, "-f", composePath, "up", "-d", "--remove-orphans"}
	cmd := exec.CommandContext(ctx, "docker", args...)
	cmd.Env = append(os.Environ(), "COMPOSE_PROJECT_NAME="+wctx.WorkspaceName)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("docker compose up: %w", err)
	}
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		report("compose_up", scanner.Text())
	}
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("docker compose up failed: %w", err)
	}
	return nil
}

// containerInfo is the subset of `docker inspect` needed for the post-up steps.
type containerInfo struct {
	id     string
	state  string
	labels map[string]string
}

// listWorkspaceContainers returns the workspace's containers with their state
// and labels (gitops get_container, but scoped to the whole workspace).
func listWorkspaceContainers(ctx context.Context, wctx infradriver.WorkspaceContext) ([]containerInfo, error) {
	out, err := exec.CommandContext(ctx, "docker", "ps", "--all", "--no-trunc", "--quiet",
		"--filter", "label=gitops.workspace="+wctx.WorkspaceName).Output()
	if err != nil {
		return nil, fmt.Errorf("docker ps: %w", err)
	}
	ids := strings.Fields(string(out))
	if len(ids) == 0 {
		return nil, nil
	}
	raw, err := exec.CommandContext(ctx, "docker", append([]string{"inspect"}, ids...)...).Output()
	if err != nil {
		return nil, fmt.Errorf("docker inspect: %w", err)
	}
	inspected, err := parseInspect(raw)
	if err != nil {
		return nil, err
	}
	infos := make([]containerInfo, 0, len(inspected))
	for _, c := range inspected {
		infos = append(infos, containerInfo{id: c.ID, state: c.State, labels: c.Labels})
	}
	return infos, nil
}

// certInstallScript mirrors install_certificates_in_container's inline script.
const certInstallScript = `if [ -d /usr/local/share/ca-certificates/custom ]; then
    cp /usr/local/share/ca-certificates/custom/*.crt /usr/local/share/ca-certificates/ 2>/dev/null || true
    cp /usr/local/share/ca-certificates/custom/*.pem /usr/local/share/ca-certificates/ 2>/dev/null || true
    for f in /usr/local/share/ca-certificates/*.pem; do
        [ -f "$f" ] && mv "$f" "${f%.pem}.crt"
    done
    update-ca-certificates 2>&1 | grep -v "WARNING" || true
    echo "CA certificates installed successfully"
else
    echo "No custom CA certificates directory found"
fi`

// installCertificatesInContainers ports install_certificates_in_container: for
// every running container labelled gitops.certs.enabled=true, exec the cert
// install script.
func installCertificatesInContainers(ctx context.Context, wctx infradriver.WorkspaceContext, report func(step, msg string)) error {
	infos, err := listWorkspaceContainers(ctx, wctx)
	if err != nil {
		return err
	}
	for _, c := range infos {
		if c.labels["gitops.certs.enabled"] != "true" {
			continue
		}
		if c.state != "running" {
			continue
		}
		if out, err := exec.CommandContext(ctx, "docker", "exec", c.id, "sh", "-c", certInstallScript).CombinedOutput(); err != nil {
			report("certs", fmt.Sprintf("cert install in %s failed: %v: %s", c.id[:12], err, strings.TrimSpace(string(out))))
		}
	}
	return nil
}

// isOAuth2ProxyRunning checks /proc for an oauth2-proxy process in the container
// (oauth2_helpers.is_oauth2_proxy_running).
func isOAuth2ProxyRunning(ctx context.Context, id string) bool {
	script := `for f in /proc/[0-9]*/comm; do if [ "$(cat $f 2>/dev/null)" = "oauth2-proxy" ]; then exit 0; fi; done; exit 1`
	return exec.CommandContext(ctx, "docker", "exec", id, "sh", "-c", script).Run() == nil
}

// startOAuth2ProxyInContainers ports start_oauth2_proxy_in_container: for every
// running container labelled gitops.oauth2.enabled=true that is not already
// running oauth2-proxy, docker-cp the binary in and start it detached.
func startOAuth2ProxyInContainers(ctx context.Context, wctx infradriver.WorkspaceContext, report func(step, msg string)) error {
	infos, err := listWorkspaceContainers(ctx, wctx)
	if err != nil {
		return err
	}
	logoutFlag := ""
	if issuer := strings.TrimSpace(os.Getenv("OAUTH2_PROXY_OIDC_ISSUER_URL")); issuer != "" {
		logoutFlag = fmt.Sprintf(" --backend-logout-url='%s/protocol/openid-connect/logout?id_token_hint={id_token}'", issuer)
	}
	for _, c := range infos {
		if c.labels["gitops.oauth2.enabled"] != "true" {
			continue
		}
		if c.state != "running" {
			continue
		}
		if isOAuth2ProxyRunning(ctx, c.id) {
			continue
		}
		if out, err := exec.CommandContext(ctx, "docker", "cp", oauth2ProxyPath, c.id+":"+oauth2ProxyPath).CombinedOutput(); err != nil {
			report("oauth2", fmt.Sprintf("oauth2-proxy copy into %s failed: %v: %s", c.id[:12], err, strings.TrimSpace(string(out))))
			continue
		}
		startCmd := fmt.Sprintf("oauth2-proxy%s > /tmp/oauth2-proxy.log 2>&1 &", logoutFlag)
		if out, err := exec.CommandContext(ctx, "docker", "exec", c.id, "sh", "-c", startCmd).CombinedOutput(); err != nil {
			report("oauth2", fmt.Sprintf("oauth2-proxy start in %s failed: %v: %s", c.id[:12], err, strings.TrimSpace(string(out))))
		}
	}
	return nil
}
