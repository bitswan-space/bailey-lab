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

// bpPostgresConnLimit is the per-BP-role Postgres CONNECTION LIMIT. It bounds
// how many connections any single BP backend can hold, server-side, so a
// runaway or misconfigured backend pool cannot exhaust the shared postgres
// server and starve other BPs. Headroom above the example backend's pool
// (SetMaxOpenConns(5)) to allow a couple of replicas; the superuser bypasses it.
const bpPostgresConnLimit = 10

// bpPostgresROConnLimit caps the SELECT-only ro_<db> explorer role. The role
// serves the workspace-dashboard's read-only SQL explorer (one short-lived
// in-container psql per request), so a handful of slots is plenty and a stuck
// explorer can never crowd out the backend's own connections.
const bpPostgresROConnLimit = 3

// Port of gitops bp_databases.py's deploy-time provisioning, run after
// compose-up (gitops's _provision_bp_databases). gitops loses docker.sock, so
// the per-BP Postgres DBs / Garage buckets the backends need are created here, by
// the driver, via `docker exec` into the running service containers.
//
// Two layers, matching the Python:
//   - ensureLivePostgresDBs: FAIL-FAST guard for the live Postgres DB each
//     backend connects to (per-copy clone / per-BP / blue-green). Raises so a
//     deploy reports a clear error instead of crash-looping on a missing DB.
//   - provisionForDeployments: best-effort namespaces (Garage bucket + the
//     standby blue-green DB); never fails a deploy.
//
// _post_deploy_infra_services is intentionally NOT ported: no concrete infra
// service implements initialize(), so it is a no-op.

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
// Package var (like dockerExec) so provisioner tests can stub it.
var containerRunning = func(ctx context.Context, name string) bool {
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

	// Fast path: already healthy (the common warm-service case) → skip the
	// `docker events` subscription entirely. Forking + connecting a `docker
	// events` stream is real overhead on a busy daemon, and provisioning waits
	// on already-running Postgres/Garage several times per deploy. If NOT yet
	// healthy we fall through to the race-safe subscribe-first-then-inspect path
	// below (an event could fire between this check and the subscription).
	if containerHealth(ctx, container) == "healthy" {
		return nil
	}

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
				// `docker events` exited before we saw a healthy event (a daemon
				// hiccup, or the container being recreated mid-wait closes the
				// stream bound to the old instance). Don't fail on a single
				// re-check — fall back to polling the container's health until the
				// same deadline, so a container that becomes healthy moments later
				// still passes.
				tick := time.NewTicker(500 * time.Millisecond)
				defer tick.Stop()
				for {
					switch containerHealth(context.Background(), container) {
					case "healthy":
						return nil
					case "none":
						return fmt.Errorf("container %s declares no healthcheck — cannot wait on a readiness event", container)
					}
					select {
					case <-ctx.Done():
						return fmt.Errorf("container %s not healthy within %s: %w", container, timeout, ctx.Err())
					case <-tick.C:
					}
				}
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
	// CONNECTION LIMIT is a server-side cap: a BP backend's pool cannot exceed
	// this many connections no matter what its (arbitrary, user-controlled) code
	// requests, so one misbehaving backend can never exhaust the shared
	// postgres server's connection slots and starve every other BP. The
	// superuser bypasses this, so admin/provisioning is unaffected. Applied to
	// existing roles too (the ALTER branch), so a redeploy caps legacy roles.
	createOrAlter := fmt.Sprintf(
		"DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '%s') THEN CREATE ROLE %q LOGIN CONNECTION LIMIT %d PASSWORD '%s'; ELSE ALTER ROLE %q WITH LOGIN CONNECTION LIMIT %d PASSWORD '%s'; END IF; END $$;",
		role, role, bpPostgresConnLimit, pass, role, bpPostgresConnLimit, pass)
	if _, stderr, rc := dockerExec(ctx, container, "psql", "-U", adminUser, "-d", "postgres", "-c", createOrAlter); rc != 0 {
		return fmt.Errorf("ensure role %s: %s", role, strings.TrimSpace(stderr))
	}
	// Full use of the public schema + its existing objects, and default privileges
	// for objects admin creates later. Connected to the BP's own database.
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
	// Make the role OWN its tables/sequences/views. Backends run arbitrary
	// migrations (ALTER TABLE, CREATE INDEX, DROP CONSTRAINT), and Postgres
	// requires *ownership* — not mere privileges — for DDL, so GRANT ALL alone
	// makes any migration fail with "must be owner of table …". Existing objects
	// may be owned by admin (legacy databases created before scoped roles) or by
	// a different role (a live-dev DB cloned WITH TEMPLATE inherits the source
	// role's ownership), so reassign every public-schema object to this role.
	// The database and schema stay admin-owned, so the role still cannot drop
	// them. Idempotent (objects the backend itself created are already owned by
	// the role); runs each deploy so it also repairs pre-existing databases.
	reassign := fmt.Sprintf(
		"DO $$ DECLARE r record; BEGIN "+
			"FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP "+
			"EXECUTE format('ALTER TABLE public.%%I OWNER TO %q', r.tablename); END LOOP; "+
			"FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' LOOP "+
			"EXECUTE format('ALTER SEQUENCE public.%%I OWNER TO %q', r.sequencename); END LOOP; "+
			"FOR r IN SELECT table_name FROM information_schema.views WHERE table_schema='public' LOOP "+
			"EXECUTE format('ALTER VIEW public.%%I OWNER TO %q', r.table_name); END LOOP; "+
			"END $$;",
		role, role, role)
	if _, stderr, rc := dockerExec(ctx, container, "psql", "-U", adminUser, "-d", dbName, "-c", reassign); rc != 0 {
		return fmt.Errorf("reassign ownership in %s to %s: %s", dbName, role, strings.TrimSpace(stderr))
	}
	// Lock CONNECT to this role so no other BP role can reach this database.
	lock := fmt.Sprintf("REVOKE CONNECT ON DATABASE %q FROM PUBLIC; GRANT CONNECT ON DATABASE %q TO %q;", dbName, dbName, role)
	if _, stderr, rc := dockerExec(ctx, container, "psql", "-U", adminUser, "-d", "postgres", "-c", lock); rc != 0 {
		return fmt.Errorf("lock connect on %s: %s", dbName, strings.TrimSpace(stderr))
	}
	// Read-only explorer role: SELECT-only twin of the backend role, used by the
	// workspace-dashboard's data explorer via in-container psql. Passwordless on
	// purpose (local-socket trust auth only; PASSWORD NULL also strips anything a
	// previous version may have set), so it cannot be used over TCP at all.
	// gitops mirrors this name derivation in app/services/data_explorer.py.
	ro := scopedROPGRole(dbName)
	ensureRO := fmt.Sprintf(
		"DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '%s') THEN CREATE ROLE %q LOGIN CONNECTION LIMIT %d; ELSE ALTER ROLE %q WITH LOGIN CONNECTION LIMIT %d PASSWORD NULL; END IF; END $$; GRANT CONNECT ON DATABASE %q TO %q;",
		ro, ro, bpPostgresROConnLimit, ro, bpPostgresROConnLimit, dbName, ro)
	if _, stderr, rc := dockerExec(ctx, container, "psql", "-U", adminUser, "-d", "postgres", "-c", ensureRO); rc != 0 {
		return fmt.Errorf("ensure ro role %s: %s", ro, strings.TrimSpace(stderr))
	}
	// SELECT on everything in public, now and in the future. Future objects are
	// covered via u_<db>'s default privileges — the ownership reassignment above
	// guarantees every table the backend migrates/creates is owned by u_<db>.
	roGrants := strings.Join([]string{
		fmt.Sprintf("GRANT USAGE ON SCHEMA public TO %q;", ro),
		fmt.Sprintf("GRANT SELECT ON ALL TABLES IN SCHEMA public TO %q;", ro),
		fmt.Sprintf("ALTER DEFAULT PRIVILEGES FOR ROLE %q IN SCHEMA public GRANT SELECT ON TABLES TO %q;", role, ro),
	}, " ")
	if _, stderr, rc := dockerExec(ctx, container, "psql", "-U", adminUser, "-d", dbName, "-c", roGrants); rc != 0 {
		return fmt.Errorf("grant read-only on %s to %s: %s", dbName, ro, strings.TrimSpace(stderr))
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
func freshDeploymentIDs(preExistingIDs map[string]bool, infos []containerInfo) map[string]bool {
	if len(preExistingIDs) == 0 {
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

func ensureLivePostgresDBs(ctx context.Context, wctx infradriver.WorkspaceContext, bs *Bitswan, preExistingIDs map[string]bool, infos []containerInfo, report func(step, msg string)) error {
	// Match a deployment to its container by the gitops.deployment_id label; a
	// container whose id wasn't present before this apply is fresh. fresh==nil
	// means we couldn't scope (no pre-snapshot, or the container list failed) →
	// process every deployment, the old whole-workspace behavior (safe).
	fresh := freshDeploymentIDs(preExistingIDs, infos)
	dbsByRealm := map[string]map[string]bool{}
	databaseAlreadyExists := func(realm, container, user, dbName string) bool {
		set, listed := dbsByRealm[realm]
		if !listed {
			set, _ = listPostgresDBs(ctx, container, user)
			dbsByRealm[realm] = set
		}
		return set[dbName]
	}

	reg := loadRegistry(wctx.SecretsDir)
	seen := map[string]bool{}
	for _, depID := range sortedDepIDs(bs.Deployments) {
		conf := bs.Deployments[depID]
		if conf == nil {
			continue
		}
		unchangedSinceLastApply := fresh != nil && !fresh[depID]
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
			if unchangedSinceLastApply && databaseAlreadyExists(realm, container, user, target) {
				continue
			}
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
			if unchangedSinceLastApply && databaseAlreadyExists(realm, container, user, dbName) {
				continue
			}
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

// wantedBPResources collects the DESIRED per-BP resource names grouped by
// realm — the single source of truth shared by the post-up provisioner and
// the pre-compile Garage key minting (ensureGarageKeysPrecompile), so "which
// buckets should exist" can never diverge between the two.
func wantedBPResources(wctx infradriver.WorkspaceContext, bs *Bitswan) (pgWant, s3Want map[string]map[string]bool) {
	reg := loadRegistry(wctx.SecretsDir)
	seen := map[string]bool{}
	pgWant = map[string]map[string]bool{} // realm -> set(db name)
	s3Want = map[string]map[string]bool{} // realm -> set(bucket name)
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

		// A non-main copy's live-dev backend gets its own per-(copy, BP) bucket
		// (its Postgres DB is created fail-fast in ensureLivePostgresDBs).
		// Unconditional — every BP in the copy is isolated.
		if conf.StageOrProduction() == "live-dev" && copyName != "" {
			bucket := copyBPResourceNames(copyName, bpSlug)["s3_bucket"]
			if seen["copybucket:"+bucket] {
				continue
			}
			seen["copybucket:"+bucket] = true
			if s3Want[realm] == nil {
				s3Want[realm] = map[string]bool{}
			}
			s3Want[realm][bucket] = true
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
			if s3Want[realm] == nil {
				s3Want[realm] = map[string]bool{}
			}
			s3Want[realm][names["s3_bucket"]] = true
		}
	}
	return pgWant, s3Want
}

// ensureGarageKeysPrecompile mints Garage access keys BEFORE compile for every
// wanted bucket whose creds file is absent/placeholder — or names a key Garage
// no longer has — so the compiler bakes real values into the backend env_files.
// Only possible when the realm's garage container is already RUNNING (i.e.
// every apply after the first) — on a first-ever apply the compiler writes
// placeholders and the post-up provisioner mints + converges instead.
// Best-effort: never fails the apply.
func ensureGarageKeysPrecompile(ctx context.Context, wctx infradriver.WorkspaceContext, bs *Bitswan, report func(step, msg string)) {
	_, s3Want := wantedBPResources(wctx, bs)
	for realm, want := range s3Want {
		if serviceSecrets(wctx.SecretsDir, "garage", realm) == nil {
			continue // service not enabled at this realm
		}
		container := serviceContainerName(wctx.WorkspaceName, "garage", realm)
		if !containerRunning(ctx, container) {
			continue
		}
		// A creds file can name a key Garage doesn't have: restoring a
		// workspace's secrets onto a rebuilt Garage (its metadata volume holds
		// buckets AND keys) leaves every BP key dangling. Validate against
		// ListKeys, exactly as the _system key does, so recovery self-heals
		// instead of leaving backends permanently AccessDenied.
		keys, _ := garageListKeys(ctx, container)
		// Bucket ids for the grant below. reconcileGarageBuckets skips a bucket
		// it considers fully provisioned (bucket + key both exist server-side),
		// so a key minted HERE must be granted HERE too — otherwise the skip
		// fires on a brand-new key that owns nothing and the backend is
		// AccessDenied forever.
		buckets, _ := garageListBuckets(ctx, container)
		for _, bucket := range sortedKeys(want) {
			if ak, _ := readBucketCreds(wctx.SecretsDir, realm, bucket); ak != "" && keys[ak] {
				continue
			}
			ak, sk, err := garageCreateKey(ctx, container, "bp-"+bucket)
			if err != nil {
				report("provision", fmt.Sprintf("mint garage key for %s deferred: %v", bucket, err))
				continue
			}
			if err := writeBucketCreds(wctx.SecretsDir, realm, bucket, ak, sk); err != nil {
				report("provision", fmt.Sprintf("persist garage key for %s failed: %v", bucket, err))
				continue
			}
			// Grants are idempotent. A bucket that doesn't exist yet is left to
			// reconcile, which creates AND grants it (its skip can't fire while
			// the bucket is missing).
			if bucketID := buckets[bucket]; bucketID != "" {
				if err := garageAllowBucketKey(ctx, container, bucketID, ak); err != nil {
					report("provision", fmt.Sprintf("grant %s on %s deferred: %v", ak, bucket, err))
				}
			}
		}
	}
}

// provisionForDeployments creates the best-effort per-BP namespaces (Garage
// bucket+key grants + standby blue-green Postgres DB) for registered BP×realm
// touched by the deployments. Never fails the deploy — errors are reported
// and skipped. Returns the creds-file paths whose key material was minted
// HERE (i.e. backends compiled against a placeholder), so reconcile can
// re-up exactly those services with their real credentials.
func provisionForDeployments(ctx context.Context, wctx infradriver.WorkspaceContext, bs *Bitswan, report func(step, msg string)) []string {
	pgWant, s3Want := wantedBPResources(wctx, bs)

	// One reconcile unit per (realm, service) — a handful at most. Each issues a
	// single list query that BOTH confirms the service is up and reveals what
	// already exists, then creates only the missing names. A normal redeploy
	// (everything already there) lists once per service and creates nothing.
	var wg sync.WaitGroup
	var mu sync.Mutex
	var changedCreds []string
	for realm, want := range pgWant {
		wg.Add(1)
		go func(realm string, want map[string]bool) {
			defer wg.Done()
			reconcilePostgresDBs(ctx, wctx, realm, want, report)
		}(realm, want)
	}
	for realm, want := range s3Want {
		wg.Add(1)
		go func(realm string, want map[string]bool) {
			defer wg.Done()
			changed := reconcileGarageBuckets(ctx, wctx, realm, want, report)
			mu.Lock()
			changedCreds = append(changedCreds, changed...)
			mu.Unlock()
		}(realm, want)
	}
	wg.Wait()
	return changedCreds
}

// sortedKeys returns a set's keys in stable order (deterministic exec order
// makes provisioning logs and tests reproducible).
func sortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
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
		if existing[db] {
			// Already provisioned by an earlier apply — its role/grants/ownership
			// are in place. Re-running ensureBPRole (several psql execs) for EVERY
			// database on EVERY apply was the dominant deploy cost (tens of seconds
			// on a large workspace). Skip it for existing DBs; the LIVE DB's role is
			// re-ensured fail-fast in ensureLivePostgresDBs whenever its backend is
			// (re)created, so ownership repairs still reach live DBs.
			continue
		}
		if _, stderr, rc := dockerExec(ctx, container, "psql", "-U", user, "-d", "postgres", "-c",
			fmt.Sprintf("CREATE DATABASE %q;", db)); rc != 0 && !strings.Contains(stderr, "already exists") {
			report("provision", fmt.Sprintf("create database %s deferred: %s", db, strings.TrimSpace(stderr)))
			continue
		}
		// Scope the per-DB login role for the just-created database (covers standby
		// blue-green slots created on a promote).
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

// reconcileGarageBuckets ensures every desired bucket exists in the realm's
// garage with grants for both its scoped key and the realm's _system key:
// ONE ListBuckets lists what's there (and proves the node answers — same
// cold-path-only health wait as postgres), then it creates only the missing
// pieces. Returns the creds-file paths it minted key material into (backends
// compiled against a placeholder → reconcile re-ups them).
func reconcileGarageBuckets(ctx context.Context, wctx infradriver.WorkspaceContext, realm string, want map[string]bool, report func(step, msg string)) []string {
	if serviceSecrets(wctx.SecretsDir, "garage", realm) == nil {
		return nil
	}
	container := serviceContainerName(wctx.WorkspaceName, "garage", realm)
	if !containerRunning(ctx, container) {
		return nil
	}
	existing, err := garageListBuckets(ctx, container)
	if err != nil {
		if werr := waitForHealthy(ctx, container, 60*time.Second); werr != nil {
			report("provision", fmt.Sprintf("garage %s not ready: %v", realm, werr))
			return nil
		}
		if existing, err = garageListBuckets(ctx, container); err != nil {
			report("provision", fmt.Sprintf("garage %s list buckets deferred: %v", realm, err))
			return nil
		}
	}
	// One ListKeys (cheap) so a bucket is skipped only when FULLY provisioned
	// (bucket AND its scoped key exist server-side). Bucket-existence alone
	// would leave a backend permanently unauthorized after a transient failure
	// between bucket creation and key grant — the grants are idempotent, so
	// re-running to heal is safe.
	keys, _ := garageListKeys(ctx, container)

	// The realm's _system key (backups/snapshots/explorer fallback) is granted
	// on every bucket. When it was just minted, no existing bucket can be
	// skipped — each needs the new key's grant.
	sysAK, _ := readBucketCreds(wctx.SecretsDir, realm, systemKeyName)
	sysFresh := false
	if sysAK == "" || !keys[sysAK] {
		ak, sk, err := garageCreateKey(ctx, container, systemKeyName)
		if err != nil {
			report("provision", fmt.Sprintf("mint garage _system key (%s) deferred: %v", realm, err))
		} else if err := writeBucketCreds(wctx.SecretsDir, realm, systemKeyName, ak, sk); err != nil {
			report("provision", fmt.Sprintf("persist garage _system key (%s) failed: %v", realm, err))
		} else {
			sysAK = ak
			sysFresh = true
		}
	}

	var changed []string
	for _, b := range sortedKeys(want) {
		bpAK, _ := readBucketCreds(wctx.SecretsDir, realm, b)
		if existing[b] != "" && bpAK != "" && keys[bpAK] && !sysFresh {
			// Fully provisioned by an earlier apply — skip the execs (a dominant
			// deploy cost when re-run every time).
			continue
		}
		if bpAK == "" || !keys[bpAK] {
			// Backend was compiled against a placeholder (first-ever apply), or
			// against a key Garage no longer has (a restored secrets tree on a
			// rebuilt Garage — its metadata volume carries buckets AND keys).
			// Either way the key cannot be granted, so mint a fresh one and
			// record it for the convergence re-up; otherwise the grant below
			// fails with "No such key" and the backend stays AccessDenied
			// forever.
			ak, sk, err := garageCreateKey(ctx, container, "bp-"+b)
			if err != nil {
				report("provision", fmt.Sprintf("mint garage key for %s deferred: %v", b, err))
				continue
			}
			if err := writeBucketCreds(wctx.SecretsDir, realm, b, ak, sk); err != nil {
				report("provision", fmt.Sprintf("persist garage key for %s failed: %v", b, err))
				continue
			}
			bpAK = ak
			changed = append(changed, bucketCredsPath(wctx.SecretsDir, realm, b))
		}
		bucketID := existing[b]
		if bucketID == "" {
			id, err := garageCreateBucket(ctx, container, b)
			if err != nil {
				report("provision", fmt.Sprintf("create bucket %s deferred: %v", b, err))
				continue
			}
			bucketID = id
		}
		if err := garageAllowBucketKey(ctx, container, bucketID, bpAK); err != nil {
			report("provision", fmt.Sprintf("grant %s on %s deferred: %v", bpAK, b, err))
		}
		if sysAK != "" {
			if err := garageAllowBucketKey(ctx, container, bucketID, sysAK); err != nil {
				report("provision", fmt.Sprintf("grant _system on %s deferred: %v", b, err))
			}
		}
	}
	return changed
}
