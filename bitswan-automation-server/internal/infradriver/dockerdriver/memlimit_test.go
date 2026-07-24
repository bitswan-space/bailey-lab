package dockerdriver

import (
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

// Four deployments spanning the memLimitMB policy space. Image-based so
// compile needs no on-disk source tree.
const memLimitYAML = `
deployments:
  plain:
    automation_name: plain
    context: acme
    stage: dev
    image: "registry/plain:v1"
  bigres:
    automation_name: bigres
    context: acme
    stage: dev
    image: "registry/bigres:v1"
    memory_reservation: 800
  declared:
    automation_name: declared
    context: acme
    stage: dev
    image: "registry/declared:v1"
    memory_limit: 2048
  underres:
    automation_name: underres
    context: acme
    stage: dev
    image: "registry/underres:v1"
    memory_reservation: 512
    memory_limit: 100
`

// TestMemLimitStamped proves the #200 fix: every service entry carries a hard
// compose mem_limit so a runaway container is OOM-killed inside its own cgroup
// instead of tripping the host's global OOM killer. Policy: declared
// memory_limit wins (clamped up to the reservation); otherwise
// max(1024, 2× reservation).
func TestMemLimitStamped(t *testing.T) {
	bs, err := parseBitswanYAML([]byte(memLimitYAML))
	if err != nil {
		t.Fatalf("parseBitswanYAML: %v", err)
	}
	wctx := infradriver.WorkspaceContext{WorkspaceName: "ws", Domain: "example.com"}
	c := newCompileState(wctx, bs)

	want := map[string]string{
		"plain":    "1024m", // no reservation, no limit → default cap
		"bigres":   "1600m", // 2×800 reservation beats the 1024 default
		"declared": "2048m", // explicit memory_limit wins
		"underres": "512m",  // limit below reservation is clamped up to it
	}
	for depID, wantLimit := range want {
		entry, _, _, emit, err := c.buildServiceEntry(depID, bs.Deployments[depID], "", 0, nil, nil, nil)
		if err != nil {
			t.Fatalf("buildServiceEntry(%s): %v", depID, err)
		}
		if !emit {
			t.Fatalf("buildServiceEntry(%s): expected emit=true", depID)
		}
		if got := entry["mem_limit"]; got != wantLimit {
			t.Errorf("%s mem_limit = %v; want %q", depID, got, wantLimit)
		}
	}
}
