package backup

import (
	"archive/tar"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Garage object-data restore — the exact reverse of dumpGarageStage.
//
// The garage image is a bare static binary and its rclone toolbox sidecar
// mounts no volumes, so the only way to get bytes in is the driver's copy-in
// primitive (docker cp under the hood). The tar produced by the backup is
// rooted at "garage-backup/", and copy-in appends member names to the
// destination, so pushing it at /tmp reproduces /tmp/garage-backup/<bucket>/…

const garageScratch = "/tmp/garage-backup"

// garageManifest is the metadata dumpGarageStage writes into the archive.
type garageManifest struct {
	Version    int      `json:"version"`
	Workspace  string   `json:"workspace"`
	BackupDate string   `json:"backup_date"`
	Format     string   `json:"format"`
	Buckets    []string `json:"buckets"`
	S3Host     string   `json:"s3_host"`
}

// readGarageManifest pulls manifest.json out of the (uncompressed) backup tar
// host-side, so the bucket list is known without an exec round-trip.
func readGarageManifest(tarball string) (garageManifest, error) {
	var manifest garageManifest
	f, err := os.Open(tarball)
	if err != nil {
		return manifest, err
	}
	defer f.Close()

	tr := tar.NewReader(f)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return manifest, fmt.Errorf("no manifest.json in %s", filepath.Base(tarball))
		}
		if err != nil {
			return manifest, err
		}
		name := strings.TrimPrefix(hdr.Name, "./")
		if filepath.Base(name) != "manifest.json" {
			continue
		}
		data, err := io.ReadAll(tr)
		if err != nil {
			return manifest, err
		}
		if err := json.Unmarshal(data, &manifest); err != nil {
			return manifest, fmt.Errorf("bad manifest.json: %w", err)
		}
		return manifest, nil
	}
}

// RestoreGarage replays a stage's Garage buckets from the backup.
//
// mirror selects rclone `sync` (deletes destination objects absent from the
// backup — a true point-in-time restore) instead of `copy`. They are equivalent
// on the cold-recovery path, where the driver has just re-created the buckets
// empty, so `copy` is the safe default for a re-run against a live workspace.
//
// MUST run AFTER the workspace apply: reconcileGarageBuckets re-mints the
// realm's _system key whenever the restored key is not in Garage's ListKeys and
// rewrites the creds file, so credentials read before the apply are dead.
func RestoreGarage(ctx context.Context, ws, stage, snapshotID string, mirror bool) (string, error) {
	restic, err := newResticFromState()
	if err != nil {
		return "", err
	}

	dir, tarball, err := restoreArtifact(ctx, restic, ws, stage, "garage", snapshotID, ".tar")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)

	manifest, err := readGarageManifest(tarball)
	if err != nil {
		return "", err
	}

	client, wctx, err := driverForWorkspace(ws)
	if err != nil {
		return "", err
	}
	suffix := stageSuffix(stage)
	container := ws + "__garage" + suffix
	toolbox := container + "-toolbox"

	for _, name := range []string{container, toolbox} {
		running, err := containerRunning(ctx, client, wctx, name)
		if err != nil {
			return "", err
		}
		if !running {
			return "", fmt.Errorf("container %q not running", name)
		}
	}

	// Live buckets: the driver only creates them for registered BP×realm, so a
	// bucket in the manifest but absent here means its BP is gone.
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
	live := map[string]bool{}
	for _, e := range entries {
		for _, alias := range e.GlobalAliases {
			live[alias] = true
		}
	}

	// Credentials read HERE, after the apply (see the doc comment).
	creds := parseEnvFile(filepath.Join(workspaceDir(ws), "secrets", "garagecreds", stage, "_system"))
	accessKey, secretKey := creds["S3_ACCESS_KEY"], creds["S3_SECRET_KEY"]
	if accessKey == "" || secretKey == "" {
		return "", fmt.Errorf("no _system Garage key for stage %s — cannot restore", stage)
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

	// Push the archive into the toolbox. copy-in needs an existing destination
	// directory, and /tmp always exists.
	if _, err := execCollect(ctx, client, wctx, toolbox, "sh", "-c", "rm -rf "+garageScratch); err != nil {
		return "", fmt.Errorf("scratch reset failed: %w", err)
	}
	f, err := os.Open(tarball)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if err := client.ContainerCopyIn(ctx, wctx, toolbox, "/tmp", f); err != nil {
		return "", fmt.Errorf("failed to push the backup archive into %s: %w", toolbox, err)
	}

	verb := "copy"
	if mirror {
		verb = "sync"
	}

	buckets := append([]string(nil), manifest.Buckets...)
	sort.Strings(buckets)

	var restored, skipped, failed []string
	for _, bucket := range buckets {
		if !live[bucket] {
			// Creating it here would leave a bucket with no key grants.
			skipped = append(skipped, bucket)
			continue
		}
		argv := garageRcloneArgv(host, port, accessKey, secretKey,
			verb, garageScratch+"/"+bucket, ":s3:"+bucket)
		if _, err := execCollect(ctx, client, wctx, toolbox, argv...); err != nil {
			failed = append(failed, fmt.Sprintf("%s (%v)", bucket, err))
			continue
		}
		restored = append(restored, bucket)
	}

	// Best-effort cleanup; the next restore resets the scratch dir anyway.
	if _, err := execCollect(ctx, client, wctx, toolbox, "sh", "-c", "rm -rf "+garageScratch); err != nil {
		_ = err
	}

	var parts []string
	if len(restored) > 0 {
		parts = append(parts, "restored "+strings.Join(restored, ", "))
	}
	if len(skipped) > 0 {
		parts = append(parts, fmt.Sprintf("skipped %s (bucket no longer exists — its business process is gone)",
			strings.Join(skipped, ", ")))
	}
	summary := strings.Join(parts, "; ")
	if summary == "" {
		summary = "nothing to restore"
	}

	// Unlike the backup direction, a failed bucket must fail the step — a
	// silently missing bucket is lost object data.
	if len(failed) > 0 {
		return summary, fmt.Errorf("failed to restore %s", strings.Join(failed, "; "))
	}
	return summary, nil
}
