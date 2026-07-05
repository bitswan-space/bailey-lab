package daemon

import "testing"

func TestOnDemandPoolMB(t *testing.T) {
	// Floor wins when services are small.
	if got := onDemandPoolMB([]int{50, 50, 50}, 1024, 4); got != 1024 {
		t.Errorf("floor: got %d, want 1024", got)
	}
	// Sum of the top-N wins when a big service appears (pool grows).
	if got := onDemandPoolMB([]int{2000, 1500, 100, 100, 100}, 1024, 4); got != 3700 {
		t.Errorf("topN grow: got %d, want 3700 (2000+1500+100+100)", got)
	}
	// A single huge on-demand service alone exceeds the floor.
	if got := onDemandPoolMB([]int{4096}, 1024, 4); got != 4096 {
		t.Errorf("single big: got %d, want 4096", got)
	}
	if got := onDemandPoolMB(nil, 1024, 4); got != 1024 {
		t.Errorf("empty: got %d, want 1024", got)
	}
}

func TestComputeBudget(t *testing.T) {
	mb := int64(1024 * 1024)
	cfg := memConfig{SystemReserveMB: 2048, WorkspaceReserveMB: 768, DefaultContainerMB: 50, OnDemandFloorMB: 1024, OnDemandTopN: 4}
	inv := []memContainer{
		// always-on backend using MORE than its reservation → over-reservation.
		{Workspace: "ws", BP: "billing", Stage: "staging", Policy: "always-on", ReservationMB: 256, UsageBytes: 300 * mb, Running: true},
		// on-demand staging
		{Workspace: "ws", BP: "reports", Stage: "staging", Policy: "on-demand", ReservationMB: 512, UsageBytes: 100 * mb, Running: true},
		// live-dev (on-demand)
		{Workspace: "ws", BP: "reports", Stage: "live-dev", Policy: "on-demand", ReservationMB: 128, UsageBytes: 40 * mb, Running: true},
		// infra container (no policy) — excluded from Σa/pool, no per-BP row
		{Workspace: "ws", Policy: "", ReservationMB: 0, UsageBytes: 200 * mb, Running: true},
	}
	// host 16 GiB total, 8 GiB available, 2 workspaces
	b := computeBudget(inv, uint64(16*1024)*uint64(mb), uint64(8*1024)*uint64(mb), 2, cfg)

	if b.AlwaysOnMB != 256 {
		t.Errorf("AlwaysOnMB = %d, want 256", b.AlwaysOnMB)
	}
	// pool = max(1024, 512+128) = 1024
	if b.OnDemandPoolMB != 1024 {
		t.Errorf("OnDemandPoolMB = %d, want 1024", b.OnDemandPoolMB)
	}
	// R = 2048 + 2*768 + 256 + 1024 = 4864
	if b.ReservedMB != 4864 {
		t.Errorf("ReservedMB = %d, want 4864", b.ReservedMB)
	}
	// U = 16384 - 4864 = 11520
	if b.UnreservedMB != 11520 {
		t.Errorf("UnreservedMB = %d, want 11520", b.UnreservedMB)
	}
	if b.Pressure {
		t.Errorf("Pressure should be false with ample headroom")
	}
	// per-BP over-reservation: billing/staging used 300MB > 256MB reserved.
	var billing *bpMem
	for i := range b.ByBP {
		if b.ByBP[i].BP == "billing" {
			billing = &b.ByBP[i]
		}
	}
	if billing == nil || !billing.Over {
		t.Errorf("billing/staging should be flagged over-reservation: %+v", billing)
	}
	// infra container must not create a per-BP row (3 workload groups only).
	if len(b.ByBP) != 3 {
		t.Errorf("ByBP groups = %d, want 3 (infra excluded)", len(b.ByBP))
	}
}

func TestComputeBudgetOvercommit(t *testing.T) {
	cfg := memConfig{SystemReserveMB: 2048, WorkspaceReserveMB: 768, DefaultContainerMB: 50, OnDemandFloorMB: 1024, OnDemandTopN: 4}
	// Tiny host: reserved will exceed total → overcommit + pressure.
	b := computeBudget(nil, uint64(2048)*1024*1024, uint64(2048)*1024*1024, 1, cfg)
	// R = 2048 + 768 + 0 + 1024 = 3840 > 2048
	if !b.Pressure {
		t.Errorf("expected pressure on overcommit")
	}
	if b.UnreservedMB >= 0 {
		t.Errorf("expected negative unreserved, got %d", b.UnreservedMB)
	}
	if len(b.Warnings) == 0 {
		t.Errorf("expected an overcommit warning")
	}
}

func TestParseMemInventory(t *testing.T) {
	sep := memInvSep
	raw := []byte(
		"aaa" + sep + "running" + sep + "2026-07-04 08:28:27 +0000 UTC" + sep + "wraptest-frontend-x-staging" + sep +
			"gitops.workspace=wraptest,gitops.bp=shop,gitops.stage=staging,gitops.deployment_id=frontend-shop-staging,gitops.mem_policy=always-on,gitops.mem_reservation_mb=256\n" +
			// non-gitops container → skipped
			"bbb" + sep + "running" + sep + "2026-07-04 08:28:27 +0000 UTC" + sep + "some-random" + sep + "foo=bar\n",
	)
	conts := parseMemInventory(raw)
	if len(conts) != 1 {
		t.Fatalf("want 1 bitswan container, got %d", len(conts))
	}
	c := conts[0]
	if c.Workspace != "wraptest" || c.BP != "shop" || c.Stage != "staging" {
		t.Errorf("labels not parsed: %+v", c)
	}
	if c.Policy != "always-on" || c.ReservationMB != 256 {
		t.Errorf("policy/reservation not parsed: %+v", c)
	}
	if !c.Running || !c.IsWorkload() {
		t.Errorf("running/workload wrong: %+v", c)
	}
}

func TestParseMemBytes(t *testing.T) {
	cases := map[string]int64{
		"200MiB / 2GiB": 200 * 1024 * 1024,
		"1GiB / 4GiB":   1024 * 1024 * 1024,
		"512MiB":        512 * 1024 * 1024,
		"-- / --":       0,
		"":              0,
	}
	for in, want := range cases {
		if got := parseMemBytes(in); got != want {
			t.Errorf("parseMemBytes(%q) = %d, want %d", in, got, want)
		}
	}
}
