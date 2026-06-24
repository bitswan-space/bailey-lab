package daemon

import (
	"bufio"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// systemStats is the real host resource snapshot shown on the overview.
// Everything here is read from the live kernel — /proc and statfs — never
// estimated or hardcoded. Memory/CPU come from /proc (not namespaced, so
// inside the daemon container they reflect the host); disk is statfs on the
// host-root bind mount.
type systemStats struct {
	MemTotalBytes uint64  `json:"mem_total_bytes"`
	MemUsedBytes  uint64  `json:"mem_used_bytes"`
	MemFreeBytes  uint64  `json:"mem_free_bytes"`
	MemUsedPct    float64 `json:"mem_used_pct"`

	DiskTotalBytes uint64  `json:"disk_total_bytes"`
	DiskUsedBytes  uint64  `json:"disk_used_bytes"`
	DiskFreeBytes  uint64  `json:"disk_free_bytes"`
	DiskUsedPct    float64 `json:"disk_used_pct"`
	DiskPath       string  `json:"disk_path"`

	CPUCount   int     `json:"cpu_count"`
	CPUUsedPct float64 `json:"cpu_used_pct"`
	Load1      float64 `json:"load1"`
}

// sysStatsDiskPath is the filesystem we report disk usage for. The daemon
// container bind-mounts the host root at /host, so that's the operator's
// real disk; fall back to "/" (the container root) when /host isn't present.
func sysStatsDiskPath() string {
	if _, err := os.Stat("/host"); err == nil {
		return "/host"
	}
	return "/"
}

// gatherSystemStats reads the live host stats. It returns the first error
// it hits rather than fabricating a value — a missing /proc must surface as
// an honest error on the overview, not as a fake "0 bytes free".
func gatherSystemStats() (*systemStats, error) {
	s := &systemStats{CPUCount: runtime.NumCPU()}

	memTotal, memAvail, err := readMemInfo()
	if err != nil {
		return nil, err
	}
	s.MemTotalBytes = memTotal
	s.MemFreeBytes = memAvail
	if memTotal >= memAvail {
		s.MemUsedBytes = memTotal - memAvail
	}
	if memTotal > 0 {
		s.MemUsedPct = round1(float64(s.MemUsedBytes) / float64(memTotal) * 100)
	}

	s.DiskPath = sysStatsDiskPath()
	diskTotal, diskFree, err := diskUsage(s.DiskPath)
	if err != nil {
		return nil, fmt.Errorf("statfs %s: %w", s.DiskPath, err)
	}
	s.DiskTotalBytes = diskTotal
	s.DiskFreeBytes = diskFree
	if s.DiskTotalBytes >= s.DiskFreeBytes {
		s.DiskUsedBytes = s.DiskTotalBytes - s.DiskFreeBytes
	}
	if s.DiskTotalBytes > 0 {
		s.DiskUsedPct = round1(float64(s.DiskUsedBytes) / float64(s.DiskTotalBytes) * 100)
	}

	if load1, err := readLoad1(); err == nil {
		s.Load1 = round1(load1)
	}

	if pct, err := readCPUUsagePct(); err == nil {
		s.CPUUsedPct = round1(pct)
	} else {
		return nil, err
	}

	return s, nil
}

func round1(f float64) float64 {
	return float64(int64(f*10+0.5)) / 10
}

// readMemInfo returns (MemTotal, MemAvailable) in bytes from /proc/meminfo.
func readMemInfo() (total, avail uint64, err error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		// values are in kB
		kb, perr := strconv.ParseUint(fields[1], 10, 64)
		if perr != nil {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			total = kb * 1024
		case "MemAvailable:":
			avail = kb * 1024
		}
	}
	if err := sc.Err(); err != nil {
		return 0, 0, err
	}
	if total == 0 {
		return 0, 0, fmt.Errorf("MemTotal not found in /proc/meminfo")
	}
	return total, avail, nil
}

// readLoad1 returns the 1-minute load average from /proc/loadavg.
func readLoad1() (float64, error) {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(string(b))
	if len(fields) < 1 {
		return 0, fmt.Errorf("unexpected /proc/loadavg format")
	}
	return strconv.ParseFloat(fields[0], 64)
}

// readCPUUsagePct samples the aggregate CPU line of /proc/stat twice, a
// short interval apart, and returns the busy percentage over that window.
func readCPUUsagePct() (float64, error) {
	idle1, total1, err := readCPUSample()
	if err != nil {
		return 0, err
	}
	time.Sleep(120 * time.Millisecond)
	idle2, total2, err := readCPUSample()
	if err != nil {
		return 0, err
	}
	dTotal := float64(total2 - total1)
	dIdle := float64(idle2 - idle1)
	if dTotal <= 0 {
		return 0, nil
	}
	pct := (dTotal - dIdle) / dTotal * 100
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return pct, nil
}

// readCPUSample reads the aggregate "cpu" line of /proc/stat and returns
// (idle+iowait, sum-of-all-fields).
func readCPUSample() (idle, total uint64, err error) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)[1:] // user nice system idle iowait irq softirq steal ...
		for i, fld := range fields {
			v, perr := strconv.ParseUint(fld, 10, 64)
			if perr != nil {
				continue
			}
			total += v
			if i == 3 || i == 4 { // idle + iowait
				idle += v
			}
		}
		return idle, total, nil
	}
	if err := sc.Err(); err != nil {
		return 0, 0, err
	}
	return 0, 0, fmt.Errorf("no aggregate cpu line in /proc/stat")
}
