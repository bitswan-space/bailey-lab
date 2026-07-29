package backup

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Choosing ONE coherent nightly to recover from.
//
// A recovery must not mix a file tree from one run with database dumps from
// another: the tree carries bitswan.yaml, secrets and per-BP state that the
// dumps were taken against. Engine.backupWorkspace captures the tree FIRST and
// the dumps after it (engine.go), and runs are serialized (Engine.begin), so
// run N's dumps all fall in [files(N).Time, files(N+1).Time). Bracketing by the
// NEXT files snapshot is therefore the correct way to group a run — selecting
// "the newest dump at or before the files snapshot" would pick run N-1's
// databases every single time.

// FilesSnapshot is the chosen nightly for a workspace's file tree; it anchors
// the whole recovery.
type FilesSnapshot struct {
	ID      string    `json:"id"`
	ShortID string    `json:"short_id"`
	Time    time.Time `json:"time"`
	// Path is the absolute tree path THIS snapshot recorded. An in-place
	// restore is only safe when it equals the live workspace path.
	Path string `json:"path"`
	// NextTime is the next newer files snapshot's time, or zero when this is
	// the newest — the upper bound of this run's window.
	NextTime time.Time `json:"next_time,omitempty"`
}

// DumpSnapshot is the chosen snapshot for one (service, stage) dump series.
type DumpSnapshot struct {
	ID      string    `json:"id"`
	ShortID string    `json:"short_id"`
	Time    time.Time `json:"time"`
	// Stale means no dump existed inside the anchor run's window, so this is
	// an older one (the run skipped the dump — e.g. the container was down).
	Stale bool `json:"stale,omitempty"`
	// Missing means the series has no snapshots at all.
	Missing bool `json:"missing,omitempty"`
}

// SnapshotSet is one coherent recovery point.
type SnapshotSet struct {
	Files    FilesSnapshot                      `json:"files"`
	Dumps    map[string]map[string]DumpSnapshot `json:"dumps"` // [service][stage]
	Warnings []string                           `json:"warnings,omitempty"`
}

// Dump returns the chosen snapshot for a series, and whether it is usable.
func (s SnapshotSet) Dump(service, stage string) (DumpSnapshot, bool) {
	byStage, ok := s.Dumps[service]
	if !ok {
		return DumpSnapshot{Missing: true}, false
	}
	d, ok := byStage[stage]
	if !ok || d.Missing || d.ID == "" {
		return DumpSnapshot{Missing: true}, false
	}
	return d, true
}

// seriesTag builds the single comma-joined tag that ANDs a series together.
// Multiple --tag flags OR (which is what retention relies on), so a series
// query must pass exactly ONE element — otherwise it silently widens to every
// workspace.
func seriesTag(parts ...string) []string {
	return []string{strings.Join(parts, ",")}
}

// SelectSnapshotSet resolves the files snapshot plus, for every
// (service, stage) series, the dump captured by the SAME run.
//
// filesSnapshotID pins the anchor (point-in-time recovery); empty means the
// newest. services/stages narrow the dump series considered.
func SelectSnapshotSet(ctx context.Context, ws, filesSnapshotID string, services, stageFilter []string) (SnapshotSet, error) {
	restic, err := newResticFromState()
	if err != nil {
		return SnapshotSet{}, err
	}

	filesSeries, err := listSnapshotsMeta(ctx, restic, seriesTag("files", "ws:"+ws))
	if err != nil {
		return SnapshotSet{}, fmt.Errorf("could not list file snapshots: %w", err)
	}
	if len(filesSeries) == 0 {
		return SnapshotSet{}, fmt.Errorf(
			"no file-tree backup exists for workspace %q "+
				"(the repo is reachable, but nothing is tagged files,ws:%s — "+
				"check the workspace name, or that a backup ran since it was created)", ws, ws)
	}

	// filesSeries is newest-first (listSnapshotsMeta sorts it).
	anchor := -1
	if filesSnapshotID == "" {
		anchor = 0
	} else {
		for i, s := range filesSeries {
			if s.ID == filesSnapshotID || s.ShortID == filesSnapshotID {
				anchor = i
				break
			}
		}
		if anchor < 0 {
			return SnapshotSet{}, fmt.Errorf(
				"snapshot %q is not a file-tree backup of workspace %q", filesSnapshotID, ws)
		}
	}

	chosen := filesSeries[anchor]
	files := FilesSnapshot{ID: chosen.ID, ShortID: chosen.ShortID, Time: chosen.Time}
	if len(chosen.Paths) > 0 {
		files.Path = chosen.Paths[0]
	}
	if anchor > 0 {
		// The entry before it in a newest-first list is the NEXT newer run.
		files.NextTime = filesSeries[anchor-1].Time
	}

	set := SnapshotSet{Files: files, Dumps: map[string]map[string]DumpSnapshot{}}

	if len(services) == 0 {
		services = []string{"postgres", "couchdb", "garage"}
	}
	if len(stageFilter) == 0 {
		stageFilter = stages
	}

	for _, service := range services {
		set.Dumps[service] = map[string]DumpSnapshot{}
		for _, stage := range stageFilter {
			series, err := listSnapshotsMeta(ctx, restic,
				seriesTag(service, "ws:"+ws, "stage:"+stage))
			if err != nil {
				return SnapshotSet{}, fmt.Errorf("could not list %s/%s snapshots: %w", service, stage, err)
			}
			set.Dumps[service][stage] = pickDump(series, files, service, stage, &set.Warnings)
		}
	}
	return set, nil
}

// pickDump applies the bracketing rule to one series.
func pickDump(series []snapshotMeta, files FilesSnapshot, service, stage string, warnings *[]string) DumpSnapshot {
	if len(series) == 0 {
		return DumpSnapshot{Missing: true}
	}
	// Newest-first; walk oldest-first so "newest in window" is the last match.
	sorted := make([]snapshotMeta, len(series))
	copy(sorted, series)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Time.Before(sorted[j].Time) })

	var inWindow, older *snapshotMeta
	for i := range sorted {
		s := &sorted[i]
		switch {
		case s.Time.Before(files.Time):
			older = s
		case files.NextTime.IsZero() || s.Time.Before(files.NextTime):
			inWindow = s // at/after the anchor and before the next run
		}
	}

	if inWindow != nil {
		return DumpSnapshot{ID: inWindow.ID, ShortID: inWindow.ShortID, Time: inWindow.Time}
	}
	if older != nil {
		*warnings = append(*warnings, fmt.Sprintf(
			"%s/%s: the selected backup run captured no dump, falling back to %s from %s (%s older than the file tree)",
			service, stage, older.ShortID, older.Time.UTC().Format(time.RFC3339),
			files.Time.Sub(older.Time).Round(time.Minute)))
		return DumpSnapshot{ID: older.ID, ShortID: older.ShortID, Time: older.Time, Stale: true}
	}
	return DumpSnapshot{Missing: true}
}

// WaitForServiceContainer blocks until a stage's service container is running,
// so a restore that follows an apply doesn't race the container coming up.
func WaitForServiceContainer(ctx context.Context, ws, service, stage string, timeout time.Duration) error {
	client, wctx, err := driverForWorkspace(ws)
	if err != nil {
		return err
	}
	container := ws + "__" + service + stageSuffix(stage)

	deadline := time.Now().Add(timeout)
	var lastErr error
	for {
		running, err := containerRunning(ctx, client, wctx, container)
		if err == nil && running {
			return nil
		}
		lastErr = err
		if time.Now().After(deadline) {
			if lastErr != nil {
				return fmt.Errorf("container %q not running after %s: %w", container, timeout, lastErr)
			}
			return fmt.Errorf("container %q not running after %s", container, timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
}

// ServiceEnabled reports whether a service is enabled on a stage, which is the
// existence of its secrets env file — the same convention the driver's compiler
// uses. Only knowable after a restore, since it reads the live tree.
func ServiceEnabled(ws, service, stage string) bool {
	return serviceSecrets(ws, service, stage) != nil
}

// CheckGarageKeys compares the access keys the workspace's secrets name against
// the keys Garage actually has. They diverge when secrets are restored onto a
// rebuilt Garage: its metadata volume carries buckets AND keys, so every
// restored key id is dangling and each app fails with "AccessDenied"/"No such
// key". The driver self-heals this from the release that fixed it, so a restored
// compose pinning an older driver image stays broken — hence an explicit check.
func CheckGarageKeys(ctx context.Context, ws, stage string) (string, error) {
	client, wctx, err := driverForWorkspace(ws)
	if err != nil {
		return "", err
	}
	container := ws + "__garage" + stageSuffix(stage)
	running, err := containerRunning(ctx, client, wctx, container)
	if err != nil {
		return "", err
	}
	if !running {
		return "", fmt.Errorf("container %q not running", container)
	}

	raw, err := execCollect(ctx, client, wctx, container, "/garage", "json-api", "ListKeys")
	if err != nil {
		return "", fmt.Errorf("ListKeys failed: %w", err)
	}
	var keys []struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &keys); err != nil {
		return "", fmt.Errorf("ListKeys returned non-JSON: %.200s", raw)
	}
	live := map[string]bool{}
	for _, k := range keys {
		live[k.ID] = true
	}

	credsDir := filepath.Join(workspaceDir(ws), "secrets", "garagecreds", stage)
	entries, err := os.ReadDir(credsDir)
	if err != nil {
		return "no Garage credentials for this stage", nil
	}
	var dangling []string
	checked := 0
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		vals := parseEnvFile(filepath.Join(credsDir, entry.Name()))
		ak := vals["S3_ACCESS_KEY"]
		if ak == "" {
			continue
		}
		checked++
		if !live[ak] {
			dangling = append(dangling, entry.Name()+" ("+ak+")")
		}
	}
	if len(dangling) > 0 {
		sort.Strings(dangling)
		return "", fmt.Errorf(
			"%d of %d Garage keys are dangling — Garage does not have %s. "+
				"Delete those creds files and re-apply so the provisioner re-mints them "+
				"(a driver image older than the self-heal fix will not do it for you)",
			len(dangling), checked, strings.Join(dangling, ", "))
	}
	return fmt.Sprintf("%d key(s) valid", checked), nil
}
