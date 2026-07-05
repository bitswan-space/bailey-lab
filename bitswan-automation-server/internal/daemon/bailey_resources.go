package daemon

// Admin Resource Management API (/bailey/api/admin/resources + resource-config).
// Admin-only (gated in bailey_dispatch.go). GET /resources returns the live
// memory budget + per-BP breakdown; GET/POST /resource-config reads/writes the
// heuristic knobs (persisted in server_settings, same store as default-images).

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
)

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

// resourceConfigResponse mirrors memConfig with the per-key provenance so the UI
// can show effective value + whether it's an explicit override.
type resourceConfigResponse struct {
	SystemReserveMB    int `json:"system_reserve_mb"`
	WorkspaceReserveMB int `json:"workspace_reserve_mb"`
	DefaultContainerMB int `json:"default_container_mb"`
	OnDemandFloorMB    int `json:"ondemand_pool_floor_mb"`
	OnDemandTopN       int `json:"ondemand_pool_topn"`
}

func (s *Server) handleResourceConfigGet(w http.ResponseWriter, r *http.Request) {
	cfg := loadMemConfig()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resourceConfigResponse{
		SystemReserveMB:    cfg.SystemReserveMB,
		WorkspaceReserveMB: cfg.WorkspaceReserveMB,
		DefaultContainerMB: cfg.DefaultContainerMB,
		OnDemandFloorMB:    cfg.OnDemandFloorMB,
		OnDemandTopN:       cfg.OnDemandTopN,
	})
}

// setResourceConfigRequest — every field optional; nil leaves the setting alone,
// a value persists an override. Values must be non-negative integers.
type setResourceConfigRequest struct {
	SystemReserveMB    *int `json:"system_reserve_mb,omitempty"`
	WorkspaceReserveMB *int `json:"workspace_reserve_mb,omitempty"`
	DefaultContainerMB *int `json:"default_container_mb,omitempty"`
	OnDemandFloorMB    *int `json:"ondemand_pool_floor_mb,omitempty"`
	OnDemandTopN       *int `json:"ondemand_pool_topn,omitempty"`
}

func (s *Server) handleResourceConfigPost(w http.ResponseWriter, r *http.Request, email string) {
	var req setResourceConfigRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	apply := func(key string, val *int, min int) error {
		if val == nil {
			return nil
		}
		if *val < min {
			return fmt.Errorf("%s must be >= %d", key, min)
		}
		return dbSetSetting(key, strconv.Itoa(*val), email)
	}
	for _, a := range []struct {
		key string
		val *int
		min int
	}{
		{settingMemSystemReserveMB, req.SystemReserveMB, 0},
		{settingMemWorkspaceReserveMB, req.WorkspaceReserveMB, 0},
		{settingMemDefaultContainerMB, req.DefaultContainerMB, 1},
		{settingMemOnDemandFloorMB, req.OnDemandFloorMB, 0},
		{settingMemOnDemandTopN, req.OnDemandTopN, 1},
	} {
		if err := apply(a.key, a.val, a.min); err != nil {
			writeJSONError(w, err.Error(), http.StatusBadRequest)
			return
		}
	}
	s.handleResourceConfigGet(w, r)
}
