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

// waitForPostgres blocks until a freshly-started Postgres accepts connections
// (pg_isready), so a cold-start deploy's first CREATE DATABASE doesn't race
// initdb. Port of bp_databases._wait_for_postgres.
func waitForPostgres(ctx context.Context, container, user string) error {
	deadline := time.Now().Add(60 * time.Second)
	var last string
	for {
		_, stderr, rc := dockerExec(ctx, container, "pg_isready", "-U", user, "-q")
		if rc == 0 {
			return nil
		}
		last = strings.TrimSpace(stderr)
		if time.Now().After(deadline) {
			return fmt.Errorf("postgres in %s not ready after 60s: %s", container, last)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
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

// createMinioBucket sets the mc alias (retried — the server may have just come
// up) then `mc mb --ignore-existing`. Port of bp_databases._create_minio_bucket.
func createMinioBucket(ctx context.Context, container, accessKey, secretKey, bucket string) error {
	deadline := time.Now().Add(60 * time.Second)
	var stderr string
	for {
		_, e, rc := dockerExec(ctx, container, "mc", "alias", "set", "local", "http://localhost:9000", accessKey, secretKey)
		if rc == 0 {
			break
		}
		stderr = strings.TrimSpace(e)
		if time.Now().After(deadline) {
			return fmt.Errorf("mc alias set failed: %s", stderr)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	_, e, rc := dockerExec(ctx, container, "mc", "mb", "--ignore-existing", "local/"+bucket)
	if rc != 0 {
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
			names := bpResourceNames(bpSlug, db)
			if err := provisionBPObjects(ctx, wctx, realm, names); err != nil {
				report("provision", fmt.Sprintf("per-BP provisioning for %s (db%d) at %s deferred: %v", bpSlug, db, realm, err))
			}
		}
	}
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
