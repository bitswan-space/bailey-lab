package dockerdriver

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/docker"
	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
	yaml "gopkg.in/yaml.v3"
)

// reconcile brings the generated compose project up and applies the post-up
// container mutations (CA certs). Port of
// automation_service.apply_compose_for_deployments' operational tail.
// stateDir is where this apply's generated docker-compose.yaml (and, in a per-BP
// deploy repo, the materialized bitswan.yaml) live. Per-BP applies (wctx.BP set)
// write under gitops/bp/<bp>/ so concurrent BP applies never clobber each other's
// compose file; the legacy whole-workspace apply uses the gitops root.
func stateDir(wctx infradriver.WorkspaceContext) string {
	if wctx.BP != "" {
		return filepath.Join(wctx.GitopsDir, "bp", wctx.BP)
	}
	return wctx.GitopsDir
}

func reconcile(ctx context.Context, wctx infradriver.WorkspaceContext, bs *Bitswan, composeYAML string, routes []infradriver.Route, report func(step, msg string)) error {
	// Per-phase profiling: attribute the wall-clock between consecutive progress
	// steps to the step that just finished, and write a summary line at the end
	// (perf-reconcile.log). Zero per-phase edits — every report() below is a
	// phase boundary.
	pt := newPhaseTimer(report)
	report = pt.report
	defer pt.finish(wctx.GitopsDir, wctx.BP)

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
	composePath := filepath.Join(stateDir(wctx), "docker-compose.yaml")
	if err := os.MkdirAll(filepath.Dir(composePath), 0o755); err != nil {
		return fmt.Errorf("mkdir state dir: %w", err)
	}
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

	// 3. Reconcile. An EMPTY desired set — a BP delete pushes an emptied
	//    bitswan.yaml, compiling to `services: {}` — has nothing to bring up,
	//    and `docker compose up` on a services-less file fails with "no
	//    service selected". Skip the up but run the REST of the apply: the
	//    ingress reconcile prunes the BP's routes and orphan retirement
	//    removes any surviving containers. With egress workers present, bring
	//    everything else up normally and recreate only the workers whose hash
	//    changed (or whose gateway was recreated); otherwise a plain full
	//    `compose up`.
	if desired := composeServiceNames(composePath); desired != nil && len(desired) == 0 {
		report("compose_up", "No services declared — skipping compose up (empty-slice reconcile).")
	} else if len(workers) > 0 {
		if err := reconcileEgressAware(ctx, wctx, composePath, workers, allServices, report); err != nil {
			return err
		}
	} else {
		report("compose_up", "Bringing up docker-compose project...")
		// removeOrphans=false: a production promote retires the OLD live slot,
		// but we must keep its containers serving until AFTER the ingress flips
		// to the new slot (step 5b). Orphans are reaped post-cutover.
		if err := composeUpServices(ctx, wctx, composePath, nil, false /*removeOrphans*/, false /*noDeps*/, report); err != nil {
			return err
		}
	}

	// ONE post-up container snapshot, shared by the live-DB, cert and orphan
	// steps below — none of them create or remove containers, so re-listing per
	// step just repeats an expensive `docker ps`. (Best-effort: on error the
	// steps that need it treat it as empty, same as their old per-call failure.)
	postInfos, _ := listWorkspaceContainers(ctx, wctx)

	// 3b. Fail-fast: ensure the live Postgres DB exists for each backend THIS
	//     apply (re)created, before it settles into a connect-retry loop
	//     (bp_databases.ensure_live_postgres_dbs). Scoped to fresh containers via
	//     the same shadow-DOM analysis as certs — a backend that was already
	//     running has a working DB, so there's nothing to fail-fast on. Raises if
	//     Postgres is enabled but a needed DB can't be created.
	report("provision", "Ensuring live databases for (re)created backends...")
	if err := ensureLivePostgresDBs(ctx, wctx, bs, preExistingIDs, postInfos, report); err != nil {
		return fmt.Errorf("ensure live postgres dbs: %w", err)
	}

	// 4. Install CA certs into the containers THIS apply (re)created — a
	//    long-running container already set its trust store up at creation, so
	//    re-exec'ing into every cert-enabled container each deploy is wasted work.
	//    (No per-container oauth2-proxy: oauth2 is deprecated — Bailey's
	//    protected-ingress handles auth at the edge.)
	report("certs", "Installing CA certificates in (re)created containers...")
	if err := installCertificatesInContainers(ctx, wctx, postInfos, preExistingIDs, report); err != nil {
		return err
	}

	// 4b. Best-effort per-BP namespaces: Garage buckets/keys + the standby
	//     blue-green Postgres DB (bp_databases.provision_for_deployments). Never
	//     fails the deploy — these back snapshots/restore, not the live path.
	report("provision", "Provisioning per-BP namespaces...")
	if changed := provisionForDeployments(ctx, wctx, bs, report); len(changed) > 0 {
		// First-ever-apply convergence: those backends were compiled against
		// EMPTY placeholder creds files (garage wasn't up yet to mint keys —
		// see bpcreds.go). The files now hold real key material, and compose
		// recreates a service whose resolved env_file content changed, so one
		// targeted up gives exactly those backends their working credentials.
		// Recreating them is strictly an improvement (they never had working
		// S3 creds), including a "live" production slot on its first apply.
		// An affected network_mode:service worker is recreated with its
		// backend here too — acceptable in this one-shot bootstrap case.
		affected := servicesUsingEnvFiles(composePath, changed)
		if len(affected) > 0 {
			report("compose_up", "Re-creating backends whose S3 credentials were just issued...")
			if err := composeUpServices(ctx, wctx, composePath, affected, false /*removeOrphans*/, true /*noDeps*/, report); err != nil {
				report("compose_up", fmt.Sprintf("credential convergence up failed: %v", err))
			}
		}
	}

	// 5. Zero-downtime gate: never hand a production host to an upstream that
	//    isn't ready. A promote brought the target slot up in step 3; wait for
	//    its healthcheck before the cutover. Steady-state reconciles and DR
	//    restores (target already healthy) pass through instantly.
	waitProductionUpstreamsHealthy(ctx, routes, report)

	// 5a. Configure ingress: converge the daemon's gitops-managed routes to the
	//    desired set. The applier owns the Ingress (k8s-style), so this is the
	//    single ingress side effect of an apply — gitops no longer registers
	//    routes. For a promote this is the atomic cutover to the new live slot.
	//    Fail loudly: a route the deploy implies but the ingress lacks means the
	//    endpoint 404s, which must surface, not be swallowed.
	report("ingress", "Reconciling ingress routes...")
	if err := reconcileIngress(ctx, wctx.WorkspaceName, wctx.BP, routes); err != nil {
		return err
	}

	// 5b. Retire orphans (a promote's old live slot, a removed deployment) AFTER
	//     the ingress flip, so nothing routes to a container we remove. Targeted
	//     removal scoped to the app project — not a `compose up --remove-orphans`,
	//     which would re-evaluate and spuriously recreate the egress workers.
	retireOrphanedContainers(ctx, wctx, composePath, postInfos, report)
	return nil
}

// waitProductionUpstreamsHealthy blocks until every production-stage route's
// upstream container reports healthy (those that declare a healthcheck). It is
// the zero-downtime gate: the production/DR hosts are only flipped to slots that
// are actually ready. Best-effort per upstream — a missing/healthcheck-less
// container is skipped, not fatal; a genuine timeout is reported.
func waitProductionUpstreamsHealthy(ctx context.Context, routes []infradriver.Route, report func(step, msg string)) {
	seen := map[string]bool{}
	for _, r := range routes {
		if r.Stage != "production" {
			continue
		}
		c := r.Upstream
		if i := strings.IndexByte(c, ':'); i > 0 {
			c = c[:i]
		}
		if c == "" || seen[c] {
			continue
		}
		seen[c] = true
		// already healthy → no wait; "none"/"unknown" (no healthcheck declared,
		// or container absent) can't be gated, so don't block on them either.
		switch containerHealth(ctx, c) {
		case "healthy", "none", "unknown":
			continue
		}
		if err := waitForHealthy(ctx, c, 120*time.Second); err != nil {
			report("ingress", fmt.Sprintf("production upstream %s not healthy before cutover: %v", c, err))
		}
	}
}

// retireOrphanedContainers removes running containers in the app compose project
// whose service is no longer in the desired compose (e.g. the old live slot a
// promote replaced). Done after the ingress cutover so a removed container is
// never one a route still points at. Scoped to wctx.WorkspaceName's project, so
// it never touches the site/dashboard/driver containers.
func retireOrphanedContainers(ctx context.Context, wctx infradriver.WorkspaceContext, composePath string, infos []containerInfo, report func(step, msg string)) {
	desired := composeServiceNames(composePath)
	if desired == nil {
		return // couldn't parse the compose — don't remove anything
	}
	for _, c := range infos {
		if c.labels["com.docker.compose.project"] != wctx.WorkspaceName {
			continue // only the app deployment project, never site/dashboard
		}
		// Per-BP apply: only ever retire THIS BP's own containers. App services
		// carry gitops.context=<bp>; egress gw/proxy carry gitops.bp=<bp>. A
		// container with neither label matching (a sibling BP, or an unlabelled
		// infra singleton) is off-limits — a one-BP deploy must never reap another
		// BP's or the shared infra's containers.
		if wctx.BP != "" {
			if c.labels["gitops.context"] != wctx.BP && c.labels["gitops.bp"] != wctx.BP {
				continue
			}
		}
		svc := c.labels["com.docker.compose.service"]
		if svc == "" || desired[svc] {
			continue
		}
		if out, err := exec.CommandContext(ctx, "docker", "rm", "-f", c.id).CombinedOutput(); err != nil {
			report("provision", fmt.Sprintf("retire orphan %s failed: %v: %s", svc, err, strings.TrimSpace(string(out))))
		} else {
			report("provision", fmt.Sprintf("retired orphaned container %s", svc))
		}
	}
}

// composeServiceNames returns the set of service names in a compose file, or nil
// if it can't be read/parsed (caller then skips orphan retirement).
func composeServiceNames(composePath string) map[string]bool {
	raw, err := os.ReadFile(composePath)
	if err != nil {
		return nil
	}
	var doc struct {
		Services map[string]interface{} `yaml:"services"`
	}
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return nil
	}
	set := make(map[string]bool, len(doc.Services))
	for name := range doc.Services {
		set[name] = true
	}
	return set
}

// servicesUsingEnvFiles returns the (sorted) compose service names whose
// env_file list references any of the given paths — the recreate set for the
// credential-convergence up after placeholder creds gain real values.
func servicesUsingEnvFiles(composePath string, paths []string) []string {
	raw, err := os.ReadFile(composePath)
	if err != nil {
		return nil
	}
	var doc struct {
		Services map[string]struct {
			EnvFile []string `yaml:"env_file"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return nil
	}
	wanted := make(map[string]bool, len(paths))
	for _, p := range paths {
		wanted[p] = true
	}
	var out []string
	for name, svc := range doc.Services {
		for _, ef := range svc.EnvFile {
			if wanted[ef] {
				out = append(out, name)
				break
			}
		}
	}
	sort.Strings(out)
	return out
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
	composeErrLine := ""
	for scanner.Scan() {
		line := scanner.Text()
		if composeErrLine == "" && docker.AddressPoolsExhausted(line) {
			composeErrLine = line
		}
		report("compose_up", line)
	}
	if err := cmd.Wait(); err != nil {
		if composeErrLine != "" {
			return docker.NewAddressPoolsExhaustedError("docker compose up", composeErrLine, err)
		}
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
	// A single `docker ps --format` (no per-container `docker inspect`) — this
	// helper backs the pre-snapshot, cert scoping, orphan retirement AND live-DB
	// provisioning, so it runs several times per apply. `docker inspect <all
	// ids>` costs ~0.3s/container on a busy shared daemon (tens of seconds each
	// call); id/state/labels all come straight from `docker ps`.
	out, err := exec.CommandContext(ctx, "docker", "ps", "--all", "--no-trunc",
		"--format", psFormat,
		"--filter", "label=gitops.workspace="+wctx.WorkspaceName).Output()
	if err != nil {
		return nil, fmt.Errorf("docker ps: %w", err)
	}
	listed, err := parsePS(out)
	if err != nil {
		return nil, err
	}
	infos := make([]containerInfo, 0, len(listed))
	for _, c := range listed {
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
func installCertificatesInContainers(ctx context.Context, wctx infradriver.WorkspaceContext, infos []containerInfo, preExistingIDs map[string]bool, report func(step, msg string)) error {
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
