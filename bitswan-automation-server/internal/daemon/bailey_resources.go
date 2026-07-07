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

// handleBaileyResources returns the live memory budget for the admin page.
func (s *Server) handleBaileyResources(w http.ResponseWriter, r *http.Request) {
	budget, err := baileyMemGovernor.Budget(r.Context())
	if err != nil {
		writeJSONError(w, fmt.Sprintf("compute memory budget: %v", err), http.StatusInternalServerError)
		return
	}
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
