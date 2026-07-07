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

func TestBudgetSurfacesReadOnlyKnobs(t *testing.T) {
	// The reservation knobs are surfaced read-only inside the budget DTO (no
	// setter endpoint). computeBudget must copy them from the config.
	cfg := memConfig{SystemReserveMB: 2048, WorkspaceReserveMB: 768, DefaultContainerMB: 50, OnDemandFloorMB: 1024, OnDemandTopN: 4}
	b := computeBudget(nil, uint64(8192)*1024*1024, uint64(8192)*1024*1024, 1, cfg)
	if b.DefaultContainerMB != 50 || b.OnDemandFloorMB != 1024 || b.OnDemandTopN != 4 {
		t.Errorf("read-only knobs not surfaced in budget: %+v", b)
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

// TestHandleBaileyResourcesSleep covers the operator-triggered sleep endpoint:
// on-demand workloads are slept, always-on / infra / stopped are skipped, a
// targeted (workspace,bp,stage) match is exact, and inputs are validated.
func TestHandleBaileyResourcesSleep(t *testing.T) {
	prevInv := admitInventory
	prevURL, prevSec := gitopsEvictURL, gitopsSecretForWorkspace
	defer func() { admitInventory = prevInv; gitopsEvictURL = prevURL; gitopsSecretForWorkspace = prevSec }()

	admitInventory = func(context.Context) ([]memContainer, error) {
		return []memContainer{
			{Workspace: "ws", BP: "orders", Stage: "live-dev", DeploymentID: "d-od", Context: "a", Policy: "on-demand", Running: true},
			{Workspace: "ws", BP: "billing", Stage: "", DeploymentID: "d-ao", Context: "b", Policy: "always-on", Running: true},
			{Workspace: "ws", BP: "orders", Stage: "live-dev", DeploymentID: "", Context: "a", Policy: "on-demand", Running: true}, // infra: no dep id
			{Workspace: "ws", BP: "stale", Stage: "dev", DeploymentID: "d-stopped", Policy: "on-demand", Running: false},
		}, nil
	}
	var gotIDs []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			DeploymentIDs []string `json:"deployment_ids"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotIDs = append(gotIDs, body.DeploymentIDs...)
		_ = json.NewEncoder(w).Encode(map[string][]string{"evicted": body.DeploymentIDs, "hosts": {"ws-fe-live-dev"}})
	}))
	defer srv.Close()
	gitopsEvictURL = func(string) string { return srv.URL }
	gitopsSecretForWorkspace = func(string) (string, error) { return "s", nil }

	post := func(body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		(&Server{}).handleBaileyResourcesSleep(rec, httptest.NewRequest(http.MethodPost, "/bailey/api/admin/resources/sleep", strings.NewReader(body)))
		return rec
	}

	// all=true → only the on-demand WORKLOAD (d-od); always-on, infra, stopped skipped.
	gotIDs = nil
	rec := post(`{"all":true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("all: code %d body %s", rec.Code, rec.Body.String())
	}
	if len(gotIDs) != 1 || gotIDs[0] != "d-od" {
		t.Fatalf("all: expected only [d-od], got %v", gotIDs)
	}
	var res struct{ Slept, BPs int }
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	if res.Slept != 1 {
		t.Errorf("all: slept=%d, want 1", res.Slept)
	}

	// Targeted exact (ws, orders, live-dev) → same single victim.
	gotIDs = nil
	if rec := post(`{"workspace":"ws","bp":"orders","stage":"live-dev"}`); rec.Code != http.StatusOK || len(gotIDs) != 1 || gotIDs[0] != "d-od" {
		t.Fatalf("targeted: code %d ids %v", rec.Code, gotIDs)
	}

	// Targeting the always-on BP is a no-op (nothing evicted).
	gotIDs = nil
	if rec := post(`{"workspace":"ws","bp":"billing","stage":""}`); rec.Code != http.StatusOK || len(gotIDs) != 0 {
		t.Fatalf("always-on target should sleep nothing, code %d ids %v", rec.Code, gotIDs)
	}

	// Validation: not all + missing bp → 400. Method guard: GET → 405.
	if rec := post(`{"workspace":"ws"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("missing bp: code=%d want 400", rec.Code)
	}
	rec = httptest.NewRecorder()
	(&Server{}).handleBaileyResourcesSleep(rec, httptest.NewRequest(http.MethodGet, "/bailey/api/admin/resources/sleep", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET: code=%d want 405", rec.Code)
	}
}
