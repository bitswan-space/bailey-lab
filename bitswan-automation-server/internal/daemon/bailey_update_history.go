package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// versionFromCLIOutput pulls the version token out of `bitswan version` output
// ("bitswan workspaces: v2026.07.31.57" → "v2026.07.31.57"), falling back to the
// trimmed line when there's no recognisable token.
func versionFromCLIOutput(out string) string {
	for _, f := range strings.Fields(out) {
		if strings.HasPrefix(f, "v") && strings.ContainsAny(f, "0123456789") {
			return f
		}
	}
	return strings.TrimSpace(out)
}

// Recording + rollback plumbing over the update_history store. Two targets:
//
//   - the automation-server binary — artifact is the saved PREVIOUS binary on
//     disk (so a rollback restores it to the host path);
//   - a workspace — artifact is the inline PRE-update docker-compose.yml.
//
// The rule is uniform: before changing the binary/compose, save the CURRENT
// state as the new row's artifact, then apply the change. A rollback therefore
// restores the artifact of the chosen row — its from_version — and is itself
// recorded (so the ledger, and the 3-deep window, stay consistent).

// serverArtifactDir holds saved previous server binaries, beside the live one.
func serverArtifactDir() string {
	return filepath.Join(filepath.Dir(hostBinaryPath()), ".bitswan-update-history")
}

// updateTransition renders the version change for the activity-feed / SIEM
// audit target string.
func updateTransition(name, from, to string, isRollback bool) string {
	arrow := from + " → " + to
	if isRollback {
		arrow = "rolled back " + arrow
	}
	if name != "" {
		return name + ": " + arrow
	}
	return arrow
}

// recordServerUpdate persists a server binary update/rollback: it saves the
// previous binary as the row's rollback artifact, appends the ledger row, prunes
// to the 3-deep window (deleting pruned binary files), and mirrors the event to
// the activity feed + SIEM. Best-effort on the audit mirror; the ledger row is
// the durable record.
func recordServerUpdate(actor, fromVer, toVer string, prevBinary []byte, isRollback bool) (int64, error) {
	dir := serverArtifactDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return 0, err
	}
	path := filepath.Join(dir, fmt.Sprintf("server-%d.bin", time.Now().UTC().UnixNano()))
	if err := os.WriteFile(path, prevBinary, 0o755); err != nil {
		return 0, err
	}
	id, err := dbInsertUpdateHistory(updateHistoryEntry{
		Actor:       actor,
		TargetKind:  updateTargetServer,
		FromVersion: fromVer,
		ToVersion:   toVer,
		IsRollback:  isRollback,
		Artifact:    path,
	})
	if err != nil {
		_ = os.Remove(path)
		return 0, err
	}
	if pruned, perr := dbPruneUpdateHistory(updateTargetServer, "", updateRollbackDepth); perr == nil {
		for _, a := range pruned {
			if a != "" {
				_ = os.Remove(a)
			}
		}
	}
	_ = recordEvent(actor, auditServerUpdate, updateTransition("", fromVer, toVer, isRollback))
	return id, nil
}

// recordWorkspaceUpdate persists a workspace update/rollback: it stores the
// pre-update compose inline as the rollback artifact, appends the ledger row,
// prunes to the 3-deep window, and mirrors to the activity feed + SIEM.
func recordWorkspaceUpdate(actor, name, fromVer, toVer, preUpdateCompose string, isRollback bool) (int64, error) {
	id, err := dbInsertUpdateHistory(updateHistoryEntry{
		Actor:       actor,
		TargetKind:  updateTargetWorkspace,
		TargetName:  name,
		FromVersion: fromVer,
		ToVersion:   toVer,
		IsRollback:  isRollback,
		Artifact:    preUpdateCompose,
	})
	if err != nil {
		return 0, err
	}
	// Workspace artifacts are inline, so pruned rows need no file cleanup.
	_, _ = dbPruneUpdateHistory(updateTargetWorkspace, name, updateRollbackDepth)
	_ = recordEvent(actor, auditWorkspaceUpdate, updateTransition(name, fromVer, toVer, isRollback))
	return id, nil
}

// updateHistoryRollbackTarget returns the row iff it exists AND is within the
// last updateRollbackDepth rows for its target — the "only 3 versions deep"
// guard. Returns (nil, nil) for an unknown or too-old id.
func updateHistoryRollbackTarget(id int64) (*updateHistoryEntry, error) {
	e, err := dbGetUpdateHistory(id)
	if err != nil || e == nil {
		return nil, err
	}
	recent, err := dbListUpdateHistory(e.TargetKind, e.TargetName, updateRollbackDepth)
	if err != nil {
		return nil, err
	}
	for _, r := range recent {
		if r.ID == id {
			return e, nil
		}
	}
	return nil, nil
}
