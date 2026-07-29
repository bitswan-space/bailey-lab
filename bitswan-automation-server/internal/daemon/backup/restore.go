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
type snapshotMeta struct {
	ID      string    `json:"id"`
	ShortID string    `json:"short_id"`
	Time    time.Time `json:"time"`
	Tags    []string  `json:"tags"`
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

// lsSnapshot lists a snapshot's entries under one path (recursive), one
// absolute path per line.
func lsSnapshot(ctx context.Context, restic *Restic, snapshotID, path string) ([]string, error) {
	stdout, _, err := restic.Run(ctx, "ls", snapshotID, path)
	if err != nil {
		return nil, err
	}
	var entries []string
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "/") {
			entries = append(entries, line)
		}
	}
	return entries, nil
}

// FindSnapshotWithPath returns the newest snapshot (matching tags) that
// contains path — a locally-pruned artifact may only exist in an older
// nightly, so probing newest→oldest is required, not just "latest".
func FindSnapshotWithPath(ctx context.Context, restic *Restic, tags []string, path string) (string, error) {
	snapshots, err := listSnapshotsMeta(ctx, restic, tags)
	if err != nil {
		return "", err
	}
	for _, snapshot := range snapshots {
		entries, err := lsSnapshot(ctx, restic, snapshot.ID, path)
		if err != nil {
			continue // path not in this snapshot (restic ls errors) — keep probing
		}
		if len(entries) > 0 {
			return snapshot.ID, nil
		}
	}
	return "", fmt.Errorf("no snapshot contains %s", path)
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

// --- DR-rehearsal fetch: gitops pulls a pruned per-BP snapshot back ---

// OffsiteSnapshotRef is one fetchable per-BP snapshot found in the nightly
// file captures.
type OffsiteSnapshotRef struct {
	SnapshotID     string    `json:"snapshot_id"`     // the gitops snapshot dir name
	ResticSnapshot string    `json:"restic_snapshot"` // which nightly holds it
	BackedUpAt     time.Time `json:"backed_up_at"`
}

// snapshotsPath is where a BP's stage snapshots live inside the nightly file
// capture (absolute daemon-side path, which is what restic recorded).
func snapshotsPath(ws, bp, stage string) string {
	return filepath.Join(workspaceDir(ws), "snapshots", bp, stage)
}

// ListOffsiteSnapshots reports which per-BP snapshots exist in the nightly
// captures — the replacement for gitops's own offsite index. Probes the
// newest maxProbe nightlies (older ones only add already-pruned history).
func ListOffsiteSnapshots(ctx context.Context, ws, bp, stage string) ([]OffsiteSnapshotRef, error) {
	restic, err := newResticFromState()
	if err != nil {
		return nil, err
	}
	snapshots, err := listSnapshotsMeta(ctx, restic, []string{"files,ws:" + ws})
	if err != nil {
		return nil, err
	}
	const maxProbe = 30
	if len(snapshots) > maxProbe {
		snapshots = snapshots[:maxProbe]
	}

	prefix := snapshotsPath(ws, bp, stage) + "/"
	seen := map[string]OffsiteSnapshotRef{}
	for _, snapshot := range snapshots {
		entries, err := lsSnapshot(ctx, restic, snapshot.ID, strings.TrimSuffix(prefix, "/"))
		if err != nil {
			continue // dir absent in this nightly
		}
		for _, entry := range entries {
			rest := strings.TrimPrefix(entry, prefix)
			if rest == entry || rest == "" {
				continue
			}
			id := strings.SplitN(rest, "/", 2)[0]
			if _, ok := seen[id]; !ok {
				// Newest-first iteration: first sighting is the newest capture.
				seen[id] = OffsiteSnapshotRef{
					SnapshotID:     id,
					ResticSnapshot: snapshot.ShortID,
					BackedUpAt:     snapshot.Time,
				}
			}
		}
	}
	refs := make([]OffsiteSnapshotRef, 0, len(seen))
	for _, ref := range seen {
		refs = append(refs, ref)
	}
	sort.Slice(refs, func(i, j int) bool { return refs[i].SnapshotID < refs[j].SnapshotID })
	return refs, nil
}

// FetchSnapshot restores one per-BP snapshot dir IN PLACE on the shared
// volume (restic restore --target / --include <abs path>) so gitops's
// snapshot lister sees it immediately. Ownership/modes come back from the
// snapshot itself (restic preserves them; the daemon runs as root).
func FetchSnapshot(ctx context.Context, ws, bp, stage, snapshotID string) error {
	restic, err := newResticFromState()
	if err != nil {
		return err
	}
	path := filepath.Join(snapshotsPath(ws, bp, stage), snapshotID)
	if _, err := os.Stat(path); err == nil {
		return nil // already local
	}
	resticSnapshot, err := FindSnapshotWithPath(ctx, restic, []string{"files,ws:" + ws}, path)
	if err != nil {
		return err
	}
	if _, _, err := restic.Run(ctx, "restore", resticSnapshot, "--target", "/", "--include", path); err != nil {
		return err
	}
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("restore reported success but %s is still missing", path)
	}
	return nil
}
