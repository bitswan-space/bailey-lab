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

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

// Port of gitops bp_databases.py's deploy-time provisioning, run after
// compose-up (gitops's _provision_bp_databases). gitops loses docker.sock, so
// the per-BP Postgres DBs / MinIO buckets the backends need are created here, by
// the driver, via `docker exec` into the running service containers.
//
// Two layers, matching the Python:
//   - ensureLivePostgresDBs: FAIL-FAST guard for the live Postgres DB each
//     backend connects to (per-copy clone / per-BP / blue-green). Raises so a
//     deploy reports a clear error instead of crash-looping on a missing DB.
//   - provisionForDeployments: best-effort namespaces (MinIO bucket + the
//     standby blue-green DB); never fails a deploy.
//
// _post_deploy_infra_services is intentionally NOT ported: no concrete infra
// service implements initialize(), so it is a no-op.

var bpDataServices = [...]string{"postgres", "couchdb", "minio"}

// dockerExec runs `docker exec <container> <args...>` and returns stdout,
// stderr, and the process exit code (rc). rc is -1 if the command could not be
// started.
func dockerExec(ctx context.Context, container string, args ...string) (string, string, int) {
	full := append([]string{"exec", container}, args...)
	cmd := exec.CommandContext(ctx, "docker", full...)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	rc := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			rc = ee.ExitCode()
		} else {
			rc = -1
		}
	}
	return stdout.String(), stderr.String(), rc
}

// containerRunning reports whether a container exists and is running.
func containerRunning(ctx context.Context, name string) bool {
	out, err := exec.CommandContext(ctx, "docker", "inspect", "-f", "{{.State.Running}}", name).Output()
	return err == nil && strings.TrimSpace(string(out)) == "true"
}

// serviceContainerName mirrors bp_databases._container_name /
// infra.containerName: <workspace>__<service>[-<realm>] (production has no suffix).
func serviceContainerName(workspace, serviceType, realm string) string {
	suffix := ""
	if realm != "production" {
		suffix = "-" + realm
	}
	return workspace + "__" + serviceType + suffix
}

// serviceSecrets reads a service's KEY=VALUE env file from the secrets dir, or
// nil when the file is absent (service not enabled at that realm). Port of
// bp_databases.get_service_secrets.
func serviceSecrets(secretsDir, serviceType, realm string) map[string]string {
	suffix := ""
	if realm != "production" {
		suffix = "-" + realm
	}
	path := filepath.Join(secretsDir, serviceType+suffix)
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	info := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		k, v, _ := strings.Cut(line, "=")
		info[k] = v
	}
	if len(info) == 0 {
		return nil
	}
	return info
}

// waitForHealthy blocks until the container reports a healthy healthcheck,
// consuming Docker's health-status EVENT stream — never a poll loop or a sleep.
// It subscribes to `docker events` first, then does ONE inspect to catch a
// container that was already healthy (the event can fire before we subscribe);
// thereafter it blocks on the stream. Fails loudly on timeout, and on a
// container that declares no healthcheck (a misconfig we must not silently wait
// out — the infra services now all declare one, see infra.go).
func waitForHealthy(ctx context.Context, container string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	ev := exec.CommandContext(ctx, "docker", "events",
		"--filter", "type=container",
		"--filter", "container="+container,
		"--filter", "event=health_status",
		"--format", "{{.Status}}")
	stdout, err := ev.StdoutPipe()
	if err != nil {
		return fmt.Errorf("docker events pipe for %s: %w", container, err)
	}
	if err := ev.Start(); err != nil {
		return fmt.Errorf("docker events for %s: %w", container, err)
	}
	defer func() { _ = ev.Process.Kill(); _ = ev.Wait() }()

	switch containerHealth(ctx, container) {
	case "healthy":
		return nil
	case "none":
		return fmt.Errorf("container %s declares no healthcheck — cannot wait on a readiness event", container)
	}

	lines := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			lines <- strings.TrimSpace(sc.Text())
		}
		close(lines)
	}()
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("container %s not healthy within %s: %w", container, timeout, ctx.Err())
		case line, ok := <-lines:
			if !ok {
				// Stream ended (cancel / docker exit) — re-check once before failing.
				if containerHealth(context.Background(), container) == "healthy" {
					return nil
				}
				return fmt.Errorf("container %s health-event stream ended before healthy", container)
			}
			// Status is "health_status: healthy" | "health_status: unhealthy".
			if strings.Contains(line, "healthy") && !strings.Contains(line, "unhealthy") {
				return nil
			}
		}
	}
}

// containerHealth returns "healthy" | "starting" | "unhealthy" | "none" (no
// healthcheck declared) | "unknown" (inspect failed).
func containerHealth(ctx context.Context, container string) string {
	out, err := exec.CommandContext(ctx, "docker", "inspect", "-f",
		"{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", container).Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(out))
}

// waitForPostgres blocks until a freshly-started Postgres is healthy (its
// pg_isready healthcheck passes) so a cold-start deploy's first CREATE DATABASE
// doesn't race initdb. Event-driven via waitForHealthy — no poll. The user arg
// is retained for call-site compatibility; readiness is now the container's own
// healthcheck.
func waitForPostgres(ctx context.Context, container, _ string) error {
	return waitForHealthy(ctx, container, 60*time.Second)
}

func postgresDBExists(ctx context.Context, container, user, dbName string) (bool, error) {
	sql := fmt.Sprintf("SELECT 1 FROM pg_database WHERE datname = '%s';", dbName)
	stdout, stderr, rc := dockerExec(ctx, container, "psql", "-U", user, "-d", "postgres", "-t", "-A", "-c", sql)
	if rc != 0 {
		return false, fmt.Errorf("psql existence check failed: %s", strings.TrimSpace(stderr))
	}
	return strings.TrimSpace(stdout) == "1", nil
}

func createPostgresDB(ctx context.Context, container, user, dbName string) error {
	exists, err := postgresDBExists(ctx, container, user, dbName)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	_, stderr, rc := dockerExec(ctx, container, "psql", "-U", user, "-d", "postgres", "-c",
		fmt.Sprintf("CREATE DATABASE %q;", dbName))
	if rc != 0 && !strings.Contains(stderr, "already exists") {
		return fmt.Errorf("CREATE DATABASE %s failed: %s", dbName, strings.TrimSpace(stderr))
	}
	return nil
}

// clonePostgresDB ensures a non-main copy's live-dev DB (postgres_copy_<copy>)
// exists, cloning it from the realm default via CREATE DATABASE ... WITH
// TEMPLATE. Returns "" when Postgres isn't enabled. Port of
// bp_databases.clone_postgres_db.
func clonePostgresDB(ctx context.Context, secretsDir, workspace, copyName, sourceRealm string) (string, error) {
	secrets := serviceSecrets(secretsDir, "postgres", sourceRealm)
	if secrets == nil || secrets["POSTGRES_USER"] == "" {
		return "", nil
	}
	user := secrets["POSTGRES_USER"]
	sourceDB := secrets["POSTGRES_DB"]
	if sourceDB == "" {
		sourceDB = "postgres"
	}
	newDB := copyDBName(copyName)
	container := serviceContainerName(workspace, "postgres", sourceRealm)

	if err := waitForPostgres(ctx, container, user); err != nil {
		return "", err
	}
	exists, err := postgresDBExists(ctx, container, user, newDB)
	if err != nil {
		return "", err
	}
	if exists {
		return newDB, nil
	}
	// WITH TEMPLATE needs no other sessions on the template DB — drop them first
	// (best-effort; the CREATE is authoritative).
	terminate := fmt.Sprintf(
		"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '%s' AND pid <> pg_backend_pid();",
		sourceDB)
	_, _, _ = dockerExec(ctx, container, "psql", "-U", user, "-d", "postgres", "-c", terminate)
	_, stderr, rc := dockerExec(ctx, container, "psql", "-U", user, "-d", "postgres", "-c",
		fmt.Sprintf("CREATE DATABASE %q WITH TEMPLATE %q;", newDB, sourceDB))
	if rc != 0 && !strings.Contains(stderr, "already exists") {
		return "", fmt.Errorf("clone CREATE DATABASE %s failed: %s", newDB, strings.TrimSpace(stderr))
	}
	return newDB, nil
}

// createMinioBucket waits for MinIO to be healthy (its /minio/health/live
// healthcheck — event-driven, no retry loop) then sets the mc alias and creates
// the bucket. Port of bp_databases._create_minio_bucket.
func createMinioBucket(ctx context.Context, container, accessKey, secretKey, bucket string) error {
	if err := waitForHealthy(ctx, container, 60*time.Second); err != nil {
		return err
	}
	if _, e, rc := dockerExec(ctx, container, "mc", "alias", "set", "local", "http://localhost:9000", accessKey, secretKey); rc != 0 {
		return fmt.Errorf("mc alias set failed: %s", strings.TrimSpace(e))
	}
	if _, e, rc := dockerExec(ctx, container, "mc", "mb", "--ignore-existing", "local/"+bucket); rc != 0 {
		return fmt.Errorf("mc mb %s failed: %s", bucket, strings.TrimSpace(e))
	}
	return nil
}

// productionDBNumbers is the blue-green db numbers a production BP's slots use
// (default [1,2]). Port of bp_databases._production_db_numbers.
func productionDBNumbers(bs *Bitswan, bpSlug string) []int {
	var slots map[string]*SlotRec
	if bs.Backups != nil {
		if rec := bs.Backups[bpSlug]; rec != nil && len(rec.Slots) > 0 {
			slots = rec.Slots
		}
	}
	if slots == nil {
		one, two := 1, 2
		slots = map[string]*SlotRec{"a": {DB: &one}, "b": {DB: &two}}
	}
	set := map[int]bool{}
	for _, sr := range slots {
		if sr != nil && sr.DB != nil {
			set[*sr.DB] = true
		}
	}
	nums := make([]int, 0, len(set))
	for n := range set {
		nums = append(nums, n)
	}
	sort.Ints(nums)
	if len(nums) == 0 {
		return []int{1}
	}
	return nums
}

// ensureLivePostgresDBs is the FAIL-FAST guard: it creates the live Postgres DB
// each deploying backend connects to before the backend's connect-retry, and
// raises when Postgres is enabled but the DB can't be created. Port of
// bp_databases.ensure_live_postgres_dbs.
func ensureLivePostgresDBs(ctx context.Context, wctx infradriver.WorkspaceContext, bs *Bitswan, report func(step, msg string)) error {
	reg := loadRegistry(wctx.SecretsDir)
	seen := map[string]bool{}
	for _, depID := range sortedDepIDs(bs.Deployments) {
		conf := bs.Deployments[depID]
		if conf == nil {
			continue
		}
		bpSlug, copyName := deriveBPAndCopy(conf.RelativePath)
		stage := conf.StageOrProduction()
		realm := realmForStage(stage)
		if realm != "dev" && realm != "staging" && realm != "production" {
			continue
		}

		// 1) A non-main copy's live-dev backend connects to the cloned per-copy DB.
		if stage == "live-dev" && copyName != "" {
			if seen["copy:"+copyName] {
				continue
			}
			seen["copy:"+copyName] = true
			if serviceSecrets(wctx.SecretsDir, "postgres", realm) == nil {
				continue // Postgres not enabled — can't create a server
			}
			if _, err := clonePostgresDB(ctx, wctx.SecretsDir, wctx.WorkspaceName, copyName, realm); err != nil {
				return err
			}
			continue
		}

		// 2) A registered BP's per-stage database(s). Unregistered BPs use the
		//    shared default DB — nothing to create.
		if bpSlug == "" || !reg.isRegistered(bpSlug, realm) {
			continue
		}
		secrets := serviceSecrets(wctx.SecretsDir, "postgres", realm)
		if secrets == nil || secrets["POSTGRES_USER"] == "" {
			continue
		}
		user := secrets["POSTGRES_USER"]
		container := serviceContainerName(wctx.WorkspaceName, "postgres", realm)
		dbs := []int{0} // single-backend (Python None)
		if realm == "production" {
			dbs = productionDBNumbers(bs, bpSlug)
		}
		for _, db := range dbs {
			dbName := bpResourceNames(bpSlug, db)["postgres_db"]
			if seen["bp:"+dbName] {
				continue
			}
			seen["bp:"+dbName] = true
			report("provision", "Ensuring Postgres database "+dbName)
			if err := waitForPostgres(ctx, container, user); err != nil {
				return err
			}
			if err := createPostgresDB(ctx, container, user, dbName); err != nil {
				return err
			}
		}
	}
	return nil
}

// provisionForDeployments creates the best-effort per-BP namespaces (MinIO
// bucket + standby blue-green Postgres DB) for registered BP×realm touched by
// the deployments. Never fails the deploy — errors are reported and skipped.
// Port of bp_databases.provision_for_deployments + ensure_bp_databases'
// minio/standby-db creation (the provisioned-flag bookkeeping is dropped: the
// creates are idempotent, so re-attempting per deploy is correct, just not
// optimized).
func provisionForDeployments(ctx context.Context, wctx infradriver.WorkspaceContext, bs *Bitswan, report func(step, msg string)) {
	reg := loadRegistry(wctx.SecretsDir)
	seen := map[string]bool{}

	// Collect the independent per-(BP, realm, db) provisioning jobs, then run
	// them concurrently: each touches a distinct DB name / bucket, the readiness
	// waits overlap instead of stacking, and a slow service no longer blocks the
	// next BP. Best-effort — a failure is reported, never fatal.
	type job struct {
		bpSlug string
		realm  string
		db     int
		names  map[string]string
	}
	var jobs []job
	for _, depID := range sortedDepIDs(bs.Deployments) {
		conf := bs.Deployments[depID]
		if conf == nil {
			continue
		}
		bpSlug, copyName := deriveBPAndCopy(conf.RelativePath)
		if bpSlug == "" || copyName != "" {
			continue
		}
		realm := realmForStage(conf.StageOrProduction())
		if realm != "dev" && realm != "staging" && realm != "production" {
			continue
		}
		key := bpSlug + ":" + realm
		if seen[key] || !reg.isRegistered(bpSlug, realm) {
			continue
		}
		seen[key] = true

		dbs := []int{0}
		if realm == "production" {
			dbs = productionDBNumbers(bs, bpSlug)
		}
		for _, db := range dbs {
			jobs = append(jobs, job{bpSlug, realm, db, bpResourceNames(bpSlug, db)})
		}
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	for _, j := range jobs {
		wg.Add(1)
		go func(j job) {
			defer wg.Done()
			if err := provisionBPObjects(ctx, wctx, j.realm, j.names); err != nil {
				mu.Lock()
				report("provision", fmt.Sprintf("per-BP provisioning for %s (db%d) at %s deferred: %v", j.bpSlug, j.db, j.realm, err))
				mu.Unlock()
			}
		}(j)
	}
	wg.Wait()
}

// provisionBPObjects creates the Postgres DB + MinIO bucket for one (BP, realm,
// db) when those services are enabled and running. couchdb is lazy (automations
// create {prefix}* DBs themselves). Mirrors ensure_bp_databases' per-service body.
func provisionBPObjects(ctx context.Context, wctx infradriver.WorkspaceContext, realm string, names map[string]string) error {
	if secrets := serviceSecrets(wctx.SecretsDir, "postgres", realm); secrets != nil {
		container := serviceContainerName(wctx.WorkspaceName, "postgres", realm)
		if containerRunning(ctx, container) {
			user := secrets["POSTGRES_USER"]
			if user == "" {
				user = "admin"
			}
			if err := waitForPostgres(ctx, container, user); err != nil {
				return err
			}
			if err := createPostgresDB(ctx, container, user, names["postgres_db"]); err != nil {
				return err
			}
		}
	}
	if secrets := serviceSecrets(wctx.SecretsDir, "minio", realm); secrets != nil {
		container := serviceContainerName(wctx.WorkspaceName, "minio", realm)
		if containerRunning(ctx, container) {
			if err := createMinioBucket(ctx, container, secrets["MINIO_ROOT_USER"], secrets["MINIO_ROOT_PASSWORD"], names["minio_bucket"]); err != nil {
				return err
			}
		}
	}
	return nil
}
