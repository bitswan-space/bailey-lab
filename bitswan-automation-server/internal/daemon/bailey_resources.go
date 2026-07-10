package daemon

// Admin Resource Management API (GET /bailey/api/admin/resources) + the internal
// /memory/admit gate. Admin-only (gated in bailey_dispatch.go). The reservation
// knobs are platform-tuned (env / defaults) and surfaced read-only inside the
// /resources payload — there is deliberately no setter endpoint.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

// admitMemoryRequest gathers the live budget + current on-demand reservations and
// runs the pure admit check. Used by the workspace-create gate (in-process) and
// the /memory/admit endpoint (gitops promote gate).
// admitInventory gathers the reservation-only inventory for admission. A package
// var so tests can stub the docker dependency.
var admitInventory = func(ctx context.Context) ([]memContainer, error) {
	// Admission only needs RESERVATIONS (from labels via docker ps), never live
	// usage — so skip the slow docker stats sample to keep the gate fast.
	return dockerGlobalInventory(ctx, false)
}

func (s *Server) admitMemoryRequest(ctx context.Context, req admitRequest) (admitResult, error) {
	inv, err := admitInventory(ctx)
	if err != nil {
		return admitResult{}, err
	}
	total, avail, err := readMemInfo()
	if err != nil {
		return admitResult{}, err
	}
	cfg := loadMemConfig()
	b := computeBudget(inv, total, avail, countWorkspacesForBudget(), cfg)
	var onDemand []int
	for _, c := range inv {
		if c.IsWorkload() && c.Policy != "always-on" {
			onDemand = append(onDemand, c.ReservationMB)
		}
	}
	return admitMemory(b, onDemand, cfg, req), nil
}

// handleMemoryAdmit is the internal (trusted, socket-auth) endpoint gitops calls
// to gate a promote against the reserved budget. POST admitRequest → admitResult.
func (s *Server) handleMemoryAdmit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req admitRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	res, err := s.admitMemoryRequest(r.Context(), req)
	if err != nil {
		writeJSONError(w, fmt.Sprintf("admit: %v", err), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(res)
}

// baileyMemGovernor is the daemon's memory backend. A package var (not a Server
// field) so it can be swapped in tests; defaults to the docker implementation.
var baileyMemGovernor MemoryGovernor = dockerMemoryGovernor{}

// desiredGroup is one (bp, stage) deployment group a workspace's gitops knows
// about (from its bitswan.yaml). Used to surface SLEPT groups — deployed but
// running zero containers — which the docker-inventory budget can't see.
type desiredGroup struct {
	BP            string `json:"bp"`
	Stage         string `json:"stage"`
	Policy        string `json:"policy"`
	ReservationMB int    `json:"reservation_mb"`
}

// gitopsMemGroupsURL / desiredGroupsForWorkspace are package vars so tests can
// point them at an httptest server + stub secret (mirrors evictViaGitops).
var gitopsMemGroupsURL = func(ws string) string {
	return fmt.Sprintf("http://%s-gitops:8079/automations/mem-groups", ws)
}

var desiredGroupsForWorkspace = func(ctx context.Context, ws string) ([]desiredGroup, error) {
	secret, err := gitopsSecretForWorkspace(ws)
	if err != nil || secret == "" {
		return nil, fmt.Errorf("gitops secret for %q: %v", ws, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, gitopsMemGroupsURL(ws), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("mem-groups %s: HTTP %d", ws, resp.StatusCode)
	}
	var out []desiredGroup
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

// mergeAsleepGroups appends asleep rows to the budget: (workspace, bp, stage)
// groups a workspace has DEPLOYED but that have zero containers in the running
// inventory (slept to nothing). Best-effort per workspace — an old gitops
// without the endpoint (or an unreachable one) is simply skipped.
func mergeAsleepGroups(ctx context.Context, b *memBudget) {
	resp, err := GetWorkspaceList(false, false)
	if err != nil || resp == nil {
		return
	}
	present := map[string]bool{} // any (ws,bp,stage) that has containers
	for _, g := range b.ByBP {
		present[g.Workspace+"\x00"+g.BP+"\x00"+g.Stage] = true
	}
	added := false
	for _, ws := range resp.Workspaces {
		groups, err := desiredGroupsForWorkspace(ctx, ws.Name)
		if err != nil {
			continue
		}
		for _, dg := range groups {
			if present[ws.Name+"\x00"+dg.BP+"\x00"+dg.Stage] {
				continue // it has containers → shown as running, not asleep
			}
			b.ByBP = append(b.ByBP, bpMem{
				Workspace: ws.Name, BP: dg.BP, Stage: dg.Stage, Policy: dg.Policy,
				ReservationMB: dg.ReservationMB, Running: false, Asleep: true,
			})
			present[ws.Name+"\x00"+dg.BP+"\x00"+dg.Stage] = true
			added = true
		}
	}
	if added {
		sort.Slice(b.ByBP, func(i, j int) bool {
			if b.ByBP[i].Workspace != b.ByBP[j].Workspace {
				return b.ByBP[i].Workspace < b.ByBP[j].Workspace
			}
			if b.ByBP[i].BP != b.ByBP[j].BP {
				return b.ByBP[i].BP < b.ByBP[j].BP
			}
			return b.ByBP[i].Stage < b.ByBP[j].Stage
		})
	}
}

// handleBaileyResources returns the live memory budget for the admin page —
// running usage from the docker inventory, plus asleep (deployed-but-zero) rows
// merged in so sleeping BPs are visible (with a Wake action) too.
func (s *Server) handleBaileyResources(w http.ResponseWriter, r *http.Request) {
	budget, err := baileyMemGovernor.Budget(r.Context())
	if err != nil {
		writeJSONError(w, fmt.Sprintf("compute memory budget: %v", err), http.StatusInternalServerError)
		return
	}
	mergeAsleepGroups(r.Context(), &budget)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(budget)
}

// resourcesSleepRequest targets the sleep. An empty filter (or All) sleeps every
// on-demand workload; otherwise it narrows to a single (workspace, bp, stage) row
// from the admin table. Always-on workloads are ALWAYS skipped (a no-op), so
// "sleep all" can never take down a service the operator marked always-on.
type resourcesSleepRequest struct {
	Workspace string `json:"workspace"`
	BP        string `json:"bp"`
	Stage     string `json:"stage"`
	All       bool   `json:"all"`
}

// handleBaileyResourcesSleep puts on-demand business-process containers to sleep
// (evict + mark inactive; they wake on next access). Reuses the same
// inventory→evictViaGitops path as the 5-minute pressure sweep, but is operator-
// triggered from the Resource page instead of budget-driven. Always-on workloads
// and workspace infra are never touched.
func (s *Server) handleBaileyResourcesSleep(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req resourcesSleepRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	// Reservations-only inventory (labels via `docker ps`); sleep needs the
	// policy + deployment_id labels, never the slow docker-stats sample.
	// admitInventory is the same reservations-only source (a package var so
	// tests can stub the docker dependency).
	inv, err := admitInventory(r.Context())
	if err != nil {
		writeJSONError(w, fmt.Sprintf("inventory: %v", err), http.StatusInternalServerError)
		return
	}
	// A targeted sleep is an EXACT (workspace, bp, stage) match — stage "" is the
	// production row, not "any stage" — so a per-row Sleep never over-sleeps a
	// BP's other stages. `all` sleeps every on-demand workload instead.
	if !req.All && (req.Workspace == "" || req.BP == "") {
		writeJSONError(w, "workspace and bp are required unless all=true", http.StatusBadRequest)
		return
	}
	byWorkspace := map[string][]string{}
	bps := map[string]bool{}
	for _, c := range inv {
		if !c.IsWorkload() || !c.Running || c.Policy == "always-on" {
			continue // infra, stopped, and always-on are never slept
		}
		if !req.All && (c.Workspace != req.Workspace || c.BP != req.BP || c.Stage != req.Stage) {
			continue
		}
		byWorkspace[c.Workspace] = append(byWorkspace[c.Workspace], c.DeploymentID)
		bps[c.Workspace+"\x00"+c.BP] = true
	}
	slept := 0
	var hosts []string
	var errs []string
	for ws, ids := range byWorkspace {
		h, err := evictViaGitops(r.Context(), ws, ids)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", ws, err))
			continue
		}
		slept += len(ids)
		hosts = append(hosts, h...)
		// Record the dehydrated hosts so the gate serves wake-on-access (identical
		// to the pressure sweep) — otherwise a slept BP wouldn't wake on next hit.
		now := time.Now()
		for _, host := range h {
			dehydratedOnDemandHosts.Store(toOuterHost(strings.ToLower(host+"."+workspaceDomainSuffix())), now)
			dehydratedOnDemandHosts.Store(strings.ToLower(host), now)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"slept":  slept,
		"bps":    len(bps),
		"hosts":  hosts,
		"errors": errs,
	})
}
