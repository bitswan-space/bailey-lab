package daemon

import "testing"

func TestComputeBudgetStagePolicy(t *testing.T) {
	cfg := memConfig{SystemReserveMB: 2048, WorkspaceReserveMB: 768, DefaultContainerMB: 50, OnDemandFloorMB: 1024, OnDemandTopN: 4}
	mib := uint64(16384) * 1024 * 1024
	inv := []memContainer{
		{DeploymentID: "be-staging", Workspace: "ws", BP: "bp", Stage: "staging", Policy: "always-on", ReservationMB: 400, Running: true},
		{DeploymentID: "fe-staging", Workspace: "ws", BP: "bp", Stage: "staging", Policy: "on-demand", ReservationMB: 100, Running: true},
		{DeploymentID: "be-dev", Workspace: "ws", BP: "bp", Stage: "dev", Policy: "always-on", ReservationMB: 200, Running: true},
		{DeploymentID: "fe-ld", Workspace: "ws", BP: "bp2", Stage: "live-dev", Policy: "on-demand", ReservationMB: 300, Running: true},
	}
	b := computeBudget(inv, mib, mib, 1, cfg)

	if b.AlwaysOnMB != 600 {
		t.Errorf("total AlwaysOnMB = %d, want 600 (400+200)", b.AlwaysOnMB)
	}
	byStage := map[string]bpMem{}
	for _, g := range b.ByBP {
		byStage[g.Stage] = g
	}
	if g := byStage["staging"]; g.Policy != "mixed" || g.AlwaysOnMB != 400 || g.ReservationMB != 500 {
		t.Errorf("staging stage = %+v; want policy=mixed always_on=400 reserved=500", g)
	}
	if g := byStage["dev"]; g.Policy != "always-on" || g.AlwaysOnMB != 200 {
		t.Errorf("dev stage = %+v; want policy=always-on always_on=200", g)
	}
	if g := byStage["live-dev"]; g.Policy != "on-demand" || g.AlwaysOnMB != 0 {
		t.Errorf("live-dev stage = %+v; want policy=on-demand always_on=0", g)
	}

	sumRows := 0
	for _, g := range b.ByBP {
		sumRows += g.AlwaysOnMB
	}
	if sumRows != b.AlwaysOnMB {
		t.Errorf("per-stage always_on rows sum to %d but total AlwaysOnMB is %d — table must reconcile with the summary", sumRows, b.AlwaysOnMB)
	}
}
