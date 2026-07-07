package daemon

// Memory governance: the daemon is the single accountant for host memory. It has
// unrestricted docker access (unlike the per-workspace driver), so it holds the
// global view needed to (a) show the admin Resource page, (b) admit/reject
// promotes + workspace-creates against a reserved budget, and (c) evict on-demand
// containers under pressure. See the MemoryGovernor interface for the k8s-swap
// seam: Inventory→metrics-server, Budget→quota math, on a future backend.
//
// Model (all MB unless noted):
//
//	T   host total memory (readMemInfo)
//	S   system reserve                       (BITSWAN_MEM_SYSTEM_RESERVE_MB)
//	W   per-workspace infra reserve          (BITSWAN_MEM_WORKSPACE_RESERVE_MB)
//	Ns  number of workspaces
//	Σa  Σ reservation of always-on containers (gitops.mem_policy=always-on)
//	P   on-demand pool = max(floor, sum of the N largest on-demand reservations)
//	R   = S + Ns*W + Σa + P   (total reserved; must not exceed T)
//	U   = T - R               (elastic headroom; where on-demand runs)

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// --- configuration (env override > built-in default) ---
//
// These are PLATFORM-tuning knobs, not user settings: they resolve from an env
// var (for deployment tuning) or a built-in default. There is deliberately no
// admin-editable / persisted layer — the product is tuned so it works, rather
// than exposing memory policy for users to change.

// memConfig is the resolved heuristic budget knobs.
type memConfig struct {
	SystemReserveMB    int
	WorkspaceReserveMB int
	DefaultContainerMB int
	OnDemandFloorMB    int
	OnDemandTopN       int
}

// memConfigInt resolves one knob: the env var if set (and valid), else the
// built-in default. Invalid values fall through to the default.
func memConfigInt(envKey string, dflt int) int {
	if v := strings.TrimSpace(os.Getenv(envKey)); v != "" {
		if n, perr := strconv.Atoi(v); perr == nil && n >= 0 {
			return n
		}
	}
	return dflt
}

func loadMemConfig() memConfig {
	return memConfig{
		SystemReserveMB:    memConfigInt("BITSWAN_MEM_SYSTEM_RESERVE_MB", 2048),
		WorkspaceReserveMB: memConfigInt("BITSWAN_MEM_WORKSPACE_RESERVE_MB", 768),
		DefaultContainerMB: memConfigInt("BITSWAN_MEM_DEFAULT_CONTAINER_MB", 50),
		OnDemandFloorMB:    memConfigInt("BITSWAN_MEM_ONDEMAND_POOL_MIN_MB", 1024),
		OnDemandTopN:       max(1, memConfigInt("BITSWAN_MEM_ONDEMAND_POOL_TOPN", 4)),
	}
}

// --- inventory ---

// memContainer is one bitswan-managed container's memory-relevant facts, read
// from docker ps labels + docker stats. Non-gitops host containers (keycloak,
// the daemon itself, …) are excluded — the system reserve S covers those.
type memContainer struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Workspace     string `json:"workspace"`
	BP            string `json:"bp"`
	Stage         string `json:"stage"`
	DeploymentID  string `json:"deployment_id"`
	Context       string `json:"context"`
	Policy        string `json:"policy"`         // "always-on" | "on-demand" | "" (infra)
	ReservationMB int    `json:"reservation_mb"` // 0 for infra (no gitops.mem_policy)
	UsageBytes    int64  `json:"usage_bytes"`
	Created       int64  `json:"created"`
	Running       bool   `json:"running"`
}

// IsWorkload reports whether this is an automation deployment (carries a
// gitops.deployment_id) vs workspace infra (gitops/dashboard/driver/gateways —
// no deployment_id; covered by the per-workspace reserve W). Keyed on
// deployment_id, NOT the policy label, so deployments that predate the label
// still count (they default to on-demand — the model's default).
func (c memContainer) IsWorkload() bool { return c.DeploymentID != "" }

// memInvSep separates the lean docker-ps fields (unit separator).
const memInvSep = "\x1f"

// dockerGlobalInventory lists every bitswan-managed container across ALL
// workspaces (the daemon is not tenant-scoped) with its labels. When withUsage is
// set it also joins live memory from `docker stats` — which is SLOW at scale
// (a per-container sample), so the admission gates skip it (they only need
// reservations, read from labels). Isolated here so business logic (computeBudget
// / admit) stays docker-free and unit-testable.
func dockerGlobalInventory(ctx context.Context, withUsage bool) ([]memContainer, error) {
	format := "{{.ID}}" + memInvSep + "{{.State}}" + memInvSep + "{{.CreatedAt}}" +
		memInvSep + "{{.Names}}" + memInvSep + "{{.Labels}}"
	out, err := exec.CommandContext(ctx, "docker", "ps", "--all", "--no-trunc", "--format", format).Output()
	if err != nil {
		return nil, fmt.Errorf("docker ps: %w", err)
	}
	conts := parseMemInventory(out)

	if withUsage {
		// Join live memory usage for running containers (best-effort).
		if usage, uerr := dockerStatsUsage(ctx); uerr == nil {
			for i := range conts {
				if b, ok := usage[conts[i].ID]; ok {
					conts[i].UsageBytes = b
				}
			}
		}
	}
	return conts, nil
}

// cachedInventory memoizes the (slow) with-usage inventory for a short window so
// the admin page and the eviction sweep don't each pay the docker stats cost.
var (
	invCacheMu   sync.Mutex
	invCacheData []memContainer
	invCacheAt   time.Time
)

const invCacheTTL = 30 * time.Second

func cachedUsageInventory(ctx context.Context) ([]memContainer, error) {
	invCacheMu.Lock()
	defer invCacheMu.Unlock()
	if invCacheData != nil && time.Since(invCacheAt) < invCacheTTL {
		return invCacheData, nil
	}
	inv, err := dockerGlobalInventory(ctx, true)
	if err != nil {
		return nil, err
	}
	invCacheData, invCacheAt = inv, time.Now()
	return inv, nil
}

// parseMemInventory maps the lean ps output into memContainer, keeping only
// bitswan-managed containers (those carrying a gitops.workspace label). Split out
// for unit-testing without a daemon.
func parseMemInventory(raw []byte) []memContainer {
	var conts []memContainer
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.Split(line, memInvSep)
		if len(f) != 5 {
			continue
		}
		labels := parseMemLabels(f[4])
		ws := labels["gitops.workspace"]
		if ws == "" {
			continue // not a bitswan-managed container; system reserve covers it
		}
		var created int64
		if t, terr := time.Parse("2006-01-02 15:04:05 -0700 MST", f[2]); terr == nil {
			created = t.Unix()
		}
		resMB := 0
		if v, ok := labels["gitops.mem_reservation_mb"]; ok {
			resMB, _ = strconv.Atoi(v)
		}
		conts = append(conts, memContainer{
			ID:            f[0],
			Name:          strings.TrimPrefix(firstMemField(f[3], ","), "/"),
			Workspace:     ws,
			BP:            labels["gitops.bp"],
			Stage:         labels["gitops.stage"],
			DeploymentID:  labels["gitops.deployment_id"],
			Context:       labels["gitops.context"],
			Policy:        labels["gitops.mem_policy"],
			ReservationMB: resMB,
			Created:       created,
			Running:       f[1] == "running",
		})
	}
	return conts
}

func parseMemLabels(s string) map[string]string {
	out := map[string]string{}
	if s == "" {
		return out
	}
	for _, kv := range strings.Split(s, ",") {
		if k, v, ok := strings.Cut(kv, "="); ok {
			out[k] = v
		}
	}
	return out
}

func firstMemField(s, sep string) string {
	if i := strings.Index(s, sep); i >= 0 {
		return s[:i]
	}
	return s
}

// dockerStatsUsage returns id→memory-bytes for all running containers.
func dockerStatsUsage(ctx context.Context) (map[string]int64, error) {
	out, err := exec.CommandContext(ctx, "docker", "stats", "--no-stream", "--no-trunc",
		"--format", "{{.ID}}"+memInvSep+"{{.MemUsage}}").Output()
	if err != nil {
		return nil, fmt.Errorf("docker stats: %w", err)
	}
	return parseStatsUsage(out), nil
}

func parseStatsUsage(raw []byte) map[string]int64 {
	usage := map[string]int64{}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		id, mem, ok := strings.Cut(line, memInvSep)
		if !ok {
			continue
		}
		usage[id] = parseMemBytes(mem)
	}
	return usage
}

// parseMemBytes parses docker stats "123.4MiB / 2GiB" (or bare "123.4MiB") to
// bytes using the value before "/". 0 on failure.
func parseMemBytes(s string) int64 {
	usage := strings.TrimSpace(firstMemField(s, "/"))
	i := 0
	for i < len(usage) && (usage[i] >= '0' && usage[i] <= '9' || usage[i] == '.') {
		i++
	}
	if i == 0 {
		return 0
	}
	num, err := strconv.ParseFloat(usage[:i], 64)
	if err != nil {
		return 0
	}
	var mult float64
	switch strings.TrimSpace(usage[i:]) {
	case "B", "":
		mult = 1
	case "kB", "KB":
		mult = 1e3
	case "KiB":
		mult = 1024
	case "MB":
		mult = 1e6
	case "MiB":
		mult = 1024 * 1024
	case "GB":
		mult = 1e9
	case "GiB":
		mult = 1024 * 1024 * 1024
	case "TB":
		mult = 1e12
	case "TiB":
		mult = 1024 * 1024 * 1024 * 1024
	default:
		mult = 1
	}
	return int64(num * mult)
}

// --- budget (pure) ---

// bpMem is a per-(workspace,bp,stage) roll-up for the admin page.
type bpMem struct {
	Workspace     string `json:"workspace"`
	BP            string `json:"bp"`
	Stage         string `json:"stage"`
	Policy        string `json:"policy"`
	ReservationMB int    `json:"reservation_mb"`
	UsageBytes    int64  `json:"usage_bytes"`
	Running       bool   `json:"running"`
	Containers    int    `json:"containers"`
	Over          bool   `json:"over_reservation"`
	// Asleep: this (bp, stage) group is DEPLOYED (in the workspace's bitswan.yaml)
	// but has no running containers — it was slept/evicted to zero. Surfaced so the
	// admin page can list sleeping BPs (with a Wake action), not just running ones.
	Asleep bool `json:"asleep"`
}

// memBudget is the computed accounting model + breakdowns (the admin DTO).
type memBudget struct {
	HostTotalBytes int64 `json:"host_total_bytes"`
	HostAvailBytes int64 `json:"host_avail_bytes"`

	SystemReserveMB    int `json:"system_reserve_mb"`
	WorkspaceReserveMB int `json:"workspace_reserve_mb"`
	Workspaces         int `json:"workspaces"`
	// Read-only platform knobs, surfaced so the admin page can show the budget's
	// inputs. Tuned via env / built-in defaults — NOT user-configurable.
	DefaultContainerMB int `json:"default_container_mb"`
	OnDemandFloorMB    int `json:"ondemand_pool_floor_mb"`
	OnDemandTopN       int `json:"ondemand_pool_topn"`
	AlwaysOnMB         int `json:"always_on_mb"`      // Σa
	OnDemandPoolMB     int `json:"ondemand_pool_mb"`  // P
	ReservedMB         int `json:"reserved_mb"`       // R
	UnreservedMB       int `json:"unreserved_mb"`     // T - R (may be <0 = overcommitted)
	OnDemandUsageMB    int `json:"ondemand_usage_mb"` // actual on-demand memory in use

	Pressure bool     `json:"pressure"`
	ByBP     []bpMem  `json:"by_bp"`
	Warnings []string `json:"warnings,omitempty"`
}

// onDemandPoolMB sizes the on-demand pool: at least the floor, and always big
// enough to run the N largest on-demand services simultaneously so a big service
// can't be starved. Growing it is what makes a large on-demand promote consume
// reserved memory (and possibly be rejected).
func onDemandPoolMB(onDemandReservations []int, floorMB, topN int) int {
	sorted := append([]int(nil), onDemandReservations...)
	sort.Sort(sort.Reverse(sort.IntSlice(sorted)))
	sum := 0
	for i := 0; i < len(sorted) && i < topN; i++ {
		sum += sorted[i]
	}
	if sum > floorMB {
		return sum
	}
	return floorMB
}

// computeBudget is the PURE accountant: inventory + host memory + workspace count
// + config → the model. No docker, no I/O — unit-testable.
func computeBudget(inv []memContainer, hostTotal, hostAvail uint64, workspaces int, cfg memConfig) memBudget {
	b := memBudget{
		HostTotalBytes:     int64(hostTotal),
		HostAvailBytes:     int64(hostAvail),
		SystemReserveMB:    cfg.SystemReserveMB,
		WorkspaceReserveMB: cfg.WorkspaceReserveMB,
		Workspaces:         workspaces,
		DefaultContainerMB: cfg.DefaultContainerMB,
		OnDemandFloorMB:    cfg.OnDemandFloorMB,
		OnDemandTopN:       cfg.OnDemandTopN,
	}

	var onDemandRes []int
	groups := map[string]*bpMem{}
	var onDemandUsage int64
	for _, c := range inv {
		if c.IsWorkload() {
			if c.Policy == "always-on" {
				b.AlwaysOnMB += c.ReservationMB
			} else {
				onDemandRes = append(onDemandRes, c.ReservationMB)
				onDemandUsage += c.UsageBytes
			}
		}
		// Roll up per (workspace, bp, stage) for the page — workload only.
		if !c.IsWorkload() {
			continue
		}
		key := c.Workspace + "\x00" + c.BP + "\x00" + c.Stage
		g := groups[key]
		if g == nil {
			g = &bpMem{Workspace: c.Workspace, BP: c.BP, Stage: c.Stage, Policy: c.Policy}
			groups[key] = g
		}
		g.ReservationMB += c.ReservationMB
		g.UsageBytes += c.UsageBytes
		g.Containers++
		if c.Running {
			g.Running = true
		}
		// A group is "over" if its actual usage exceeds its reservation.
		if g.UsageBytes > int64(g.ReservationMB)*1024*1024 {
			g.Over = true
		}
	}

	b.OnDemandPoolMB = onDemandPoolMB(onDemandRes, cfg.OnDemandFloorMB, cfg.OnDemandTopN)
	b.OnDemandUsageMB = int(onDemandUsage / (1024 * 1024))
	b.ReservedMB = cfg.SystemReserveMB + workspaces*cfg.WorkspaceReserveMB + b.AlwaysOnMB + b.OnDemandPoolMB
	b.UnreservedMB = int(hostTotal/(1024*1024)) - b.ReservedMB

	if b.UnreservedMB < 0 {
		b.Pressure = true
		b.Warnings = append(b.Warnings, fmt.Sprintf(
			"overcommitted: reserved %d MB exceeds host %d MB by %d MB",
			b.ReservedMB, int(hostTotal/(1024*1024)), -b.UnreservedMB))
	}
	// Pressure also when actual free memory has dropped into the reserved pool.
	availMB := int(hostAvail / (1024 * 1024))
	if availMB < b.OnDemandPoolMB {
		b.Pressure = true
	}

	b.ByBP = make([]bpMem, 0, len(groups))
	for _, g := range groups {
		b.ByBP = append(b.ByBP, *g)
	}
	sort.Slice(b.ByBP, func(i, j int) bool {
		if b.ByBP[i].Workspace != b.ByBP[j].Workspace {
			return b.ByBP[i].Workspace < b.ByBP[j].Workspace
		}
		if b.ByBP[i].BP != b.ByBP[j].BP {
			return b.ByBP[i].BP < b.ByBP[j].BP
		}
		return b.ByBP[i].Stage < b.ByBP[j].Stage
	})
	return b
}

// --- admission (pure) ---

// admitRequest asks whether an action fits the reserved budget. For a promote,
// AlwaysOnAddMB is the summed reservation of always-on members (grows Σa) and
// OnDemandAddMB lists each on-demand member's reservation (may grow the pool).
type admitRequest struct {
	Kind          string `json:"kind"` // "workspace" | "promote"
	AlwaysOnAddMB int    `json:"always_on_add_mb,omitempty"`
	OnDemandAddMB []int  `json:"ondemand_add_mb,omitempty"`
}

type admitResult struct {
	OK          bool   `json:"ok"`
	ShortfallMB int    `json:"shortfall_mb,omitempty"`
	Detail      string `json:"detail,omitempty"`
}

// admitMemory decides whether the action fits within host memory. Only actions
// that add ALWAYS-ON reserved memory (a workspace's infra, an always-on promote)
// or GROW the on-demand pool (a large on-demand promote) can be rejected —
// small on-demand promotes never grow the pool, so unlimited rarely-used BPs are
// always allowed. Pure (no docker/I/O) for unit-testing.
func admitMemory(b memBudget, currentOnDemand []int, cfg memConfig, req admitRequest) admitResult {
	totalMB := int(b.HostTotalBytes / (1024 * 1024))
	freeMB := totalMB - b.ReservedMB
	switch req.Kind {
	case "workspace":
		if b.ReservedMB+cfg.WorkspaceReserveMB > totalMB {
			return admitResult{ShortfallMB: b.ReservedMB + cfg.WorkspaceReserveMB - totalMB,
				Detail: fmt.Sprintf("a new workspace reserves %d MB of always-on memory but only %d MB is unreserved",
					cfg.WorkspaceReserveMB, freeMB)}
		}
		return admitResult{OK: true}
	case "promote":
		newPool := onDemandPoolMB(append(append([]int{}, currentOnDemand...), req.OnDemandAddMB...),
			cfg.OnDemandFloorMB, cfg.OnDemandTopN)
		poolDelta := newPool - b.OnDemandPoolMB
		if poolDelta < 0 {
			poolDelta = 0
		}
		addMB := req.AlwaysOnAddMB + poolDelta
		if b.ReservedMB+addMB > totalMB {
			return admitResult{ShortfallMB: b.ReservedMB + addMB - totalMB,
				Detail: fmt.Sprintf("this promotion needs %d MB more reserved memory but only %d MB is unreserved",
					addMB, freeMB)}
		}
		return admitResult{OK: true}
	}
	return admitResult{OK: true}
}

// --- over-reservation detection (SIEM + log) ---

// overReservationState debounces the SIEM event per container so it fires once on
// crossing INTO the exceeded state, not every sweep. Keyed by container ID (a
// redeploy is a new ID → re-evaluated).
var overReservationState sync.Map

// overReservationTransition records the new over/under state for a container and
// returns true only when it just crossed INTO the over state (so the SIEM event
// fires once per crossing, not every sweep). Pure state machine (unit-testable).
func overReservationTransition(id string, over bool) bool {
	prev, _ := overReservationState.Load(id)
	wasOver, _ := prev.(bool)
	if over && !wasOver {
		overReservationState.Store(id, true)
		return true
	}
	if !over && wasOver {
		overReservationState.Store(id, false)
	}
	return false
}

// checkOverReservation emits a SIEM event + log the first time a running
// container's actual memory crosses above its reservation. Cheap; runs each sweep.
func checkOverReservation(inv []memContainer) {
	for _, c := range inv {
		if !c.IsWorkload() || !c.Running || c.ReservationMB <= 0 || c.ID == "" {
			continue
		}
		over := c.UsageBytes > int64(c.ReservationMB)*1024*1024
		if overReservationTransition(c.ID, over) {
			detail := fmt.Sprintf("%s (%s/%s): %d MB used > %d MB reserved",
				c.DeploymentID, c.Workspace, c.Stage, c.UsageBytes/(1024*1024), c.ReservationMB)
			log.Printf("memory: container over reservation: %s", detail)
			_ = recordEvent("", auditMemOverReservation, detail)
		}
	}
}

// --- governor interface (the k8s-swap seam) ---

// MemoryGovernor is the memory backend. The docker implementation reads
// docker ps/stats; a future k8s implementation would read metrics-server and
// express reservations as Pod requests. Business logic (the admin page, admission
// gates, the eviction sweep) depends only on this interface + the pure model.
type MemoryGovernor interface {
	Inventory(ctx context.Context) ([]memContainer, error)
	Budget(ctx context.Context) (memBudget, error)
}

type dockerMemoryGovernor struct {
	// countWorkspaces is injectable for tests; nil → the real workspace list.
	countWorkspaces func() int
}

func (g dockerMemoryGovernor) Inventory(ctx context.Context) ([]memContainer, error) {
	// The page + sweep want live usage; served from a short-TTL cache so the
	// slow docker stats cost is paid at most once per window.
	return cachedUsageInventory(ctx)
}

func (g dockerMemoryGovernor) Budget(ctx context.Context) (memBudget, error) {
	inv, err := g.Inventory(ctx)
	if err != nil {
		return memBudget{}, err
	}
	total, avail, err := readMemInfo()
	if err != nil {
		return memBudget{}, err
	}
	ns := 0
	if g.countWorkspaces != nil {
		ns = g.countWorkspaces()
	} else {
		ns = countWorkspacesForBudget()
	}
	return computeBudget(inv, total, avail, ns, loadMemConfig()), nil
}

// countWorkspacesForBudget counts live (non-trashed) workspaces for the Ns*W term.
func countWorkspacesForBudget() int {
	resp, err := GetWorkspaceList(false, false)
	if err != nil || resp == nil {
		return 0
	}
	return len(resp.Workspaces)
}

// --- active eviction sweep ---

// dehydratedOnDemandHosts records on-demand ingress hosts the sweep has shut down
// (host → time). The gate consults it (isDehydratableHost) so a request to such a
// host shows the loading page + wakes, exactly like dev/live-dev. Entries expire
// so a host that comes back doesn't linger as "dehydrated" forever.
var dehydratedOnDemandHosts sync.Map

const dehydratedHostTTL = 30 * time.Minute

// isHostDehydrated reports whether host was shut down by the memory sweep (and
// hasn't expired). Used to widen the gate's wake-on-access to on-demand
// staging/production, which have no "-dev" suffix.
func isHostDehydrated(host string) bool {
	h := toOuterHost(strings.ToLower(host))
	v, ok := dehydratedOnDemandHosts.Load(h)
	if !ok {
		return false
	}
	if time.Since(v.(time.Time)) > dehydratedHostTTL {
		dehydratedOnDemandHosts.Delete(h)
		return false
	}
	return true
}

// planEvictions is the PURE eviction planner: given the inventory and the
// on-demand pool size (bytes), it returns the deployment ids to evict grouped by
// workspace, the victim-instance count, and the current on-demand usage. Nothing
// is shed while running on-demand memory fits the pool. Victims are whole
// instances (workspace, context, stage), oldest-first by earliest container
// Created, until the projected usage fits. Unit-testable (no docker/I/O).
func planEvictions(inv []memContainer, poolBytes int64) (map[string][]string, int, int64) {
	var onDemandUsage int64
	for _, c := range inv {
		if c.IsWorkload() && c.Policy != "always-on" && c.Running {
			onDemandUsage += c.UsageBytes
		}
	}
	if onDemandUsage <= poolBytes {
		return nil, 0, onDemandUsage
	}
	type instance struct {
		ws      string
		depIDs  []string
		usage   int64
		created int64
	}
	insts := map[string]*instance{}
	order := []string{} // stable insertion order for deterministic ties
	for _, c := range inv {
		if !c.IsWorkload() || c.Policy == "always-on" || !c.Running {
			continue
		}
		key := c.Workspace + "\x00" + c.Context + "\x00" + c.Stage
		in := insts[key]
		if in == nil {
			in = &instance{ws: c.Workspace, created: c.Created}
			insts[key] = in
			order = append(order, key)
		}
		in.depIDs = append(in.depIDs, c.DeploymentID)
		in.usage += c.UsageBytes
		if c.Created > 0 && (in.created == 0 || c.Created < in.created) {
			in.created = c.Created
		}
	}
	ordered := make([]*instance, 0, len(insts))
	for _, k := range order {
		ordered = append(ordered, insts[k])
	}
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].created < ordered[j].created })

	projected := onDemandUsage
	byWorkspace := map[string][]string{}
	victims := 0
	for _, in := range ordered {
		if projected <= poolBytes {
			break
		}
		byWorkspace[in.ws] = append(byWorkspace[in.ws], in.depIDs...)
		projected -= in.usage
		victims++
	}
	return byWorkspace, victims, onDemandUsage
}

// enforceMemoryBudget is the 5-minute sweep: keep the RUNNING on-demand set's
// actual memory within the on-demand pool P, evicting the oldest on-demand
// instances (globally, across workspaces) so always-on services keep their
// reserved memory. Always-on + infra are never touched; evicted instances wake
// on next access. Also emits over-reservation SIEM events (see checkOverReservation).
func (s *Server) enforceMemoryBudget(ctx context.Context) {
	inv, err := baileyMemGovernor.Inventory(ctx)
	if err != nil {
		log.Printf("memory sweep: inventory failed: %v", err)
		return
	}
	total, avail, err := readMemInfo()
	if err != nil {
		log.Printf("memory sweep: readMemInfo failed: %v", err)
		return
	}
	cfg := loadMemConfig()
	b := computeBudget(inv, total, avail, countWorkspacesForBudget(), cfg)

	checkOverReservation(inv)

	poolBytes := int64(b.OnDemandPoolMB) * 1024 * 1024
	byWorkspace, victims, onDemandUsage := planEvictions(inv, poolBytes)
	if victims == 0 {
		return
	}
	log.Printf("memory sweep: on-demand usage %d MB > pool %d MB; evicting %d instance(s)",
		onDemandUsage/(1024*1024), b.OnDemandPoolMB, victims)
	for ws, ids := range byWorkspace {
		hosts, err := evictViaGitops(ctx, ws, ids)
		if err != nil {
			log.Printf("memory sweep: evict in workspace %q failed: %v", ws, err)
			continue
		}
		now := time.Now()
		for _, h := range hosts {
			dehydratedOnDemandHosts.Store(toOuterHost(strings.ToLower(h+"."+workspaceDomainSuffix())), now)
			dehydratedOnDemandHosts.Store(strings.ToLower(h), now)
		}
	}
}

// workspaceDomainSuffix is a best-effort domain for building a full host key; the
// sweep also stores the bare label, so an exact-suffix match isn't required.
func workspaceDomainSuffix() string {
	return strings.TrimSpace(os.Getenv("BITSWAN_DOMAIN"))
}

// evictViaGitops asks a workspace's gitops to evict the given on-demand
// deployments (mark inactive + remove) and returns their ingress hosts. Mirrors
// the daemon→gitops call in triggerLiveDevWake (internal address + gitops secret).
// gitopsEvictURL + gitopsSecretForWorkspace are package vars so tests can point
// them at an httptest server + a stub secret.
var gitopsEvictURL = func(ws string) string {
	return fmt.Sprintf("http://%s-gitops:8079/automations/evict-ephemeral", ws)
}

var gitopsSecretForWorkspace = func(ws string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return getGitOpsSecret(ws, filepath.Join(home, ".config", "bitswan", "workspaces"))
}

func evictViaGitops(ctx context.Context, ws string, deploymentIDs []string) ([]string, error) {
	secret, err := gitopsSecretForWorkspace(ws)
	if err != nil || secret == "" {
		return nil, fmt.Errorf("gitops secret for %q: %v", ws, err)
	}
	body, _ := json.Marshal(map[string][]string{"deployment_ids": deploymentIDs})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, gitopsEvictURL(ws), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 120 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("gitops evict %s: %s", resp.Status, strings.TrimSpace(string(b)))
	}
	var out struct {
		Evicted []string `json:"evicted"`
		Hosts   []string `json:"hosts"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out.Hosts, nil
}
