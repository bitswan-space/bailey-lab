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
