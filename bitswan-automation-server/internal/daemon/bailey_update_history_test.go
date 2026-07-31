package daemon

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The version ledger keeps only updateRollbackDepth rows per target, newest
// first; the pruned rows' artifacts come back so the caller can delete files.
func TestUpdateHistory_InsertListPrune(t *testing.T) {
	const name = "uh-prune-ws"
	for i := 1; i <= updateRollbackDepth+2; i++ {
		if _, err := dbInsertUpdateHistory(updateHistoryEntry{
			Actor: "a@x", TargetKind: updateTargetWorkspace, TargetName: name,
			FromVersion: "v" + strconv.Itoa(i), ToVersion: "v" + strconv.Itoa(i+1),
			Artifact: "compose-" + strconv.Itoa(i),
		}); err != nil {
			t.Fatal(err)
		}
	}
	pruned, err := dbPruneUpdateHistory(updateTargetWorkspace, name, updateRollbackDepth)
	if err != nil {
		t.Fatal(err)
	}
	if len(pruned) != 2 {
		t.Fatalf("pruned %d rows, want 2", len(pruned))
	}
	list, err := dbListUpdateHistory(updateTargetWorkspace, name, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != updateRollbackDepth {
		t.Fatalf("kept %d rows, want %d", len(list), updateRollbackDepth)
	}
	if list[0].ToVersion != "v"+strconv.Itoa(updateRollbackDepth+3) {
		t.Errorf("newest ToVersion = %q, want the last inserted", list[0].ToVersion)
	}
}

// updateHistoryRollbackTarget rejects a row that exists but sits beyond the
// 3-deep window — the "only 3 versions deep" guard, independent of pruning.
func TestUpdateHistory_RollbackTargetDepthGuard(t *testing.T) {
	const name = "uh-depth-ws"
	var ids []int64
	for i := 1; i <= updateRollbackDepth+1; i++ {
		id, err := dbInsertUpdateHistory(updateHistoryEntry{
			Actor: "a@x", TargetKind: updateTargetWorkspace, TargetName: name,
			FromVersion: "v" + strconv.Itoa(i), ToVersion: "v" + strconv.Itoa(i+1), Artifact: "c",
		})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	// Newest is a valid rollback target…
	if tgt, err := updateHistoryRollbackTarget(ids[len(ids)-1]); err != nil || tgt == nil {
		t.Fatalf("newest row not a valid rollback target: tgt=%v err=%v", tgt, err)
	}
	// …the oldest (4th back) exists but is beyond depth → rejected.
	if tgt, _ := updateHistoryRollbackTarget(ids[0]); tgt != nil {
		t.Error("row beyond updateRollbackDepth should be rejected as a rollback target")
	}
	// An unknown id is rejected too.
	if tgt, _ := updateHistoryRollbackTarget(9_000_001); tgt != nil {
		t.Error("unknown id should not be a rollback target")
	}
}

// recordServerUpdate saves the previous binary as the row's artifact and prunes
// both the rows and their on-disk files to the 3-deep window.
func TestRecordServerUpdate_SavesArtifactAndPrunesFiles(t *testing.T) {
	saved := hostRootDir
	hostRootDir = t.TempDir() // docker inspect fails in tests → hostBinaryPath falls back here
	t.Cleanup(func() { hostRootDir = saved })

	for i := 1; i <= updateRollbackDepth+1; i++ {
		if _, err := recordServerUpdate("admin@x", "v"+strconv.Itoa(i), "v"+strconv.Itoa(i+1),
			[]byte("binary-"+strconv.Itoa(i)), false); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := dbListUpdateHistory(updateTargetServer, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != updateRollbackDepth {
		t.Fatalf("server history kept %d rows, want %d", len(rows), updateRollbackDepth)
	}
	// The fresh host tree holds only this test's artifacts: depth+1 written, the
	// oldest pruned along with its file → exactly depth remain and are readable.
	files, err := os.ReadDir(serverArtifactDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != updateRollbackDepth {
		t.Errorf("artifact files on disk = %d, want %d (pruned files must be deleted)", len(files), updateRollbackDepth)
	}
	if _, err := os.ReadFile(rows[0].Artifact); err != nil {
		t.Errorf("newest artifact unreadable: %v", err)
	}
}

// The server-rollback route is admin-gated and validates the id (a bad/absent id
// yields an in-stream error, not a crash or a 404).
func TestServerRollback_Route_RejectsMissingID(t *testing.T) {
	w := dispatch(baileyForm("/bailey/api/admin/server-rollback", "boss@example.com", url.Values{}, adminGrp))
	if w.Code != http.StatusOK { // NDJSON handler writes 200 then error events
		t.Fatalf("status = %d, want 200 (NDJSON)", w.Code)
	}
	if !strings.Contains(w.Body.String(), "version id is required") {
		t.Errorf("expected a missing-id error event, got: %s", w.Body.String())
	}
}

// The workspace-rollback route is owner-only.
func TestWorkspaceRollback_Route_NonOwnerForbidden(t *testing.T) {
	w := dispatch(baileyForm("/bailey/api/workspaces/uhnooowns/rollback", "stranger@example.com", url.Values{}))
	if w.Code != http.StatusForbidden {
		t.Fatalf("non-owner workspace rollback = %d, want 403", w.Code)
	}
}

// A full server rollback: the retained artifact binary is restored to the host
// path and the rollback is itself recorded (to_version = the target's from).
func TestServerRollback_RestoresArtifactBinary(t *testing.T) {
	saved := hostRootDir
	hostRootDir = t.TempDir() // hostBinaryPath falls back to <hostRootDir>/usr/local/bin/bitswan
	t.Cleanup(func() { hostRootDir = saved })
	binDir := filepath.Join(hostRootDir, "usr", "local", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	binPath := filepath.Join(binDir, "bitswan")
	if err := os.WriteFile(binPath, []byte("CURRENT"), 0o755); err != nil {
		t.Fatal(err)
	}

	// Seed a history row whose artifact is the previous ("roll back to") binary.
	id, err := recordServerUpdate("admin@x", "v1", "v2", []byte("PREVIOUS-BINARY"), false)
	if err != nil {
		t.Fatal(err)
	}

	r := httptest.NewRequest(http.MethodPost, "https://bailey.example.com/bailey/api/admin/server-rollback",
		strings.NewReader(`{"id":`+strconv.FormatInt(id, 10)+`}`))
	r.Host = "bailey.example.com"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Forwarded-Email", "boss@example.com")
	r.Header.Set("X-Forwarded-Groups", adminGrp)
	w := dispatch(r)
	if !strings.Contains(w.Body.String(), "restarting") {
		t.Fatalf("expected a 'restarting' event, got: %s", w.Body.String())
	}
	if got, _ := os.ReadFile(binPath); string(got) != "PREVIOUS-BINARY" {
		t.Errorf("binary after rollback = %q, want the restored artifact", string(got))
	}
	rows, _ := dbListUpdateHistory(updateTargetServer, "", 3)
	if len(rows) == 0 || !rows[0].IsRollback || rows[0].ToVersion != "v1" {
		t.Errorf("rollback not recorded correctly: %+v", rows)
	}
}

// A workspace owner reaches the rollback: ownership passes, the id validates,
// the rollback is recorded, and the redeploy is attempted (it fails in the test
// env with no deployment dir, surfaced as an error event — the handler ran end
// to end).
func TestWorkspaceRollback_OwnerRecordsAndAttemptsRestore(t *testing.T) {
	domain := writeTestConfig(t)
	const ws = "uhrbown"
	owner := "wsowner@example.com"
	host := ws + "-dashboard." + domain
	if _, err := registerEndpoint(host, owner, "", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = deleteEndpoint(host) })

	id, err := recordWorkspaceUpdate(owner, ws, "g1", "g2", "compose-content", false)
	if err != nil {
		t.Fatal(err)
	}

	r := httptest.NewRequest(http.MethodPost, "https://bailey.example.com/bailey/api/workspaces/"+ws+"/rollback",
		strings.NewReader(`{"id":`+strconv.FormatInt(id, 10)+`}`))
	r.Host = "bailey.example.com"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Forwarded-Email", owner)
	w := dispatch(r)

	if !strings.Contains(w.Body.String(), "Rolling back") {
		t.Fatalf("handler did not start the rollback: %s", w.Body.String())
	}
	rows, _ := dbListUpdateHistory(updateTargetWorkspace, ws, 5)
	found := false
	for _, e := range rows {
		if e.IsRollback && e.ToVersion == "g1" {
			found = true
		}
	}
	if !found {
		t.Errorf("workspace rollback was not recorded: %+v", rows)
	}
}

// recordWorkspaceUpdate stores the pre-update compose inline, prunes to depth,
// and the newest row is a valid rollback target.
func TestRecordWorkspaceUpdate_LedgerAndDepth(t *testing.T) {
	const name = "uh-record-ws"
	var last int64
	for i := 1; i <= updateRollbackDepth+1; i++ {
		id, err := recordWorkspaceUpdate("owner@x", name, "g"+strconv.Itoa(i), "g"+strconv.Itoa(i+1),
			"compose-body-"+strconv.Itoa(i), false)
		if err != nil {
			t.Fatal(err)
		}
		last = id
	}
	list, err := dbListUpdateHistory(updateTargetWorkspace, name, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != updateRollbackDepth {
		t.Fatalf("kept %d rows, want %d", len(list), updateRollbackDepth)
	}
	tgt, err := updateHistoryRollbackTarget(last)
	if err != nil || tgt == nil || tgt.TargetName != name {
		t.Fatalf("newest workspace row not a valid rollback target: %+v %v", tgt, err)
	}
	if tgt.Artifact == "" {
		t.Error("workspace rollback artifact (inline compose) should be present")
	}
}

// dbListRecentUpdateHistory caps rows per target so one busy target can't crowd
// the others out of the audit-log view.
func TestListRecentUpdateHistory_PerTargetCap(t *testing.T) {
	for i := 1; i <= updateRollbackDepth+3; i++ {
		if _, err := dbInsertUpdateHistory(updateHistoryEntry{
			TargetKind: updateTargetWorkspace, TargetName: "uh-cap-ws",
			FromVersion: "a", ToVersion: "b", Artifact: "c",
		}); err != nil {
			t.Fatal(err)
		}
	}
	recent, err := dbListRecentUpdateHistory(updateRollbackDepth)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range recent {
		if e.TargetName == "uh-cap-ws" {
			n++
		}
	}
	if n != updateRollbackDepth {
		t.Errorf("uh-cap-ws contributed %d rows, want <= %d per target", n, updateRollbackDepth)
	}
}

func TestVersionFromCLIOutput(t *testing.T) {
	if got := versionFromCLIOutput("bitswan workspaces: v2026.07.31.57"); got != "v2026.07.31.57" {
		t.Errorf("got %q, want v2026.07.31.57", got)
	}
	if got := versionFromCLIOutput("no version token"); got != "no version token" {
		t.Errorf("fallback got %q", got)
	}
}

func TestUpdateTransition(t *testing.T) {
	if got := updateTransition("", "v1", "v2", false); got != "v1 → v2" {
		t.Errorf("server transition = %q", got)
	}
	if got := updateTransition("ws", "v1", "v2", true); got != "ws: rolled back v1 → v2" {
		t.Errorf("workspace rollback transition = %q", got)
	}
}
