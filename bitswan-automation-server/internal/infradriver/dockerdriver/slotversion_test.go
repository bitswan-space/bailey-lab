package dockerdriver

import (
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

// TestPerSlotVersionOverlay proves the blue-green promote primitive: a
// `<base_id>@<slot>` deployment overlay pins a DIFFERENT version onto one slot
// while the live slot keeps the base version. The driver compiles both slots'
// containers; the production route still points at the live slot (the
// health-gated ingress flip in reconcile() is what cuts over). Image-based
// deployments are used so compile() needs no on-disk source tree.
func TestPerSlotVersionOverlay(t *testing.T) {
	bsYAML := `
deployments:
  dep1:
    automation_name: app
    context: ""
    stage: production
    image: "registry/app:v1"
    relative_path: "copies/main/Shop/backend"
  dep1@green:
    image: "registry/app:v2"
backups:
  shop:
    live_slot: blue
    slots:
      blue: {db: 1}
      green: {db: 2}
`
	bs, err := parseBitswanYAML([]byte(bsYAML))
	if err != nil {
		t.Fatalf("parseBitswanYAML: %v", err)
	}
	// SecretsDir on a temp dir: compile materializes the per-BP secrets env file
	// there; without it the default relative "secrets/" would pollute the package.
	wctx := infradriver.WorkspaceContext{WorkspaceName: "ws", Domain: "example.com", SecretsDir: t.TempDir()}
	_, _, _, err = compile(wctx, bs)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	// Re-run via the lower-level path to inspect the services map directly.
	c := newCompileState(wctx, bs)
	services := map[string]interface{}{}
	deployments := bs.Deployments
	fwScope := c.computeFirewallScope(deployments)
	workerHosts, workerPorts := c.computeWorkerHosts(deployments, fwScope)
	for _, depID := range sortedDepIDs(deployments) {
		if depID == "dep1@green" {
			// overlay must NOT be emitted as a standalone service
			continue
		}
		conf := deployments[depID]
		for _, sd := range c.slotDBPairs(conf) {
			slotConf := c.effectiveSlotConf(depID, conf, sd.slot, deployments)
			entry, name, _, emit, derr := c.buildServiceEntry(depID, slotConf, sd.slot, sd.db, workerHosts, workerPorts, fwScope)
			if derr != nil {
				t.Fatalf("buildServiceEntry(%s,%s): %v", depID, sd.slot, derr)
			}
			if emit {
				services[name] = entry
			}
		}
	}

	// Find the per-slot services by their gitops.slot label and assert the
	// version (image) + deployment_id each carries.
	bySlot := map[string]map[string]interface{}{}
	for _, v := range services {
		e := v.(map[string]interface{})
		labels := e["labels"].(map[string]interface{})
		slot, _ := labels["gitops.slot"].(string)
		bySlot[slot] = e
	}

	blue, ok := bySlot["blue"]
	if !ok {
		t.Fatalf("no blue (live) slot service emitted; slots seen: %v", keysOf(bySlot))
	}
	green, ok := bySlot["green"]
	if !ok {
		t.Fatalf("no green (idle) slot service emitted; slots seen: %v", keysOf(bySlot))
	}

	if got := blue["image"]; got != "registry/app:v1" {
		t.Errorf("live (blue) slot image = %v, want registry/app:v1", got)
	}
	if got := green["image"]; got != "registry/app:v2" {
		t.Errorf("idle (green) slot image = %v, want registry/app:v2 (per-slot overlay)", got)
	}

	blueLabels := blue["labels"].(map[string]interface{})
	greenLabels := green["labels"].(map[string]interface{})
	// Live slot carries the bare deployment_id; the idle slot carries
	// `<base>@<slot>` (so the dashboard surfaces it as a separate standby).
	if got := blueLabels["gitops.deployment_id"]; got != "dep1" {
		t.Errorf("live slot deployment_id = %v, want dep1", got)
	}
	if got := greenLabels["gitops.deployment_id"]; got != "dep1@green" {
		t.Errorf("idle slot deployment_id = %v, want dep1@green", got)
	}
}

func keysOf(m map[string]map[string]interface{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
