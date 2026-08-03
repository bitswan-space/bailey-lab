package daemon

import (
	"database/sql"
	"time"
)

// updateRollbackDepth caps how many prior versions a target (the server binary
// or a workspace) keeps as restorable rollback points — "3 versions deep". Each
// retained row is one offered rollback point.
const updateRollbackDepth = 3

const (
	updateTargetServer    = "server"
	updateTargetWorkspace = "workspace"
)

// updateHistoryEntry is one recorded update (or rollback) of the server binary
// or a workspace: WHO changed WHAT to WHICH version, WHEN, plus the artifact
// needed to restore the pre-update state.
type updateHistoryEntry struct {
	ID          int64  `json:"id"`
	TS          string `json:"ts"`          // RFC3339 UTC — when
	Actor       string `json:"actor"`       // email — who ("" = system/CLI)
	TargetKind  string `json:"target_kind"` // server | workspace
	TargetName  string `json:"target_name"` // "" for server, workspace name otherwise
	FromVersion string `json:"from_version"`
	ToVersion   string `json:"to_version"`
	IsRollback  bool   `json:"is_rollback"`
	// Artifact is the pre-update state to restore on a rollback: for the server a
	// path to the saved previous binary; for a workspace the inline pre-update
	// docker-compose.yml. Never serialised to the client.
	Artifact string `json:"-"`
}

func dbInsertUpdateHistory(e updateHistoryEntry) (int64, error) {
	db, err := openBaileyDB()
	if err != nil {
		return 0, err
	}
	if e.TS == "" {
		e.TS = time.Now().UTC().Format(time.RFC3339)
	}
	rb := 0
	if e.IsRollback {
		rb = 1
	}
	res, err := db.Exec(
		`INSERT INTO update_history(ts, actor, target_kind, target_name, from_version, to_version, is_rollback, artifact)
		 VALUES(?,?,?,?,?,?,?,?)`,
		e.TS, e.Actor, e.TargetKind, e.TargetName, e.FromVersion, e.ToVersion, rb, e.Artifact)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func scanUpdateHistoryRows(rows *sql.Rows) ([]updateHistoryEntry, error) {
	defer rows.Close()
	out := []updateHistoryEntry{}
	for rows.Next() {
		var e updateHistoryEntry
		var rb int
		if err := rows.Scan(&e.ID, &e.TS, &e.Actor, &e.TargetKind, &e.TargetName,
			&e.FromVersion, &e.ToVersion, &rb, &e.Artifact); err != nil {
			return nil, err
		}
		e.IsRollback = rb != 0
		out = append(out, e)
	}
	return out, rows.Err()
}

// dbListUpdateHistory returns the rows for one target, newest first, capped at
// limit (updateRollbackDepth when limit <= 0).
func dbListUpdateHistory(kind, name string, limit int) ([]updateHistoryEntry, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = updateRollbackDepth
	}
	rows, err := db.Query(
		`SELECT id, ts, actor, target_kind, target_name, from_version, to_version, is_rollback, artifact
		 FROM update_history WHERE target_kind=? AND target_name=? ORDER BY id DESC LIMIT ?`,
		kind, name, limit)
	if err != nil {
		return nil, err
	}
	return scanUpdateHistoryRows(rows)
}

// dbListRecentUpdateHistory returns the newest-first rows across ALL targets,
// capped to `perTarget` rows for each (target_kind, target_name) so a busy
// target can't crowd the others out. Backs the Updates-page audit log.
func dbListRecentUpdateHistory(perTarget int) ([]updateHistoryEntry, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	if perTarget <= 0 {
		perTarget = updateRollbackDepth
	}
	// One window per target via a correlated rank, then newest-first overall.
	rows, err := db.Query(
		`SELECT id, ts, actor, target_kind, target_name, from_version, to_version, is_rollback, artifact
		 FROM update_history h
		 WHERE (SELECT COUNT(*) FROM update_history x
		        WHERE x.target_kind=h.target_kind AND x.target_name=h.target_name AND x.id > h.id) < ?
		 ORDER BY id DESC`,
		perTarget)
	if err != nil {
		return nil, err
	}
	return scanUpdateHistoryRows(rows)
}

// dbGetUpdateHistory loads a single row by id (nil, nil when absent).
func dbGetUpdateHistory(id int64) (*updateHistoryEntry, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(
		`SELECT id, ts, actor, target_kind, target_name, from_version, to_version, is_rollback, artifact
		 FROM update_history WHERE id=?`, id)
	if err != nil {
		return nil, err
	}
	list, err := scanUpdateHistoryRows(rows)
	if err != nil || len(list) == 0 {
		return nil, err
	}
	return &list[0], nil
}

// dbPruneUpdateHistory keeps the newest `keep` rows for a target and deletes the
// rest, returning the artifacts of the deleted rows so the caller can remove any
// on-disk files they reference (server binaries). Inline artifacts (workspace
// compose) need no cleanup — the row deletion is enough.
func dbPruneUpdateHistory(kind, name string, keep int) ([]string, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	if keep < 0 {
		keep = 0
	}
	// The rows to drop: everything past the newest `keep` for this target.
	rows, err := db.Query(
		`SELECT id, artifact FROM update_history
		 WHERE target_kind=? AND target_name=? ORDER BY id DESC LIMIT -1 OFFSET ?`,
		kind, name, keep)
	if err != nil {
		return nil, err
	}
	var ids []int64
	var artifacts []string
	for rows.Next() {
		var id int64
		var art string
		if err := rows.Scan(&id, &art); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
		artifacts = append(artifacts, art)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	for _, id := range ids {
		if _, err := db.Exec(`DELETE FROM update_history WHERE id=?`, id); err != nil {
			return artifacts, err
		}
	}
	return artifacts, nil
}
