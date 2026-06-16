package daemon

import (
	"runtime"
	"testing"
)

// gatherSystemStats reads /proc + statfs, which only exist on Linux — the only
// OS the daemon ever runs on. The CI test matrix also runs on macOS/Windows,
// where /proc is absent, so skip there rather than assert a Linux-only path.
func TestGatherSystemStats(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("system stats read /proc; Linux-only")
	}
	s, err := gatherSystemStats()
	if err != nil {
		t.Fatalf("gatherSystemStats: %v", err)
	}
	if s.MemTotalBytes == 0 {
		t.Error("MemTotalBytes = 0; expected real memory size")
	}
	if s.MemUsedBytes > s.MemTotalBytes {
		t.Errorf("MemUsedBytes %d > MemTotalBytes %d", s.MemUsedBytes, s.MemTotalBytes)
	}
	if s.DiskTotalBytes == 0 {
		t.Error("DiskTotalBytes = 0; expected a real filesystem")
	}
	if s.DiskFreeBytes > s.DiskTotalBytes {
		t.Errorf("DiskFreeBytes %d > DiskTotalBytes %d", s.DiskFreeBytes, s.DiskTotalBytes)
	}
	if s.DiskPath == "" {
		t.Error("DiskPath empty")
	}
	if s.CPUCount < 1 {
		t.Errorf("CPUCount = %d; want >= 1", s.CPUCount)
	}
	for _, p := range []struct {
		name string
		v    float64
	}{{"MemUsedPct", s.MemUsedPct}, {"DiskUsedPct", s.DiskUsedPct}, {"CPUUsedPct", s.CPUUsedPct}} {
		if p.v < 0 || p.v > 100 {
			t.Errorf("%s = %v; want 0..100", p.name, p.v)
		}
	}
}

func TestReadMemInfo(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("/proc/meminfo is Linux-only")
	}
	total, avail, err := readMemInfo()
	if err != nil {
		t.Fatalf("readMemInfo: %v", err)
	}
	if total == 0 {
		t.Error("MemTotal = 0")
	}
	if avail > total {
		t.Errorf("MemAvailable %d > MemTotal %d", avail, total)
	}
}

func TestRound1(t *testing.T) {
	cases := map[float64]float64{
		12.34:  12.3,
		12.35:  12.4,
		0:      0,
		99.99:  100,
		50.041: 50,
	}
	for in, want := range cases {
		if got := round1(in); got != want {
			t.Errorf("round1(%v) = %v; want %v", in, got, want)
		}
	}
}
