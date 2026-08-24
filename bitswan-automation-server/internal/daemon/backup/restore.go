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
	"sort"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

// Targeted restores (v1 scope): a single workspace's files or DB dumps back
// into an existing server. Full-server bootstrap is a documented runbook
// composed of these plus `bitswan workspace update`.

// newResticFromState builds a runner from the stored target + key.
func newResticFromState() (*Restic, error) {
	target, err := LoadAOCTarget()
	if err != nil {
		return nil, err
	}
	key, err := LoadKey()
	if err != nil {
		return nil, err
	}
	if key == "" {
		return nil, fmt.Errorf("no backup key")
	}
	return NewRestic(target, key), nil
}

// snapshotMeta is the subset of `restic snapshots --json` restores need.
// Paths matters for in-place restores: it is the absolute path the snapshot
// recorded, which must equal the live path we are about to overwrite.
type snapshotMeta struct {
	ID      string    `json:"id"`
	ShortID string    `json:"short_id"`
	Time    time.Time `json:"time"`
	Tags    []string  `json:"tags"`
	Paths   []string  `json:"paths"`
}

func listSnapshotsMeta(ctx context.Context, restic *Restic, tags []string) ([]snapshotMeta, error) {
	args := []string{"snapshots", "--json"}
	for _, tag := range tags {
		args = append(args, "--tag", tag)
	}
	stdout, _, err := restic.Run(ctx, args...)
	if err != nil {
		return nil, err
	}
	var snapshots []snapshotMeta
	if err := json.Unmarshal([]byte(stdout), &snapshots); err != nil {
		return nil, fmt.Errorf("unexpected restic snapshots output: %w", err)
	}
	sort.Slice(snapshots, func(i, j int) bool { return snapshots[i].Time.After(snapshots[j].Time) })
	return snapshots, nil
}

// resticRestore restores one snapshot (optionally --include-scoped) to target.
func resticRestore(ctx context.Context, restic *Restic, snapshotID, target string, includes ...string) error {
	if err := os.MkdirAll(target, 0o700); err != nil {
		return err
	}
	args := []string{"restore", snapshotID, "--target", target}
	for _, include := range includes {
		args = append(args, "--include", include)
	}
	_, _, err := restic.Run(ctx, args...)
	return err
}

// resolveSnapshot turns an optional explicit id into a restic selector for
// the given tag series ("latest" scoped by tags when empty).
func resolveSnapshot(snapshotID string) string {
	if snapshotID == "" {
		return "latest"
	}
	return snapshotID
}

func seriesArgs(snapshotID string, tags []string) []string {
	if snapshotID != "" {
		return nil // explicit id — no tag scoping needed
	}
	// One --tag flag with comma-joined values = AND (all must match).
	return []string{"--tag", strings.Join(tags, ",")}
}

// RestoreWorkspaceFiles restores a workspace's file-tree snapshot into a
// fresh directory under the backup dir — deliberately NOT onto the live
// tree; the runbook's stop → rsync → `workspace update` closes the loop.
// Returns the restore destination.
func RestoreWorkspaceFiles(ctx context.Context, ws, snapshotID string) (string, error) {
	restic, err := newResticFromState()
	if err != nil {
		return "", err
	}
	target := filepath.Join(Dir(), "restores", ws, time.Now().UTC().Format("2006-01-02_15-04-05"))
	args := []string{"restore", resolveSnapshot(snapshotID)}
	args = append(args, seriesArgs(snapshotID, []string{"files", "ws:" + ws})...)
	args = append(args, "--target", target)
	if err := os.MkdirAll(target, 0o700); err != nil {
		return "", err
	}
	if _, _, err := restic.Run(ctx, args...); err != nil {
		return "", err
	}
	return target, nil
}

// RestoreFilesInPlace restores a workspace's tree onto its LIVE volume path
// (restic restore --target / --include <wsDir>), the same pattern FetchSnapshot
// uses. Ownership and modes come from the snapshot — restic preserves them and
// the daemon runs as root — so no chown pass is needed.
//
// The caller MUST have emptied wsDir first (recovery quarantine-renames it):
// restic restore merges into an existing tree rather than replacing it, so
// files that the snapshot doesn't contain would otherwise survive.
//
// excludes are absolute paths dropped from the restore (e.g. the per-BP
// snapshots dir, which is large and re-fetchable on demand).
func RestoreFilesInPlace(ctx context.Context, ws string, snap FilesSnapshot, excludes []string) error {
	restic, err := newResticFromState()
	if err != nil {
		return err
	}
	wsDir := workspaceDir(ws)

	// An in-place restore writes wherever the snapshot recorded. If that path
	// differs from the live one (a different HOME, a re-pointed volume), the
	// restore would silently land somewhere else and still report success.
	if snap.Path != "" && snap.Path != wsDir {
		return fmt.Errorf(
			"snapshot %s recorded %s but this server keeps the workspace at %s — "+
				"refusing an in-place restore to avoid writing to the wrong path",
			snap.ShortID, snap.Path, wsDir)
	}

	args := []string{"restore", snap.ID, "--target", "/", "--include", wsDir}
	for _, ex := range excludes {
		args = append(args, "--exclude", ex)
	}
	if _, _, err := restic.Run(ctx, args...); err != nil {
		return err
	}

	// restic exits 0 when --include matches nothing, so verify explicitly.
	if _, err := os.Stat(wsDir); err != nil {
		return fmt.Errorf("restore reported success but %s is still missing", wsDir)
	}
	return nil
}

// findFileBySuffix walks root for the first file matching suffix.
func findFileBySuffix(root, suffix string) string {
	var found string
	filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || found != "" || info.IsDir() {
			return nil
		}
		if strings.HasSuffix(path, suffix) {
			found = path
		}
		return nil
	})
	return found
}

// restoreArtifact pulls one dump snapshot into a temp dir and returns the
// artifact file matching suffix. Caller removes the returned dir.
func restoreArtifact(ctx context.Context, restic *Restic, ws, stage, service, snapshotID, suffix string) (dir, artifact string, err error) {
	dir, err = os.MkdirTemp(Dir(), service+"-restore-")
	if err != nil {
		return "", "", err
	}
	args := []string{"restore", resolveSnapshot(snapshotID)}
	args = append(args, seriesArgs(snapshotID, []string{service, "ws:" + ws, "stage:" + stage})...)
	args = append(args, "--target", dir)
	if _, _, err := restic.Run(ctx, args...); err != nil {
		os.RemoveAll(dir)
		return "", "", err
	}
	artifact = findFileBySuffix(dir, suffix)
	if artifact == "" {
		os.RemoveAll(dir)
		return "", "", fmt.Errorf("no %s found in snapshot", suffix)
	}
	return dir, artifact, nil
}

// RestorePostgres pipes the dump snapshot into `psql` in the stage's
// postgres container (port of gitops's restore_postgres).
func RestorePostgres(ctx context.Context, ws, stage, snapshotID string) (string, error) {
	restic, err := newResticFromState()
	if err != nil {
		return "", err
	}
	dir, sqlFile, err := restoreArtifact(ctx, restic, ws, stage, "postgres", snapshotID, ".sql")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)

	client, wctx, err := driverForWorkspace(ws)
	if err != nil {
		return "", err
	}
	container := ws + "__postgres" + stageSuffix(stage)
	running, err := containerRunning(ctx, client, wctx, container)
	if err != nil {
		return "", err
	}
	if !running {
		return "", fmt.Errorf("postgres container %q not running", container)
	}

	user := "admin"
	if secrets := serviceSecrets(ws, "postgres", stage); secrets["POSTGRES_USER"] != "" {
		user = secrets["POSTGRES_USER"]
	}

	dump, err := os.Open(sqlFile)
	if err != nil {
		return "", err
	}
	defer dump.Close()

	var stderr bytes.Buffer
	code, err := client.ContainerExec(ctx, wctx,
		infradriver.ExecSpec{Container: container, Cmd: []string{"psql", "-U", user, "-d", "postgres"}},
		dump,
		func(isStderr bool, chunk []byte) {
			if isStderr {
				stderr.Write(chunk)
			}
		})
	if err != nil {
		return "", fmt.Errorf("psql restore failed: %w", err)
	}
	if code != 0 {
		return "", fmt.Errorf("psql restore failed: %s", strings.TrimSpace(stderr.String()))
	}
	return fmt.Sprintf("Postgres restored to %s stage", stage), nil
}

// RestoreCouchDB loads the export tarball back through the stage's CouchDB
// HTTP API (port of gitops's CouchDBService.restore, v2 format).
func RestoreCouchDB(ctx context.Context, ws, stage, snapshotID string) (string, error) {
	restic, err := newResticFromState()
	if err != nil {
		return "", err
	}
	dir, tarball, err := restoreArtifact(ctx, restic, ws, stage, "couchdb", snapshotID, ".tar.gz")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)

	client, wctx, err := driverForWorkspace(ws)
	if err != nil {
		return "", err
	}
	container := ws + "__couchdb" + stageSuffix(stage)
	running, err := containerRunning(ctx, client, wctx, container)
	if err != nil {
		return "", err
	}
	if !running {
		return "", fmt.Errorf("couchdb container %q not running", container)
	}

	secrets := serviceSecrets(ws, "couchdb", stage)
	user := secrets["COUCHDB_USER"]
	if user == "" {
		user = "admin"
	}
	password := secrets["COUCHDB_PASSWORD"]

	documents, manifest, err := readCouchExport(tarball)
	if err != nil {
		return "", err
	}
	databases := manifest
	if len(databases) == 0 {
		for db := range documents {
			databases = append(databases, db)
		}
		sort.Strings(databases)
	}
	if len(databases) == 0 {
		return "", fmt.Errorf("no databases found in backup")
	}

	var restored []string
	for _, db := range databases {
		backupDoc, ok := documents[db]
		if !ok {
			continue
		}

		// Ensure the database exists (PUT is idempotent enough here: 201 or
		// 412 already-exists both leave it present).
		if _, err := execCollect(ctx, client, wctx, container,
			"curl", "-s", "-X", "PUT", "-u", user+":"+password,
			"http://localhost:5984/"+db); err != nil {
			return "", fmt.Errorf("failed to ensure database %q: %w", db, err)
		}

		var export struct {
			Rows []struct {
				Doc map[string]interface{} `json:"doc"`
			} `json:"rows"`
		}
		if err := json.Unmarshal(backupDoc, &export); err != nil {
			return "", fmt.Errorf("bad documents.json for %q: %w", db, err)
		}
		var docs []map[string]interface{}
		for _, row := range export.Rows {
			if row.Doc == nil {
				continue
			}
			delete(row.Doc, "_rev")
			delete(row.Doc, "_attachments")
			docs = append(docs, row.Doc)
		}
		if len(docs) == 0 {
			restored = append(restored, db)
			continue
		}

		payload, err := json.Marshal(map[string]interface{}{"docs": docs})
		if err != nil {
			return "", err
		}
		var stderr bytes.Buffer
		code, err := client.ContainerExec(ctx, wctx,
			infradriver.ExecSpec{Container: container, Cmd: []string{
				"sh", "-c",
				"curl -s -X POST -H 'Content-Type: application/json' " +
					"-u '" + user + ":" + password + "' --data-binary @- " +
					"'http://localhost:5984/" + db + "/_bulk_docs'",
			}},
			bytes.NewReader(payload),
			func(isStderr bool, chunk []byte) {
				if isStderr {
					stderr.Write(chunk)
				}
			})
		if err != nil || code != 0 {
			return "", fmt.Errorf("bulk restore of %q failed (exit %d): %v %s", db, code, err, stderr.String())
		}
		restored = append(restored, db)
	}
	return fmt.Sprintf("CouchDB restored to %s stage (databases: %s)", stage, strings.Join(restored, ", ")), nil
}

// readCouchExport extracts {db}/documents.json blobs + the manifest's
// database list from a couchdb export tarball.
func readCouchExport(tarball string) (map[string]json.RawMessage, []string, error) {
	f, err := os.Open(tarball)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return nil, nil, err
	}
	defer gz.Close()

	documents := map[string]json.RawMessage{}
	var databases []string
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, err
		}
		name := strings.TrimPrefix(hdr.Name, "./")
		switch {
		case name == "manifest.json":
			data, err := io.ReadAll(tr)
			if err != nil {
				return nil, nil, err
			}
			var manifest struct {
				Databases []string `json:"databases"`
			}
			if err := json.Unmarshal(data, &manifest); err == nil {
				databases = manifest.Databases
			}
		case strings.HasSuffix(name, "/documents.json"):
			db := strings.SplitN(name, "/", 2)[0]
			data, err := io.ReadAll(tr)
			if err != nil {
				return nil, nil, err
			}
			documents[db] = json.RawMessage(data)
		}
	}
	return documents, databases, nil
}
