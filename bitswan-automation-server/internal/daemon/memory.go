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
	"context"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"
)

// --- configuration (admin-editable settings > env > default) ---

const (
	settingMemSystemReserveMB    = "mem.system_reserve_mb"
	settingMemWorkspaceReserveMB = "mem.workspace_reserve_mb"
	settingMemDefaultContainerMB = "mem.default_container_mb"
	settingMemOnDemandFloorMB    = "mem.ondemand_pool_floor_mb"
	settingMemOnDemandTopN       = "mem.ondemand_pool_topn"
)

// memConfig is the resolved heuristic budget knobs.
type memConfig struct {
	SystemReserveMB    int
	WorkspaceReserveMB int
	DefaultContainerMB int
	OnDemandFloorMB    int
	OnDemandTopN       int
}

// memConfigInt resolves one knob: the admin-set DB setting wins, else the env
// var, else the built-in default. Invalid values fall through to the default.
func memConfigInt(settingKey, envKey string, dflt int) int {
	if v, err := dbGetSetting(settingKey); err == nil && strings.TrimSpace(v) != "" {
		if n, perr := strconv.Atoi(strings.TrimSpace(v)); perr == nil && n >= 0 {
			return n
		}
	}
	if v := strings.TrimSpace(os.Getenv(envKey)); v != "" {
		if n, perr := strconv.Atoi(v); perr == nil && n >= 0 {
			return n
		}
	}
	return dflt
}

func loadMemConfig() memConfig {
	return memConfig{
		SystemReserveMB:    memConfigInt(settingMemSystemReserveMB, "BITSWAN_MEM_SYSTEM_RESERVE_MB", 2048),
		WorkspaceReserveMB: memConfigInt(settingMemWorkspaceReserveMB, "BITSWAN_MEM_WORKSPACE_RESERVE_MB", 768),
		DefaultContainerMB: memConfigInt(settingMemDefaultContainerMB, "BITSWAN_MEM_DEFAULT_CONTAINER_MB", 50),
		OnDemandFloorMB:    memConfigInt(settingMemOnDemandFloorMB, "BITSWAN_MEM_ONDEMAND_POOL_MIN_MB", 1024),
		OnDemandTopN:       max(1, memConfigInt(settingMemOnDemandTopN, "BITSWAN_MEM_ONDEMAND_POOL_TOPN", 4)),
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

// IsWorkload reports whether this is an automation deployment (carries a memory
// policy) vs workspace infra (gitops/dashboard/driver/gateways, no policy — its
// cost is covered by the per-workspace reserve W).
func (c memContainer) IsWorkload() bool { return c.Policy != "" }

// memInvSep separates the lean docker-ps fields (unit separator).
const memInvSep = "\x1f"

// dockerGlobalInventory lists every bitswan-managed container across ALL
// workspaces (the daemon is not tenant-scoped) with its labels, then joins live
// memory from `docker stats`. Isolated here so business logic (computeBudget /
// admit) stays docker-free and unit-testable.
func dockerGlobalInventory(ctx context.Context) ([]memContainer, error) {
	format := "{{.ID}}" + memInvSep + "{{.State}}" + memInvSep + "{{.CreatedAt}}" +
		memInvSep + "{{.Names}}" + memInvSep + "{{.Labels}}"
	out, err := exec.CommandContext(ctx, "docker", "ps", "--all", "--no-trunc", "--format", format).Output()
	if err != nil {
		return nil, fmt.Errorf("docker ps: %w", err)
	}
	conts := parseMemInventory(out)

	// Join live memory usage for running containers.
	usage, err := dockerStatsUsage(ctx)
	if err == nil {
		for i := range conts {
			if b, ok := usage[conts[i].ID]; ok {
				conts[i].UsageBytes = b
			}
		}
	}
	return conts, nil
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
}

// memBudget is the computed accounting model + breakdowns (the admin DTO).
type memBudget struct {
	HostTotalBytes int64 `json:"host_total_bytes"`
	HostAvailBytes int64 `json:"host_avail_bytes"`

	SystemReserveMB    int `json:"system_reserve_mb"`
	WorkspaceReserveMB int `json:"workspace_reserve_mb"`
	Workspaces         int `json:"workspaces"`
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
	return dockerGlobalInventory(ctx)
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
