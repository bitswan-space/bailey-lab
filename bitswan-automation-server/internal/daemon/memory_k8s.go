package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/bitswan-space/bitswan-workspaces/internal/k8sctl"
	"github.com/bitswan-space/bitswan-workspaces/internal/k8srender"
)

// The memory backend for a namespace.
//
// The business logic — the admin page, the admission gate, the eviction sweep —
// depends only on MemoryGovernor and the pure model, so all that is needed here
// is where the two numbers come from. Both answers differ from Docker's in a
// way that matters:
//
// The inventory is the namespace's own pods, not every container on a host. A
// Bailey in a namespace shares its node with things that are none of its
// business, and counting them would make the budget somebody else's.
//
// The budget is what the namespace is ALLOWED, not what the node has. Reading
// /proc/meminfo in a pod reports the node's memory, so a Bailey with a 4 GB
// quota on a 256 GB node would believe it had 256 GB and admit workloads until
// the quota killed them. A ResourceQuota is the honest number; without one,
// there is no limit to report and the model is told so rather than guessing.
type k8sMemoryGovernor struct {
	namespace       string
	countWorkspaces func() int
}

func (g k8sMemoryGovernor) ns() string {
	if g.namespace != "" {
		return g.namespace
	}
	n, err := k8sctl.Namespace()
	if err != nil {
		return ""
	}
	return n
}

func (g k8sMemoryGovernor) Inventory(ctx context.Context) ([]memContainer, error) {
	pods, err := k8sctl.ListPods(ctx)
	if err != nil {
		return nil, fmt.Errorf("list pods: %w", err)
	}
	usage, _ := k8sctl.PodMemoryUsage(ctx) // best-effort: no metrics-server, no usage

	out := make([]memContainer, 0, len(pods))
	for _, p := range pods {
		labels := p.Labels
		c := memContainer{
			ID:           p.Name,
			Name:         labels[k8srender.ContainerNameLabel],
			Workspace:    labels[k8srender.WorkspaceLabel],
			BP:           labels["gitops.bp"],
			Stage:        labels["gitops.stage"],
			Context:      labels["gitops.context"],
			DeploymentID: p.Annotations["gitops.bitswan.io/deployment_id"],
			Policy:       labels["gitops.mem_policy"],
			Created:      p.Created,
			Running:      p.Running,
			UsageBytes:   usage[p.Name],
		}
		if c.Name == "" {
			c.Name = p.Name
		}
		if mb, err := strconv.Atoi(labels["gitops.mem_reservation_mb"]); err == nil {
			c.ReservationMB = mb
		}
		out = append(out, c)
	}
	return out, nil
}

func (g k8sMemoryGovernor) Budget(ctx context.Context) (memBudget, error) {
	inv, err := g.Inventory(ctx)
	if err != nil {
		return memBudget{}, err
	}
	total, avail, quotaErr := namespaceMemoryBudget(ctx, inv)

	ns := 0
	if g.countWorkspaces != nil {
		ns = g.countWorkspaces()
	} else {
		ns = countWorkspacesForBudget()
	}
	b := computeBudget(inv, total, avail, ns, loadMemConfig())
	if quotaErr != "" {
		b.Warnings = append(b.Warnings, quotaErr)
	}
	return b, nil
}

// namespaceMemoryBudget is what this namespace may use, and how much of it is
// still free. Free is derived from what is reserved rather than measured: there
// is no "available memory" for a namespace, only a ceiling and what has been
// claimed against it.
func namespaceMemoryBudget(ctx context.Context, inv []memContainer) (total, avail uint64, warning string) {
	limit, err := namespaceMemoryLimit(ctx)
	if err != nil {
		limit = 0
	}
	return budgetFromQuota(limit, inv)
}

// budgetFromQuota is the arithmetic, separated from the cluster so it can be
// tested: a ceiling, and what is still unclaimed against it.
func budgetFromQuota(limit uint64, inv []memContainer) (total, avail uint64, warning string) {
	if limit == 0 {
		return 0, 0, "This namespace has no memory quota, so there is no budget to divide — " +
			"the figures below are reservations only. Set a ResourceQuota to give the governor a ceiling."
	}
	var claimed uint64
	for _, c := range inv {
		if c.Running && c.ReservationMB > 0 {
			claimed += uint64(c.ReservationMB) * 1024 * 1024
		}
	}
	if claimed > limit {
		claimed = limit
	}
	return limit, limit - claimed, ""
}

// namespaceMemoryLimit reads the tightest memory ceiling the namespace has.
func namespaceMemoryLimit(ctx context.Context) (uint64, error) {
	raw, err := k8sctl.Get(ctx, "resourcequota", "")
	if err != nil {
		return 0, err
	}
	var list struct {
		Items []struct {
			Status struct {
				Hard map[string]string `json:"hard"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return 0, err
	}
	var tightest uint64
	for _, item := range list.Items {
		for _, key := range []string{"limits.memory", "requests.memory"} {
			v, ok := item.Status.Hard[key]
			if !ok {
				continue
			}
			b := parseNamespaceQuantity(v)
			if b > 0 && (tightest == 0 || uint64(b) < tightest) {
				tightest = uint64(b)
			}
		}
	}
	return tightest, nil
}

// parseNamespaceQuantity reads a Kubernetes memory quantity.
func parseNamespaceQuantity(v string) int64 { return k8sctl.MemoryQuantityBytes(v) }
