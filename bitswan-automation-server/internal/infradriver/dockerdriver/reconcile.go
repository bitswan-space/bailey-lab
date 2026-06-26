package dockerdriver

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/bitswan-space/bitswan-workspaces/internal/docker"
	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

// reconcile brings the generated compose project up and applies the post-up
// container mutations (CA certs). Port of
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

	// Snapshot existing container ids BEFORE bringing the project up, so the cert
	// step can target only the containers THIS apply (re)creates — a recreate
	// yields a new id, so any cert-enabled container whose id isn't in this set
	// is fresh and needs its CA trust store set up. Best-effort: on error the set
	// is empty, so every cert-enabled container is treated as fresh (safe).
	preInfos, _ := listWorkspaceContainers(ctx, wctx)
	preExistingIDs := make(map[string]bool, len(preInfos))
	for _, c := range preInfos {
		preExistingIDs[c.id] = true
	}

	// 2. Stamp each egress (network_mode:service) worker with a stable
	//    desired-config hash label, then write the compose. docker compose
	//    recreates those netns-sharing workers on every `up` (its own config-hash
	//    for them is unstable), so we reconcile them ourselves below.
	composePath := filepath.Join(wctx.GitopsDir, "docker-compose.yaml")
	finalYAML, workers, allServices, perr := prepareComposeForEgress(composeYAML)
	if perr != nil {
		// Couldn't analyze the compose — fall back to writing it as-is and a
		// plain full up (correctness over the egress optimization).
		report("compose_up", fmt.Sprintf("egress pre-pass skipped (%v) — full reconcile", perr))
		finalYAML, workers = composeYAML, nil
	}
	if err := os.WriteFile(composePath, []byte(finalYAML), 0o644); err != nil {
		return fmt.Errorf("write docker-compose.yaml: %w", err)
	}

	// 3. Reconcile. With egress workers present, bring everything else up
	//    normally and recreate only the workers whose hash changed (or whose
	//    gateway was recreated); otherwise a plain full `compose up`.
	if len(workers) > 0 {
		if err := reconcileEgressAware(ctx, wctx, composePath, workers, allServices, report); err != nil {
			return err
		}
	} else {
		report("compose_up", "Bringing up docker-compose project...")
		if err := composeUpServices(ctx, wctx, composePath, nil, true /*removeOrphans*/, false /*noDeps*/, report); err != nil {
			return err
		}
	}

	// 3b. Fail-fast: ensure the live Postgres DB exists for each backend THIS
	//     apply (re)created, before it settles into a connect-retry loop
	//     (bp_databases.ensure_live_postgres_dbs). Scoped to fresh containers via
	//     the same shadow-DOM analysis as certs — a backend that was already
	//     running has a working DB, so there's nothing to fail-fast on. Raises if
	//     Postgres is enabled but a needed DB can't be created.
	report("provision", "Ensuring live databases for (re)created backends...")
	if err := ensureLivePostgresDBs(ctx, wctx, bs, preExistingIDs, report); err != nil {
		return fmt.Errorf("ensure live postgres dbs: %w", err)
	}

	// 4. Install CA certs into the containers THIS apply (re)created — a
	//    long-running container already set its trust store up at creation, so
	//    re-exec'ing into every cert-enabled container each deploy is wasted work.
	//    (No per-container oauth2-proxy: oauth2 is deprecated — Bailey's
	//    protected-ingress handles auth at the edge.)
	report("certs", "Installing CA certificates in (re)created containers...")
	if err := installCertificatesInContainers(ctx, wctx, preExistingIDs, report); err != nil {
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

// composeUpServices runs `docker compose -p <ws> -f <file> up -d [flags]
// [services...]` and streams output. An empty services slice means the whole
// project. removeOrphans is only safe for a whole-project / non-worker up (it
// removes containers no longer in the file); noDeps recreates exactly the named
// services without touching their dependencies.
func composeUpServices(ctx context.Context, wctx infradriver.WorkspaceContext, composePath string, services []string, removeOrphans, noDeps bool, report func(step, msg string)) error {
	args := []string{"compose", "-p", wctx.WorkspaceName, "-f", composePath, "up", "-d"}
	if removeOrphans {
		args = append(args, "--remove-orphans")
	}
	if noDeps {
		args = append(args, "--no-deps")
	}
	args = append(args, services...)
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
func installCertificatesInContainers(ctx context.Context, wctx infradriver.WorkspaceContext, preExistingIDs map[string]bool, report func(step, msg string)) error {
	infos, err := listWorkspaceContainers(ctx, wctx)
	if err != nil {
		return err
	}
	// Install into the freshly-(re)created cert-enabled containers concurrently —
	// each exec is independent, so a serial loop just sums their latencies. A
	// container whose id was already present before this apply kept its CA trust
	// store from when it was created, so it's skipped.
	var wg sync.WaitGroup
	var mu sync.Mutex
	for _, c := range infos {
		if c.labels["gitops.certs.enabled"] != "true" || c.state != "running" {
			continue
		}
		if preExistingIDs[c.id] {
			continue // unchanged since before this apply — certs already installed
		}
		wg.Add(1)
		go func(c containerInfo) {
			defer wg.Done()
			if out, err := exec.CommandContext(ctx, "docker", "exec", c.id, "sh", "-c", certInstallScript).CombinedOutput(); err != nil {
				mu.Lock()
				report("certs", fmt.Sprintf("cert install in %s failed: %v: %s", c.id[:12], err, strings.TrimSpace(string(out))))
				mu.Unlock()
			}
		}(c)
	}
	wg.Wait()
	return nil
}
