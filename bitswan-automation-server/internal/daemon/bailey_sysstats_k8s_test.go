package daemon

import (
	"sync"
	"testing"
)

func TestTheOverviewSurvivesANamespaceWithoutAQuota(t *testing.T) {
	t.Setenv(platformEnv, "kubernetes")
	platformOnce = sync.Once{}
	t.Cleanup(func() { platformOnce = sync.Once{} })

	stats, err := gatherSystemStats()
	if err != nil {
		t.Fatalf("the whole overview card failed because memory has no answer: %v", err)
	}
	if stats.MemNote == "" {
		t.Error("no note saying why memory reads zero; the card would look broken for no stated reason")
	}
	if stats.DiskTotalBytes == 0 {
		t.Error("disk was lost along with memory, and it is both measurable here and actionable")
	}
	if stats.CPUCount == 0 {
		t.Error("cpu was lost along with memory")
	}
}
