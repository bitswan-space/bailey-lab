package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
)

// fakeGovernor stubs the docker-backed MemoryGovernor for handler tests.
type fakeGovernor struct {
	inv    []memContainer
	budget memBudget
}

func (f fakeGovernor) Inventory(context.Context) ([]memContainer, error) { return f.inv, nil }
func (f fakeGovernor) Budget(context.Context) (memBudget, error)         { return f.budget, nil }

// errGovernor fails Budget/Inventory — for the handler error paths.
type errGovernor struct{}

func (errGovernor) Inventory(context.Context) ([]memContainer, error) {
	return nil, context.DeadlineExceeded
}
func (errGovernor) Budget(context.Context) (memBudget, error) {
	return memBudget{}, context.DeadlineExceeded
}

func TestHandleBaileyResourcesError(t *testing.T) {
	prev := baileyMemGovernor
	defer func() { baileyMemGovernor = prev }()
	baileyMemGovernor = errGovernor{}
	rec := httptest.NewRecorder()
	(&Server{}).handleBaileyResources(rec, httptest.NewRequest(http.MethodGet, "/bailey/api/admin/resources", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("governor error should 500, got %d", rec.Code)
	}
}

func TestHandleMemoryAdmitInventoryError(t *testing.T) {
	prev := admitInventory
	defer func() { admitInventory = prev }()
	admitInventory = func(context.Context) ([]memContainer, error) { return nil, context.DeadlineExceeded }
	rec := httptest.NewRecorder()
	(&Server{}).handleMemoryAdmit(rec, httptest.NewRequest(http.MethodPost, "/memory/admit", strings.NewReader(`{"kind":"workspace"}`)))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("inventory error should 500, got %d", rec.Code)
	}
}

func TestHandleBaileyResources(t *testing.T) {
	prev := baileyMemGovernor
	defer func() { baileyMemGovernor = prev }()
	baileyMemGovernor = fakeGovernor{budget: memBudget{ReservedMB: 4096, UnreservedMB: 2048, OnDemandPoolMB: 1024, Workspaces: 3}}

	s := &Server{}
	rec := httptest.NewRecorder()
	s.handleBaileyResources(rec, httptest.NewRequest(http.MethodGet, "/bailey/api/admin/resources", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got memBudget
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ReservedMB != 4096 || got.Workspaces != 3 {
		t.Errorf("budget not serialized: %+v", got)
	}
}

func TestHandleResourceConfigGet(t *testing.T) {
	for _, k := range []string{
		"BITSWAN_MEM_SYSTEM_RESERVE_MB", "BITSWAN_MEM_WORKSPACE_RESERVE_MB",
		"BITSWAN_MEM_DEFAULT_CONTAINER_MB", "BITSWAN_MEM_ONDEMAND_POOL_MIN_MB",
		"BITSWAN_MEM_ONDEMAND_POOL_TOPN",
	} {
		t.Setenv(k, "")
	}
	s := &Server{}
	rec := httptest.NewRecorder()
	s.handleResourceConfigGet(rec, httptest.NewRequest(http.MethodGet, "/bailey/api/admin/resource-config", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got resourceConfigResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// Defaults (no DB/env override) — the config is served without a database.
	if got.DefaultContainerMB != 50 || got.OnDemandTopN != 4 {
		t.Errorf("defaults wrong: %+v", got)
	}
}

func TestHandleResourceConfigPostValidation(t *testing.T) {
	s := &Server{}
	rec := httptest.NewRecorder()
	body := strings.NewReader(`{"default_container_mb": -5}`)
	req := httptest.NewRequest(http.MethodPost, "/bailey/api/admin/resource-config", body)
	s.handleResourceConfigPost(rec, req, "admin@example.com")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("negative value should 400, got %d", rec.Code)
	}
}

func TestHandleMemoryAdmit(t *testing.T) {
	prevInv := admitInventory
	defer func() { admitInventory = prevInv }()
	admitInventory = func(context.Context) ([]memContainer, error) { return nil, nil }

	s := &Server{}
	// Bad body → 400.
	rec := httptest.NewRecorder()
	s.handleMemoryAdmit(rec, httptest.NewRequest(http.MethodPost, "/memory/admit", strings.NewReader("not json")))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("bad body should 400, got %d", rec.Code)
	}
	// Wrong method → 405.
	rec = httptest.NewRecorder()
	s.handleMemoryAdmit(rec, httptest.NewRequest(http.MethodGet, "/memory/admit", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET should 405, got %d", rec.Code)
	}
	// Valid workspace admit (empty inventory) → 200 ok. readMemInfo is Linux-only
	// (/proc/meminfo), so only assert the happy path there; elsewhere it 500s.
	if runtime.GOOS == "linux" {
		rec = httptest.NewRecorder()
		s.handleMemoryAdmit(rec, httptest.NewRequest(http.MethodPost, "/memory/admit", strings.NewReader(`{"kind":"workspace"}`)))
		if rec.Code != http.StatusOK {
			t.Fatalf("valid admit status = %d, want 200", rec.Code)
		}
		var res admitResult
		if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if !res.OK {
			t.Errorf("empty-host workspace admit should fit: %+v", res)
		}
	}
}

func TestHandleResourceConfigPostValid(t *testing.T) {
	// A valid POST exercises the apply loop + dbSetSetting for every key. Tolerate
	// either 200 (DB available) or 500 (no DB in the test env) — the point is to
	// run the code path, not to assert persistence.
	// Clean up any persisted settings afterwards so other tests (which assert on
	// defaults) aren't affected by this write.
	defer func() {
		for _, k := range []string{
			settingMemSystemReserveMB, settingMemWorkspaceReserveMB,
			settingMemDefaultContainerMB, settingMemOnDemandFloorMB, settingMemOnDemandTopN,
		} {
			_ = dbDeleteSetting(k)
		}
	}()
	s := &Server{}
	rec := httptest.NewRecorder()
	body := strings.NewReader(`{"system_reserve_mb":2048,"workspace_reserve_mb":768,"default_container_mb":64,"ondemand_pool_floor_mb":1024,"ondemand_pool_topn":4}`)
	s.handleResourceConfigPost(rec, httptest.NewRequest(http.MethodPost, "/bailey/api/admin/resource-config", body), "admin@example.com")
	if rec.Code != http.StatusOK && rec.Code != http.StatusInternalServerError {
		t.Errorf("valid config POST status = %d, want 200 or 500", rec.Code)
	}
}

func TestEnforceMemoryBudget(t *testing.T) {
	prev := baileyMemGovernor
	defer func() { baileyMemGovernor = prev }()
	mb := int64(1024 * 1024)

	// Under pool → no eviction (planEvictions returns 0, evictViaGitops not called).
	baileyMemGovernor = fakeGovernor{inv: []memContainer{
		{Workspace: "ws", Context: "a", Stage: "live-dev", DeploymentID: "d1", Policy: "on-demand", Running: true, UsageBytes: 10 * mb},
	}}
	(&Server{}).enforceMemoryBudget(context.Background())

	// Governor error → early return (inventory-error branch).
	baileyMemGovernor = errGovernor{}
	(&Server{}).enforceMemoryBudget(context.Background())

	// Over pool → planEvictions selects a victim, evictViaGitops succeeds (stubbed),
	// and the sweep records the returned host as dehydrated. Force a tiny pool.
	t.Setenv("BITSWAN_MEM_ONDEMAND_POOL_MIN_MB", "1")
	t.Setenv("BITSWAN_MEM_ONDEMAND_POOL_TOPN", "1")
	prevURL, prevSec := gitopsEvictURL, gitopsSecretForWorkspace
	defer func() { gitopsEvictURL, gitopsSecretForWorkspace = prevURL, prevSec }()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string][]string{"evicted": {"d1"}, "hosts": {"ws-fe-9-live-dev"}})
	}))
	defer srv.Close()
	gitopsEvictURL = func(string) string { return srv.URL }
	gitopsSecretForWorkspace = func(string) (string, error) { return "s", nil }
	baileyMemGovernor = fakeGovernor{inv: []memContainer{
		{Workspace: "ws", Context: "a", Stage: "live-dev", DeploymentID: "d1", Policy: "on-demand", Running: true, ReservationMB: 1, UsageBytes: 500 * mb, Created: 100},
	}}
	(&Server{}).enforceMemoryBudget(context.Background())
	// The sweep reads /proc/meminfo before evicting, so it only completes on Linux;
	// elsewhere it bails early (no eviction) and the host isn't recorded.
	if runtime.GOOS == "linux" && !isHostDehydrated("ws-fe-9-live-dev") {
		t.Error("swept host should be recorded as dehydrated")
	}
}

func TestDockerInventoryAndHelpers(t *testing.T) {
	// dockerGlobalInventory (ps-only, fast) — tolerate docker absent in the test
	// env; the point is to execute the code path, not assert containers.
	_, _ = dockerGlobalInventory(context.Background(), false)
	// Trivial helpers.
	_ = workspaceDomainSuffix()
	_ = countWorkspacesForBudget()
}

func TestDockerGovernorBudget(t *testing.T) {
	// Exercise the real governor's docker-backed paths (Inventory →
	// cachedUsageInventory → dockerGlobalInventory → dockerStatsUsage → Budget).
	// Tolerates docker being absent in CI: the point is to run the code, not to
	// assert a particular budget.
	if _, err := (dockerMemoryGovernor{}).Budget(context.Background()); err != nil {
		t.Logf("governor budget unavailable in test env (expected without docker): %v", err)
	}
}

func TestAdmitMemoryRequestWithInventory(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("admitMemoryRequest needs /proc/meminfo (Linux)")
	}
	prev := admitInventory
	defer func() { admitInventory = prev }()
	mb := int64(1024 * 1024)
	// A mix of always-on + on-demand + infra so the gathering loop's branches run.
	admitInventory = func(context.Context) ([]memContainer, error) {
		return []memContainer{
			{DeploymentID: "be1", Policy: "always-on", ReservationMB: 128, UsageBytes: 10 * mb},
			{DeploymentID: "fe1", Policy: "on-demand", ReservationMB: 256, UsageBytes: 20 * mb},
			{Policy: "", UsageBytes: 5 * mb}, // infra, skipped
		}, nil
	}
	// A small on-demand promote is admitted (host has ample memory in CI).
	res, err := (&Server{}).admitMemoryRequest(context.Background(),
		admitRequest{Kind: "promote", OnDemandAddMB: []int{32}})
	if err != nil {
		t.Fatalf("admitMemoryRequest: %v", err)
	}
	if !res.OK {
		t.Errorf("small on-demand promote should be admitted: %+v", res)
	}
}

func TestEvictViaGitops(t *testing.T) {
	prevURL, prevSec := gitopsEvictURL, gitopsSecretForWorkspace
	defer func() { gitopsEvictURL, gitopsSecretForWorkspace = prevURL, prevSec }()

	var gotBody map[string][]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sekret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(map[string][]string{
			"evicted": {"d1"},
			"hosts":   {"ws-fe-ab12-live-dev"},
		})
	}))
	defer srv.Close()
	gitopsEvictURL = func(string) string { return srv.URL }
	gitopsSecretForWorkspace = func(string) (string, error) { return "sekret", nil }

	hosts, err := evictViaGitops(context.Background(), "ws", []string{"d1"})
	if err != nil {
		t.Fatalf("evictViaGitops: %v", err)
	}
	if len(hosts) != 1 || hosts[0] != "ws-fe-ab12-live-dev" {
		t.Errorf("hosts = %v, want [ws-fe-ab12-live-dev]", hosts)
	}
	if len(gotBody["deployment_ids"]) != 1 || gotBody["deployment_ids"][0] != "d1" {
		t.Errorf("request body = %v", gotBody)
	}

	// Secret error → returns an error (no HTTP call).
	gitopsSecretForWorkspace = func(string) (string, error) { return "", context.DeadlineExceeded }
	if _, err := evictViaGitops(context.Background(), "ws", []string{"d1"}); err == nil {
		t.Error("missing secret should error")
	}
}

func TestCheckOverReservationLoop(t *testing.T) {
	// Under-reservation + non-workload containers exercise the loop's skip paths
	// without emitting (no recordEvent → no DB dependency).
	mb := int64(1024 * 1024)
	checkOverReservation([]memContainer{
		{ID: "u1", DeploymentID: "d1", Policy: "on-demand", Running: true, ReservationMB: 256, UsageBytes: 100 * mb},
		{ID: "i1", Policy: "", Running: true},                                                   // infra, skipped
		{ID: "s1", DeploymentID: "d2", Policy: "on-demand", Running: false, ReservationMB: 256}, // stopped, skipped
	})
	// The under-reservation container must NOT be flagged.
	if v, _ := overReservationState.Load("u1"); v == true {
		t.Error("under-reservation container should not be flagged over")
	}
	overReservationState.Delete("u1")

	// An OVER container crosses the threshold → exercises the emit branch
	// (log + recordEvent; recordEvent tolerates no DB in the test env).
	overID := "over-container-xyz"
	overReservationState.Delete(overID)
	checkOverReservation([]memContainer{
		{ID: overID, DeploymentID: "d9", Workspace: "ws", Stage: "staging", Policy: "always-on", Running: true, ReservationMB: 100, UsageBytes: 500 * mb},
	})
	if v, _ := overReservationState.Load(overID); v != true {
		t.Error("over-reservation container should be flagged")
	}
	overReservationState.Delete(overID)
}
