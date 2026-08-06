package backup

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

// Per-stage logical DB dumps, produced through each workspace's infra-driver
// (exec/copy-out) — Go ports of gitops's backup flows (backup_service.py,
// couchdb_service.py, garage_service.py), byte-format-compatible so restore
// tooling is interchangeable.

// Stages every service may be enabled on. A service is enabled on a stage
// iff its secrets env file exists (the same convention the driver's
// infraEnabled uses).
var stages = []string{"dev", "staging", "production"}

func stageSuffix(stage string) string {
	if stage == "production" {
		return ""
	}
	return "-" + stage
}

// workspaceDir is the workspace's tree on the shared volume, as the daemon
// sees it.
func workspaceDir(ws string) string {
	return filepath.Join(config.WorkspacesDir(), ws)
}

// parseEnvFile reads a KEY=VALUE secrets file; nil when the file is missing
// (= service not enabled on that stage).
func parseEnvFile(path string) map[string]string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	info := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		key, value, _ := strings.Cut(line, "=")
		info[key] = value
	}
	if len(info) == 0 {
		return nil
	}
	return info
}

// serviceSecrets is the daemon-side read of workspaces/<ws>/secrets/<svc><suffix>.
func serviceSecrets(ws, service, stage string) map[string]string {
	return parseEnvFile(filepath.Join(workspaceDir(ws), "secrets", service+stageSuffix(stage)))
}

// driverBaseURL resolves a workspace's infra-driver address on the docker
// network; a var so tests can point it at an httptest server.
var driverBaseURL = func(ws string) string {
	return "http://" + ws + "-infra-driver:9090"
}

// driverForWorkspace builds an infra-driver client + context for a
// workspace, authenticated with its persisted (or compose-recovered) token.
// The context paths are the DRIVER's mount paths (it shares gitops's view of
// the volume), not the daemon's.
func driverForWorkspace(ws string) (*infradriver.Client, infradriver.WorkspaceContext, error) {
	token, err := config.GetInfraDriverToken(ws)
	if err != nil {
		return nil, infradriver.WorkspaceContext{}, err
	}
	metadata, err := config.GetWorkspaceMetadata(ws)
	if err != nil {
		return nil, infradriver.WorkspaceContext{}, err
	}
	client := infradriver.NewHTTPClient(driverBaseURL(ws), token)
	wctx := infradriver.WorkspaceContext{
		WorkspaceName: ws,
		Domain:        metadata.Domain,
		GitopsDir:     "/gitops/gitops",
		SecretsDir:    "/gitops/secrets",
	}
	return client, wctx, nil
}

func containerRunning(ctx context.Context, client *infradriver.Client, wctx infradriver.WorkspaceContext, name string) (bool, error) {
	containers, err := client.ContainerList(ctx, wctx, infradriver.ContainerFilter{})
	if err != nil {
		return false, err
	}
	for _, c := range containers {
		if c.Name == name && c.State == "running" {
			return true, nil
		}
	}
	return false, nil
}

// execCollect runs a command and returns stdout, with stderr folded into the
// error on non-zero exit.
func execCollect(ctx context.Context, client *infradriver.Client, wctx infradriver.WorkspaceContext, container string, cmd ...string) ([]byte, error) {
	var stdout, stderr bytes.Buffer
	code, err := client.ContainerExec(ctx, wctx, infradriver.ExecSpec{Container: container, Cmd: cmd}, nil,
		func(isStderr bool, chunk []byte) {
			if isStderr {
				stderr.Write(chunk)
			} else {
				stdout.Write(chunk)
			}
		})
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, fmt.Errorf("%s exit %d: %s", cmd[0], code, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}

// --- Postgres (port of _backup_postgres_stage) ---

// dumpPostgresStage streams `pg_dumpall` into <stagingDir>/postgres.sql.
// Returns ("", nil) with an empty path when the container isn't running
// (skip, not failure).
func dumpPostgresStage(ctx context.Context, client *infradriver.Client, wctx infradriver.WorkspaceContext, ws, stage, stagingDir string) (string, error) {
	container := ws + "__postgres" + stageSuffix(stage)
	running, err := containerRunning(ctx, client, wctx, container)
	if err != nil {
		return "", err
	}
	if !running {
		return "", nil
	}

	user := "admin"
	if secrets := serviceSecrets(ws, "postgres", stage); secrets["POSTGRES_USER"] != "" {
		user = secrets["POSTGRES_USER"]
	}

	if err := os.MkdirAll(stagingDir, 0o700); err != nil {
		return "", err
	}
	// A stable path per (ws, stage) so restic's forget grouping (and dedup)
	// sees one series, not a new singleton per run.
	dumpPath := filepath.Join(stagingDir, "postgres.sql")
	f, err := os.Create(dumpPath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	var stderr bytes.Buffer
	var wrote int64
	var writeErr error
	code, err := client.ContainerExec(ctx, wctx,
		infradriver.ExecSpec{Container: container, Cmd: []string{"pg_dumpall", "-U", user}}, nil,
		func(isStderr bool, chunk []byte) {
			if isStderr {
				stderr.Write(chunk)
				return
			}
			n, err := f.Write(chunk)
			wrote += int64(n)
			if err != nil && writeErr == nil {
				writeErr = err
			}
		})
	if err != nil {
		return "", err
	}
	if writeErr != nil {
		return "", writeErr
	}
	if code != 0 {
		return "", fmt.Errorf("pg_dumpall exit %d: %s", code, strings.TrimSpace(stderr.String()))
	}
	if wrote == 0 {
		return "", fmt.Errorf("empty dump")
	}
	return dumpPath, nil
}

// --- CouchDB (port of CouchDBService.backup) ---

// dumpCouchDBStage exports every user database as JSON and tars the result
// into <stagingDir>/couchdb<suffix>-backup-<ts>.tar.gz — the exact layout
// gitops's CouchDB restore consumes ({db}/documents.json + manifest.json).
func dumpCouchDBStage(ctx context.Context, client *infradriver.Client, wctx infradriver.WorkspaceContext, ws, stage, stagingDir string) (string, error) {
	container := ws + "__couchdb" + stageSuffix(stage)
	running, err := containerRunning(ctx, client, wctx, container)
	if err != nil {
		return "", err
	}
	if !running {
		return "", nil
	}

	secrets := serviceSecrets(ws, "couchdb", stage)
	user := secrets["COUCHDB_USER"]
	if user == "" {
		user = "admin"
	}
	password := secrets["COUCHDB_PASSWORD"]

	curl := func(path string) ([]byte, error) {
		return execCollect(ctx, client, wctx, container,
			"curl", "-s", "-u", user+":"+password, "http://localhost:5984"+path)
	}

	allDBsRaw, err := curl("/_all_dbs")
	if err != nil {
		return "", fmt.Errorf("failed to list databases: %w", err)
	}
	var databases []string
	if err := json.Unmarshal(allDBsRaw, &databases); err != nil {
		return "", fmt.Errorf("_all_dbs returned non-JSON: %.200s", allDBsRaw)
	}
	var userDBs []string
	for _, db := range databases {
		if !strings.HasPrefix(db, "_") {
			userDBs = append(userDBs, db)
		}
	}

	backupTime := time.Now().UTC()
	if err := os.MkdirAll(stagingDir, 0o700); err != nil {
		return "", err
	}
	tarballPath := filepath.Join(stagingDir,
		fmt.Sprintf("couchdb%s-backup-%s.tar.gz", stageSuffix(stage), backupTime.Format("20060102-150405")))

	f, err := os.Create(tarballPath)
	if err != nil {
		return "", err
	}
	defer f.Close()
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)

	addFile := func(name string, data []byte) error {
		if err := tw.WriteHeader(&tar.Header{
			Name:    name,
			Mode:    0o644,
			Size:    int64(len(data)),
			ModTime: backupTime,
		}); err != nil {
			return err
		}
		_, err := tw.Write(data)
		return err
	}

	for _, db := range userDBs {
		docs, err := curl("/" + db + "/_all_docs?include_docs=true")
		if err != nil {
			return "", fmt.Errorf("failed to get docs for %q: %w", db, err)
		}
		if err := addFile(db+"/documents.json", docs); err != nil {
			return "", err
		}
	}

	manifest, err := json.MarshalIndent(map[string]interface{}{
		"version":      2,
		"workspace":    ws,
		"backup_date":  backupTime.Format("2006-01-02T15:04:05.999999"),
		"databases":    userDBs,
		"couchdb_host": container,
	}, "", "  ")
	if err != nil {
		return "", err
	}
	if err := addFile("manifest.json", manifest); err != nil {
		return "", err
	}

	if err := tw.Close(); err != nil {
		return "", err
	}
	if err := gz.Close(); err != nil {
		return "", err
	}
	return tarballPath, nil
}

// --- Garage (port of GarageService.backup) ---

// garageRcloneArgv mirrors gitops's garage_util.garage_rclone_argv: flags
// only — the driver's exec primitive cannot set env vars.
func garageRcloneArgv(host, port, accessKey, secretKey string, verb ...string) []string {
	argv := []string{
		"rclone",
		"--s3-provider", "Other",
		"--s3-endpoint", "http://" + host + ":" + port,
		"--s3-region", "us-east-1",
		"--s3-access-key-id", accessKey,
		"--s3-secret-access-key", secretKey,
	}
	return append(argv, verb...)
}

// dumpGarageStage rclone-syncs every bucket inside the toolbox sidecar and
// streams the result out as an uncompressed tar (restic compresses off-site)
// into <stagingDir>/garage<suffix>-backup-<ts>.tar.
func dumpGarageStage(ctx context.Context, client *infradriver.Client, wctx infradriver.WorkspaceContext, ws, stage, stagingDir string, warn func(string)) (string, error) {
	suffix := stageSuffix(stage)
	container := ws + "__garage" + suffix
	toolbox := container + "-toolbox"
	running, err := containerRunning(ctx, client, wctx, container)
	if err != nil {
		return "", err
	}
	if !running {
		return "", nil
	}

	// Bucket names are the global aliases (the provisioner always creates
	// one per bucket). The garage image is a bare static binary: admin ops
	// exec `/garage json-api`, everything S3 runs in the toolbox.
	listRaw, err := execCollect(ctx, client, wctx, container, "/garage", "json-api", "ListBuckets")
	if err != nil {
		return "", fmt.Errorf("ListBuckets failed: %w", err)
	}
	var entries []struct {
		GlobalAliases []string `json:"globalAliases"`
	}
	if err := json.Unmarshal(listRaw, &entries); err != nil {
		return "", fmt.Errorf("ListBuckets returned non-JSON: %.200s", listRaw)
	}
	var buckets []string
	for _, e := range entries {
		buckets = append(buckets, e.GlobalAliases...)
	}

	// The per-realm full-access `_system` key (maintained by the driver's
	// provisioner for exactly this).
	sysCreds := parseEnvFile(filepath.Join(workspaceDir(ws), "secrets", "garagecreds", stage, "_system"))
	accessKey, secretKey := sysCreds["S3_ACCESS_KEY"], sysCreds["S3_SECRET_KEY"]
	if len(buckets) > 0 && (accessKey == "" || secretKey == "") {
		return "", fmt.Errorf("no _system Garage key for stage %s — cannot back up", stage)
	}

	garageSecrets := serviceSecrets(ws, "garage", stage)
	host := garageSecrets["S3_HOST"]
	if host == "" {
		host = ws + "-garage" + suffix
	}
	port := garageSecrets["S3_PORT"]
	if port == "" {
		port = "9000"
	}

	const scratch = "/tmp/garage-backup"
	if _, err := execCollect(ctx, client, wctx, toolbox,
		"sh", "-c", "rm -rf "+scratch+" && mkdir -p "+scratch); err != nil {
		return "", fmt.Errorf("backup scratch setup failed: %w", err)
	}

	for _, bucket := range buckets {
		argv := garageRcloneArgv(host, port, accessKey, secretKey,
			"sync", ":s3:"+bucket, scratch+"/"+bucket)
		if _, err := execCollect(ctx, client, wctx, toolbox, argv...); err != nil {
			warn(fmt.Sprintf("failed to sync bucket %s: %v", bucket, err))
		}
	}

	backupTime := time.Now().UTC()
	manifest, err := json.MarshalIndent(map[string]interface{}{
		"version":     1,
		"workspace":   ws,
		"backup_date": backupTime.Format("2006-01-02T15:04:05.999999"),
		"format":      "rclone_sync",
		"buckets":     buckets,
		"s3_host":     host,
	}, "", "  ")
	if err != nil {
		return "", err
	}
	if _, err := execCollect(ctx, client, wctx, toolbox,
		"sh", "-c", "cat > "+scratch+"/manifest.json << 'MANIFESTEOF'\n"+string(manifest)+"\nMANIFESTEOF"); err != nil {
		return "", fmt.Errorf("failed to write manifest: %w", err)
	}

	// Stream the synced dir out as a tar via copy-out — the archiving is
	// done by the docker daemon (the toolbox needs no tar binary). The
	// archive is rooted at the scratch dir's basename ("garage-backup/").
	if err := os.MkdirAll(stagingDir, 0o700); err != nil {
		return "", err
	}
	tarballPath := filepath.Join(stagingDir,
		fmt.Sprintf("garage%s-backup-%s.tar", suffix, backupTime.Format("20060102-150405")))
	reader, err := client.ContainerCopyOut(ctx, wctx, toolbox, scratch)
	if err != nil {
		return "", err
	}
	defer reader.Close()
	f, err := os.Create(tarballPath)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := io.Copy(f, reader); err != nil {
		return "", err
	}

	// Best-effort scratch cleanup (next run resets it anyway).
	if _, err := execCollect(ctx, client, wctx, toolbox, "sh", "-c", "rm -rf "+scratch); err != nil {
		warn(fmt.Sprintf("scratch cleanup failed: %v", err))
	}
	return tarballPath, nil
}
