package daemon

import (
	"strings"
	"testing"
	"time"
)

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
		{Workspace: "ws", BP: "billing", Stage: "staging", DeploymentID: "be-billing-staging", Policy: "always-on", ReservationMB: 256, UsageBytes: 300 * mb, Running: true},
		// on-demand staging
		{Workspace: "ws", BP: "reports", Stage: "staging", DeploymentID: "be-reports-staging", Policy: "on-demand", ReservationMB: 512, UsageBytes: 100 * mb, Running: true},
		// live-dev (on-demand)
		{Workspace: "ws", BP: "reports", Stage: "live-dev", DeploymentID: "be-reports-livedev", Policy: "on-demand", ReservationMB: 128, UsageBytes: 40 * mb, Running: true},
		// infra container (no deployment_id) — excluded from Σa/pool, no per-BP row
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
			"bbb" + sep + "running" + sep + "2026-07-04 08:28:27 +0000 UTC" + sep + "some-random" + sep + "foo=bar\n" +
			// malformed (wrong field count) → skipped
			"ccc" + sep + "running\n" +
			// bad CreatedAt → kept, created stays 0
			"ddd" + sep + "running" + sep + "not-a-date" + sep + "x" + sep + "gitops.workspace=w2,gitops.deployment_id=d\n",
	)
	conts := parseMemInventory(raw)
	// Two valid gitops containers kept (shop + the bad-date one); the non-gitops
	// and malformed-field lines are skipped.
	if len(conts) != 2 {
		t.Fatalf("want 2 bitswan containers, got %d", len(conts))
	}
	var c *memContainer
	for i := range conts {
		if conts[i].Workspace == "wraptest" {
			c = &conts[i]
		}
	}
	if c == nil {
		t.Fatalf("wraptest container not found: %+v", conts)
	}
	if c.BP != "shop" || c.Stage != "staging" {
		t.Errorf("labels not parsed: %+v", c)
	}
	if c.Policy != "always-on" || c.ReservationMB != 256 {
		t.Errorf("policy/reservation not parsed: %+v", c)
	}
	if !c.Running || !c.IsWorkload() {
		t.Errorf("running/workload wrong: %+v", c)
	}
}

func TestAdmitMemory(t *testing.T) {
	mib := int64(1024 * 1024)
	cfg := memConfig{SystemReserveMB: 2048, WorkspaceReserveMB: 768, DefaultContainerMB: 50, OnDemandFloorMB: 1024, OnDemandTopN: 4}
	// Host 8 GiB, currently reserved 4864 MB (from the TestComputeBudget scenario).
	b := memBudget{HostTotalBytes: int64(8*1024) * mib, ReservedMB: 4864, OnDemandPoolMB: 1024, AlwaysOnMB: 256}
	onDemand := []int{512, 128}

	// Workspace fits (4864 + 768 = 5632 <= 8192).
	if r := admitMemory(b, onDemand, cfg, admitRequest{Kind: "workspace"}); !r.OK {
		t.Errorf("workspace should fit: %+v", r)
	}
	// A small on-demand promote never grows the pool → always allowed.
	if r := admitMemory(b, onDemand, cfg, admitRequest{Kind: "promote", OnDemandAddMB: []int{64}}); !r.OK {
		t.Errorf("small on-demand promote should be allowed: %+v", r)
	}
	// An always-on promote that fits.
	if r := admitMemory(b, onDemand, cfg, admitRequest{Kind: "promote", AlwaysOnAddMB: 1000}); !r.OK {
		t.Errorf("always-on promote of 1000 should fit (4864+1000<=8192): %+v", r)
	}
	// An always-on promote that does NOT fit (4864 + 4000 = 8864 > 8192).
	r := admitMemory(b, onDemand, cfg, admitRequest{Kind: "promote", AlwaysOnAddMB: 4000})
	if r.OK || r.ShortfallMB != 8864-8192 {
		t.Errorf("always-on promote of 4000 should be rejected with shortfall 672: %+v", r)
	}
	// Unknown kind → permissive default (OK).
	if r := admitMemory(b, onDemand, cfg, admitRequest{Kind: "other"}); !r.OK {
		t.Errorf("unknown kind should default OK: %+v", r)
	}
	// Workspace on a tiny host that can't fit the infra reserve → rejected.
	tiny := memBudget{HostTotalBytes: int64(1024) * mib, ReservedMB: 900}
	if r := admitMemory(tiny, nil, cfg, admitRequest{Kind: "workspace"}); r.OK || r.ShortfallMB <= 0 {
		t.Errorf("workspace on a full host should be rejected with shortfall: %+v", r)
	}
	// A HUGE on-demand promote grows the pool past capacity → rejected.
	// new pool = max(1024, sum top4 of [512,128,7000]) = 7640; delta = 6616;
	// 4864 + 6616 = 11480 > 8192.
	r2 := admitMemory(b, onDemand, cfg, admitRequest{Kind: "promote", OnDemandAddMB: []int{7000}})
	if r2.OK {
		t.Errorf("huge on-demand promote should be rejected (pool grows past host): %+v", r2)
	}
}

func TestPlanEvictions(t *testing.T) {
	mb := int64(1024 * 1024)
	// Pool = 200 MB. Running on-demand: instance A (old, 150MB) + B (new, 150MB) =
	// 300MB > 200MB → evict the oldest (A) until projected (150) <= pool.
	inv := []memContainer{
		{Workspace: "ws", Context: "a", Stage: "live-dev", DeploymentID: "fe-a", Policy: "on-demand", Running: true, Created: 100, UsageBytes: 100 * mb},
		{Workspace: "ws", Context: "a", Stage: "live-dev", DeploymentID: "be-a", Policy: "on-demand", Running: true, Created: 100, UsageBytes: 50 * mb},
		{Workspace: "ws", Context: "b", Stage: "live-dev", DeploymentID: "fe-b", Policy: "on-demand", Running: true, Created: 200, UsageBytes: 150 * mb},
		// always-on never evicted
		{Workspace: "ws", Context: "c", Stage: "staging", DeploymentID: "be-c", Policy: "always-on", Running: true, Created: 1, UsageBytes: 400 * mb},
	}
	byWs, victims, usage := planEvictions(inv, 200*mb)
	if usage != 300*mb {
		t.Errorf("on-demand usage = %d, want %d", usage/mb, 300)
	}
	if victims != 1 {
		t.Fatalf("victims = %d, want 1 (oldest instance A)", victims)
	}
	got := byWs["ws"]
	if len(got) != 2 {
		t.Fatalf("evicted deps = %v, want both of instance A", got)
	}
	// Must be instance A's deployments, never the always-on be-c.
	for _, d := range got {
		if d == "be-c" {
			t.Errorf("evicted an always-on deployment: %v", got)
		}
	}
	// Under pool → nothing evicted.
	if _, v, _ := planEvictions(inv, 400*mb); v != 0 {
		t.Errorf("under pool should evict nothing, got %d", v)
	}
}

func TestOverReservationTransition(t *testing.T) {
	id := "test-dep-xyz"
	overReservationState.Delete(id)
	if !overReservationTransition(id, true) {
		t.Error("first crossing into over should fire")
	}
	if overReservationTransition(id, true) {
		t.Error("staying over should NOT re-fire (debounce)")
	}
	if overReservationTransition(id, false) {
		t.Error("dropping under should not fire")
	}
	if !overReservationTransition(id, true) {
		t.Error("re-crossing into over should fire again")
	}
	overReservationState.Delete(id)
}

func TestIsHostDehydrated(t *testing.T) {
	host := "wraptest-frontend-ab12-staging.example.com"
	if isHostDehydrated(host) {
		t.Error("unknown host should not be dehydrated")
	}
	dehydratedOnDemandHosts.Store(toOuterHost(strings.ToLower(host)), time.Now())
	if !isHostDehydrated(host) {
		t.Error("recorded host should be dehydrated")
	}
	// Expired entry is dropped.
	dehydratedOnDemandHosts.Store(toOuterHost(strings.ToLower(host)), time.Now().Add(-2*dehydratedHostTTL))
	if isHostDehydrated(host) {
		t.Error("expired host should not be dehydrated")
	}
}

func TestMemConfigDefaults(t *testing.T) {
	// memConfigInt prefers a DB setting over env — clear any persisted overrides
	// (e.g. from a config-POST test) so this is deterministic.
	for _, k := range []string{
		settingMemSystemReserveMB, settingMemWorkspaceReserveMB,
		settingMemDefaultContainerMB, settingMemOnDemandFloorMB, settingMemOnDemandTopN,
	} {
		_ = dbDeleteSetting(k)
	}
	for _, k := range []string{
		"BITSWAN_MEM_SYSTEM_RESERVE_MB", "BITSWAN_MEM_WORKSPACE_RESERVE_MB",
		"BITSWAN_MEM_DEFAULT_CONTAINER_MB", "BITSWAN_MEM_ONDEMAND_POOL_MIN_MB",
		"BITSWAN_MEM_ONDEMAND_POOL_TOPN",
	} {
		t.Setenv(k, "")
	}
	// Env override wins over the default.
	t.Setenv("BITSWAN_MEM_DEFAULT_CONTAINER_MB", "128")
	if got := memConfigInt(settingMemDefaultContainerMB, "BITSWAN_MEM_DEFAULT_CONTAINER_MB", 50); got != 128 {
		t.Errorf("env override = %d, want 128", got)
	}
	// Invalid env falls back to default.
	t.Setenv("BITSWAN_MEM_ONDEMAND_POOL_TOPN", "notanint")
	if got := memConfigInt(settingMemOnDemandTopN, "BITSWAN_MEM_ONDEMAND_POOL_TOPN", 4); got != 4 {
		t.Errorf("invalid env should fall back to 4, got %d", got)
	}
}

func TestParseStatsUsage(t *testing.T) {
	raw := []byte("aaaa\x1f200MiB / 2GiB\nbbbb\x1f50MiB / 2GiB\nno-separator-line\n\n")
	u := parseStatsUsage(raw)
	if u["aaaa"] != 200*1024*1024 || u["bbbb"] != 50*1024*1024 {
		t.Errorf("parseStatsUsage = %v", u)
	}
	if len(u) != 2 {
		t.Errorf("want 2 entries, got %d", len(u))
	}
}

func TestParseMemBytes(t *testing.T) {
	cases := map[string]int64{
		"200MiB / 2GiB": 200 * 1024 * 1024,
		"1GiB / 4GiB":   1024 * 1024 * 1024,
		"512MiB":        512 * 1024 * 1024,
		"2KiB / 1GiB":   2 * 1024,
		"4KB / 1GB":     4 * 1000,
		"3GB / 8GB":     3 * 1000 * 1000 * 1000,
		"1TiB / 2TiB":   1024 * 1024 * 1024 * 1024,
		"5TB / 10TB":    5 * 1000 * 1000 * 1000 * 1000,
		"100B / 1GiB":   100,
		"1.2.3MiB":      0, // unparseable number → 0
		"-- / --":       0,
		"":              0,
	}
	for in, want := range cases {
		if got := parseMemBytes(in); got != want {
			t.Errorf("parseMemBytes(%q) = %d, want %d", in, got, want)
		}
	}
}
