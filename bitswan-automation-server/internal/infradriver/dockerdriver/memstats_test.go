package dockerdriver

import (
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

func TestParseDockerMem(t *testing.T) {
	cases := map[string]int64{
		"120MiB / 2GiB": 120 * 1024 * 1024,
		"1GiB / 4GiB":   1024 * 1024 * 1024,
		"512MiB":        512 * 1024 * 1024,
		"0B / 2GiB":     0,
		"1.5KiB / 1GiB": int64(1.5 * 1024),
		"100MB / 1GB":   100 * 1000 * 1000,
		"2KB / 1GB":     2 * 1000,
		"3GB / 8GB":     3 * 1000 * 1000 * 1000,
		"1TiB / 2TiB":   1024 * 1024 * 1024 * 1024,
		"5TB / 10TB":    5 * 1000 * 1000 * 1000 * 1000,
		"":              0,
		"-- / --":       0,
		"garbage":       0,
	}
	for in, want := range cases {
		if got := parseDockerMem(in); got != want {
			t.Errorf("parseDockerMem(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestParseStats(t *testing.T) {
	byID := map[string]infradriver.Container{
		"aaaa1111": {ID: "aaaa1111", Name: "frontend-bp-staging", Labels: map[string]string{"gitops.bp": "bp"}},
		"bbbb2222": {ID: "bbbb2222", Name: "backend-bp-staging"},
	}
	raw := []byte("aaaa1111\x1f200MiB / 2GiB\nbbbb2222\x1f50MiB / 2GiB\n")
	stats := parseStats(raw, byID)
	if len(stats) != 2 {
		t.Fatalf("want 2 stats, got %d", len(stats))
	}
	byName := map[string]infradriver.ContainerStat{}
	for _, s := range stats {
		byName[s.Name] = s
	}
	if got := byName["frontend-bp-staging"].MemUsageBytes; got != 200*1024*1024 {
		t.Errorf("frontend mem = %d, want %d", got, 200*1024*1024)
	}
	if byName["frontend-bp-staging"].Labels["gitops.bp"] != "bp" {
		t.Errorf("labels not joined from listing")
	}
	if got := byName["backend-bp-staging"].MemUsageBytes; got != 50*1024*1024 {
		t.Errorf("backend mem = %d, want %d", got, 50*1024*1024)
	}
}
