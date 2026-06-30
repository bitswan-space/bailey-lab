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
// dockerExec is a package var (not a plain func) so tests can stub it to record
// the psql/mc commands the provisioners issue without a real Docker daemon.
var dockerExec = func(ctx context.Context, container string, args ...string) (string, string, int) {
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

// clonePostgresDBAs creates targetDB as a clone of sourceDB (CREATE DATABASE ...
// WITH TEMPLATE), idempotently (a no-op when targetDB already exists). The
// caller must ensure Postgres is ready and sourceDB exists. Used to give a
// non-main copy's live-dev a per-(copy, BP) database seeded from the BP's dev
// data. Port of bp_databases.clone_postgres_db_as.
func clonePostgresDBAs(ctx context.Context, container, user, targetDB, sourceDB string) error {
	exists, err := postgresDBExists(ctx, container, user, targetDB)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	// WITH TEMPLATE needs no other sessions on the template DB — drop them first
	// (best-effort; the CREATE is authoritative).
	terminate := fmt.Sprintf(
		"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '%s' AND pid <> pg_backend_pid();",
		sourceDB)
	_, _, _ = dockerExec(ctx, container, "psql", "-U", user, "-d", "postgres", "-c", terminate)
	_, stderr, rc := dockerExec(ctx, container, "psql", "-U", user, "-d", "postgres", "-c",
		fmt.Sprintf("CREATE DATABASE %q WITH TEMPLATE %q;", targetDB, sourceDB))
	if rc != 0 && !strings.Contains(stderr, "already exists") {
		return fmt.Errorf("clone CREATE DATABASE %s (template %s) failed: %s", targetDB, sourceDB, strings.TrimSpace(stderr))
	}
	return nil
}

// ensureBPRole creates (or password-syncs) the scoped Postgres LOGIN role a BP
// backend authenticates as, and scopes it to exactly its own database: it gets
// full use of the public schema and its objects but NOT ownership (so it can't
// drop the database/schema), and CONNECT is locked to it (the superuser bypasses
// CONNECT, so admin/provisioning still works). Idempotent. adminUser is the
// shared superuser the driver connects as; the scoped password comes from the
// per-resource cred store (the same value the compiler injected into the env).
func ensureBPRole(ctx context.Context, container, adminUser, secretsDir, realm, dbName string) error {
	role, pass, err := getOrCreateDBCreds(secretsDir, realm, dbName)
	if err != nil {
		return err
	}
	// Create the LOGIN role or sync its password — one idempotent statement.
	createOrAlter := fmt.Sprintf(
		"DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '%s') THEN CREATE ROLE %q LOGIN PASSWORD '%s'; ELSE ALTER ROLE %q WITH LOGIN PASSWORD '%s'; END IF; END $$;",
		role, role, pass, role, pass)
	if _, stderr, rc := dockerExec(ctx, container, "psql", "-U", adminUser, "-d", "postgres", "-c", createOrAlter); rc != 0 {
		return fmt.Errorf("ensure role %s: %s", role, strings.TrimSpace(stderr))
	}
	// Use (not own) the public schema + its existing objects, and stay usable for
	// objects admin creates later. Connected to the BP's own database.
	grants := strings.Join([]string{
		fmt.Sprintf("GRANT ALL ON SCHEMA public TO %q;", role),
		fmt.Sprintf("GRANT ALL ON ALL TABLES IN SCHEMA public TO %q;", role),
		fmt.Sprintf("GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO %q;", role),
		fmt.Sprintf("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO %q;", role),
		fmt.Sprintf("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO %q;", role),
	}, " ")
	if _, stderr, rc := dockerExec(ctx, container, "psql", "-U", adminUser, "-d", dbName, "-c", grants); rc != 0 {
		return fmt.Errorf("grant on %s to %s: %s", dbName, role, strings.TrimSpace(stderr))
	}
	// Lock CONNECT to this role so no other BP role can reach this database.
	lock := fmt.Sprintf("REVOKE CONNECT ON DATABASE %q FROM PUBLIC; GRANT CONNECT ON DATABASE %q TO %q;", dbName, dbName, role)
	if _, stderr, rc := dockerExec(ctx, container, "psql", "-U", adminUser, "-d", "postgres", "-c", lock); rc != 0 {
		return fmt.Errorf("lock connect on %s: %s", dbName, strings.TrimSpace(stderr))
	}
	return nil
}

// ensureBPMinioUser creates (idempotently) the scoped MinIO user a BP backend
// authenticates as, and attaches a policy granting it full access to exactly its
// own bucket (and its objects) — nothing else. rootAK/rootSK are the MinIO root
// the driver administers as; the scoped secret comes from the per-resource cred
// store (the same value the compiler injected).
func ensureBPMinioUser(ctx context.Context, container, rootAK, rootSK, secretsDir, realm, bucket string) error {
	ak, sk, err := getOrCreateBucketCreds(secretsDir, realm, bucket)
	if err != nil {
		return err
	}
	if _, e, rc := dockerExec(ctx, container, "mc", "alias", "set", "local", "http://localhost:9000", rootAK, rootSK); rc != 0 {
		return fmt.Errorf("mc alias set: %s", strings.TrimSpace(e))
	}
	// User add — tolerate already-exists (creds are stable, so no re-sync needed).
	if _, e, rc := dockerExec(ctx, container, "mc", "admin", "user", "add", "local", ak, sk); rc != 0 && !strings.Contains(strings.ToLower(e), "already") {
		return fmt.Errorf("mc admin user add %s: %s", ak, strings.TrimSpace(e))
	}
	// Policy: s3:* on this bucket + its objects only. Write the doc into the
	// container (heredoc, no shell interpolation), then create + attach it.
	policy := fmt.Sprintf(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:*"],"Resource":["arn:aws:s3:::%s","arn:aws:s3:::%s/*"]}]}`, bucket, bucket)
	polPath := "/tmp/" + ak + ".json"
	if _, e, rc := dockerExec(ctx, container, "sh", "-c", fmt.Sprintf("cat > %s <<'POLICYEOF'\n%s\nPOLICYEOF", polPath, policy)); rc != 0 {
		return fmt.Errorf("write minio policy for %s: %s", ak, strings.TrimSpace(e))
	}
	if _, e, rc := dockerExec(ctx, container, "mc", "admin", "policy", "create", "local", ak, polPath); rc != 0 && !strings.Contains(strings.ToLower(e), "already exists") {
		return fmt.Errorf("mc admin policy create %s: %s", ak, strings.TrimSpace(e))
	}
	if _, e, rc := dockerExec(ctx, container, "mc", "admin", "policy", "attach", "local", ak, "--user", ak); rc != 0 {
		le := strings.ToLower(e)
		if !strings.Contains(le, "already") && !strings.Contains(le, "attached") {
			return fmt.Errorf("mc admin policy attach %s: %s", ak, strings.TrimSpace(e))
		}
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
		slots = map[string]*SlotRec{"blue": {DB: &one}, "green": {DB: &two}}
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
// freshDeploymentIDs returns the set of deployment ids whose container was
// (re)created in this apply (its id wasn't in preExistingIDs), keyed by the
// gitops.deployment_id label. Returns nil — meaning "couldn't scope, treat all
// as fresh" — when there's no pre-snapshot or the container list can't be read.
func freshDeploymentIDs(ctx context.Context, wctx infradriver.WorkspaceContext, preExistingIDs map[string]bool) map[string]bool {
	if len(preExistingIDs) == 0 {
		return nil
	}
	infos, err := listWorkspaceContainers(ctx, wctx)
	if err != nil {
		return nil
	}
	fresh := map[string]bool{}
	for _, c := range infos {
		if preExistingIDs[c.id] {
			continue
		}
		if dep := c.labels["gitops.deployment_id"]; dep != "" {
			fresh[dep] = true
		}
	}
	return fresh
}

func ensureLivePostgresDBs(ctx context.Context, wctx infradriver.WorkspaceContext, bs *Bitswan, preExistingIDs map[string]bool, report func(step, msg string)) error {
	// Only the backends THIS apply (re)created can have a not-yet-existing live
	// DB — one that's been running already proved its DB exists. Match a
	// deployment to its container by the gitops.deployment_id label; a container
	// whose id wasn't present before this apply is fresh. fresh==nil means we
	// couldn't scope (no pre-snapshot, or the container list failed) → process
	// every deployment, the old whole-workspace behavior (safe).
	fresh := freshDeploymentIDs(ctx, wctx, preExistingIDs)

	reg := loadRegistry(wctx.SecretsDir)
	seen := map[string]bool{}
	for _, depID := range sortedDepIDs(bs.Deployments) {
		conf := bs.Deployments[depID]
		if conf == nil {
			continue
		}
		if fresh != nil && !fresh[depID] {
			continue // unchanged backend — its live DB already exists
		}
		bpSlug, copyName := deriveBPAndCopy(conf.RelativePath)
		stage := conf.StageOrProduction()
		realm := realmForStage(stage)
		if realm != "dev" && realm != "staging" && realm != "production" {
			continue
		}

		// 1) A non-main copy's live-dev backend gets its OWN per-(copy, BP)
		//    database, seeded from that BP's dev DB (bp_<slug>) if it exists, else
		//    the shared dev default. Per (copy, BP) — isolated from other BPs in
		//    the copy and from other copies.
		if stage == "live-dev" && copyName != "" && bpSlug != "" {
			target := copyBPResourceNames(copyName, bpSlug)["postgres_db"]
			if seen["copybp:"+target] {
				continue
			}
			seen["copybp:"+target] = true
			secrets := serviceSecrets(wctx.SecretsDir, "postgres", realm)
			if secrets == nil || secrets["POSTGRES_USER"] == "" {
				continue // Postgres not enabled — can't create a server
			}
			user := secrets["POSTGRES_USER"]
			container := serviceContainerName(wctx.WorkspaceName, "postgres", realm)
			if err := waitForPostgres(ctx, container, user); err != nil {
				return err
			}
			// Seed from the BP's dev DB if it exists, else the shared dev default.
			source := secrets["POSTGRES_DB"]
			if source == "" {
				source = "postgres"
			}
			devBPDB := bpResourceNames(bpSlug, 0)["postgres_db"]
			if ex, err := postgresDBExists(ctx, container, user, devBPDB); err == nil && ex {
				source = devBPDB
			}
			report("provision", "Cloning live-dev database "+target+" from "+source)
			if err := clonePostgresDBAs(ctx, container, user, target, source); err != nil {
				return err
			}
			// Scope a per-DB login role NOW (fail-fast): the backend was injected
			// scoped creds and can't fall back to the superuser.
			if err := ensureBPRole(ctx, container, user, wctx.SecretsDir, realm, target); err != nil {
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
			// Scope a per-DB login role NOW (fail-fast): the backend was injected
			// scoped creds and can't fall back to the superuser.
			if err := ensureBPRole(ctx, container, user, wctx.SecretsDir, realm, dbName); err != nil {
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

	// Collect the DESIRED resource names grouped by realm, so each shared
	// postgres/minio container is touched ONCE — not once per business process.
	pgWant := map[string]map[string]bool{}    // realm -> set(db name)
	minioWant := map[string]map[string]bool{} // realm -> set(bucket name)
	for _, depID := range sortedDepIDs(bs.Deployments) {
		conf := bs.Deployments[depID]
		if conf == nil {
			continue
		}
		bpSlug, copyName := deriveBPAndCopy(conf.RelativePath)
		if bpSlug == "" {
			continue
		}
		realm := realmForStage(conf.StageOrProduction())
		if realm != "dev" && realm != "staging" && realm != "production" {
			continue
		}

		// A non-main copy's live-dev backend gets its own per-(copy, BP) MinIO
		// bucket (its Postgres DB is created fail-fast in ensureLivePostgresDBs).
		// Unconditional — every BP in the copy is isolated.
		if conf.StageOrProduction() == "live-dev" && copyName != "" {
			bucket := copyBPResourceNames(copyName, bpSlug)["minio_bucket"]
			if seen["copybucket:"+bucket] {
				continue
			}
			seen["copybucket:"+bucket] = true
			if minioWant[realm] == nil {
				minioWant[realm] = map[string]bool{}
			}
			minioWant[realm][bucket] = true
			continue
		}
		if copyName != "" {
			continue // other copy stages have no per-BP namespaces
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
			names := bpResourceNames(bpSlug, db)
			if pgWant[realm] == nil {
				pgWant[realm] = map[string]bool{}
			}
			pgWant[realm][names["postgres_db"]] = true
			if minioWant[realm] == nil {
				minioWant[realm] = map[string]bool{}
			}
			minioWant[realm][names["minio_bucket"]] = true
		}
	}

	// One reconcile unit per (realm, service) — a handful at most. Each issues a
	// single list query that BOTH confirms the service is up and reveals what
	// already exists, then creates only the missing names. A normal redeploy
	// (everything already there) lists once per service and creates nothing.
	var wg sync.WaitGroup
	for realm, want := range pgWant {
		wg.Add(1)
		go func(realm string, want map[string]bool) {
			defer wg.Done()
			reconcilePostgresDBs(ctx, wctx, realm, want, report)
		}(realm, want)
	}
	for realm, want := range minioWant {
		wg.Add(1)
		go func(realm string, want map[string]bool) {
			defer wg.Done()
			reconcileMinioBuckets(ctx, wctx, realm, want, report)
		}(realm, want)
	}
	wg.Wait()
}

// reconcilePostgresDBs ensures every desired database exists in the realm's
// postgres, k8s-style: ONE `SELECT datname` lists what's there (and proves
// postgres is accepting connections — no separate health probe), then it
// creates only the missing ones. The 60s health wait is paid ONLY on the cold
// path (the list failed to connect), never on a normal redeploy.
func reconcilePostgresDBs(ctx context.Context, wctx infradriver.WorkspaceContext, realm string, want map[string]bool, report func(step, msg string)) {
	secrets := serviceSecrets(wctx.SecretsDir, "postgres", realm)
	if secrets == nil || !containerRunning(ctx, serviceContainerName(wctx.WorkspaceName, "postgres", realm)) {
		return
	}
	container := serviceContainerName(wctx.WorkspaceName, "postgres", realm)
	user := secrets["POSTGRES_USER"]
	if user == "" {
		user = "admin"
	}
	existing, err := listPostgresDBs(ctx, container, user)
	if err != nil {
		// Not accepting connections yet (cold start / just recreated): wait once
		// on the health-event stream, then retry. Fail loudly if it never comes.
		if werr := waitForHealthy(ctx, container, 60*time.Second); werr != nil {
			report("provision", fmt.Sprintf("postgres %s not ready: %v", realm, werr))
			return
		}
		if existing, err = listPostgresDBs(ctx, container, user); err != nil {
			report("provision", fmt.Sprintf("postgres %s list databases deferred: %v", realm, err))
			return
		}
	}
	for db := range want {
		if !existing[db] {
			if _, stderr, rc := dockerExec(ctx, container, "psql", "-U", user, "-d", "postgres", "-c",
				fmt.Sprintf("CREATE DATABASE %q;", db)); rc != 0 && !strings.Contains(stderr, "already exists") {
				report("provision", fmt.Sprintf("create database %s deferred: %s", db, strings.TrimSpace(stderr)))
				continue
			}
		}
		// Scope the per-DB login role (covers standby blue-green slots and any
		// pre-existing DB being scoped for the first time); best-effort here, the
		// live DB's role is created fail-fast in ensureLivePostgresDBs.
		if err := ensureBPRole(ctx, container, user, wctx.SecretsDir, realm, db); err != nil {
			report("provision", fmt.Sprintf("scope role for %s deferred: %v", db, err))
		}
	}
}

// listPostgresDBs returns the set of existing database names. A non-zero exit
// means postgres is not accepting connections — surfaced as an error so the
// caller takes the cold-start (wait-then-retry) path.
func listPostgresDBs(ctx context.Context, container, user string) (map[string]bool, error) {
	stdout, stderr, rc := dockerExec(ctx, container, "psql", "-U", user, "-d", "postgres",
		"-t", "-A", "-c", "SELECT datname FROM pg_database")
	if rc != 0 {
		return nil, fmt.Errorf("%s", strings.TrimSpace(stderr))
	}
	set := map[string]bool{}
	for _, line := range strings.Split(stdout, "\n") {
		if n := strings.TrimSpace(line); n != "" {
			set[n] = true
		}
	}
	return set, nil
}

// reconcileMinioBuckets ensures every desired bucket exists in the realm's
// minio: ONE `mc ls` lists what's there (and proves minio answers), then it
// creates only the missing ones. Same cold-path-only health wait as postgres.
func reconcileMinioBuckets(ctx context.Context, wctx infradriver.WorkspaceContext, realm string, want map[string]bool, report func(step, msg string)) {
	secrets := serviceSecrets(wctx.SecretsDir, "minio", realm)
	if secrets == nil || !containerRunning(ctx, serviceContainerName(wctx.WorkspaceName, "minio", realm)) {
		return
	}
	container := serviceContainerName(wctx.WorkspaceName, "minio", realm)
	ak, sk := secrets["MINIO_ROOT_USER"], secrets["MINIO_ROOT_PASSWORD"]
	existing, err := listMinioBuckets(ctx, container, ak, sk)
	if err != nil {
		if werr := waitForHealthy(ctx, container, 60*time.Second); werr != nil {
			report("provision", fmt.Sprintf("minio %s not ready: %v", realm, werr))
			return
		}
		if existing, err = listMinioBuckets(ctx, container, ak, sk); err != nil {
			report("provision", fmt.Sprintf("minio %s list buckets deferred: %v", realm, err))
			return
		}
	}
	for b := range want {
		if !existing[b] {
			if _, e, rc := dockerExec(ctx, container, "mc", "mb", "--ignore-existing", "local/"+b); rc != 0 {
				report("provision", fmt.Sprintf("create bucket %s deferred: %s", b, strings.TrimSpace(e)))
				continue
			}
		}
		// Scope a per-bucket MinIO user+policy so the backend reaches only its own
		// bucket. Best-effort: runs before the production health gate, so a fresh
		// backend that briefly raced it recovers on its next connect.
		if err := ensureBPMinioUser(ctx, container, ak, sk, wctx.SecretsDir, realm, b); err != nil {
			report("provision", fmt.Sprintf("scope minio user for %s deferred: %v", b, err))
		}
	}
}

// listMinioBuckets sets the mc alias (which fails if minio isn't answering) and
// returns the set of existing bucket names.
func listMinioBuckets(ctx context.Context, container, accessKey, secretKey string) (map[string]bool, error) {
	if _, e, rc := dockerExec(ctx, container, "mc", "alias", "set", "local", "http://localhost:9000", accessKey, secretKey); rc != 0 {
		return nil, fmt.Errorf("mc alias set: %s", strings.TrimSpace(e))
	}
	stdout, e, rc := dockerExec(ctx, container, "mc", "ls", "local")
	if rc != 0 {
		return nil, fmt.Errorf("mc ls: %s", strings.TrimSpace(e))
	}
	set := map[string]bool{}
	for _, line := range strings.Split(stdout, "\n") {
		// `mc ls local` rows end with the bucket name (with a trailing slash).
		if f := strings.Fields(strings.TrimSpace(line)); len(f) > 0 {
			set[strings.TrimRight(f[len(f)-1], "/")] = true
		}
	}
	return set, nil
}
