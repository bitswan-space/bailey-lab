package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
	// Valid workspace admit (empty inventory, /proc/meminfo real) → 200 ok.
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

func TestEnforceMemoryBudget(t *testing.T) {
	prev := baileyMemGovernor
	defer func() { baileyMemGovernor = prev }()
	mb := int64(1024 * 1024)

	// Under pool → no eviction (planEvictions returns 0, evictViaGitops not called).
	baileyMemGovernor = fakeGovernor{inv: []memContainer{
		{Workspace: "ws", Context: "a", Stage: "live-dev", DeploymentID: "d1", Policy: "on-demand", Running: true, UsageBytes: 10 * mb},
	}}
	(&Server{}).enforceMemoryBudget(context.Background())

	// Over pool → planEvictions selects a victim; evictViaGitops runs (and fails to
	// reach gitops in the test env, exercising its error path). Force a tiny pool.
	t.Setenv("BITSWAN_MEM_ONDEMAND_POOL_MIN_MB", "1")
	t.Setenv("BITSWAN_MEM_ONDEMAND_POOL_TOPN", "1")
	baileyMemGovernor = fakeGovernor{inv: []memContainer{
		{Workspace: "ws", Context: "a", Stage: "live-dev", DeploymentID: "d1", Policy: "on-demand", Running: true, ReservationMB: 1, UsageBytes: 500 * mb, Created: 100},
	}}
	(&Server{}).enforceMemoryBudget(context.Background()) // must not panic
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
}
