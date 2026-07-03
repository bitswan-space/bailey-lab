package daemon

import (
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// resolveWorkspaceInitDomain fills an omitted, non-local domain from the
// server's configured domain so AOC-registered servers don't re-type a domain
// the daemon already knows, without disturbing explicit/--local/unconfigured
// cases.
func TestResolveWorkspaceInitDomain(t *testing.T) {
	aocCfg := &config.Config{}
	aocCfg.AutomationOperationsCenter.Domain = "acme-prod.bswn.io"

	protectedCfg := &config.Config{ProtectedDomain: "apps.acme.com"}
	protectedCfg.AutomationOperationsCenter.Domain = "acme-prod.bswn.io"

	emptyCfg := &config.Config{} // registered server with no assigned domain

	tests := []struct {
		name   string
		domain string
		local  bool
		cfg    *config.Config
		want   string
	}{
		{"explicit domain wins over AOC", "custom.example.com", false, aocCfg, "custom.example.com"},
		{"omitted domain defaults to AOC domain", "", false, aocCfg, "acme-prod.bswn.io"},
		{"protected-domain override wins over AOC", "", false, protectedCfg, "apps.acme.com"},
		{"explicit domain wins over protected override", "custom.example.com", false, protectedCfg, "custom.example.com"},
		{"local keeps its own (already-set) domain, AOC ignored", "bs-ws.localhost", true, aocCfg, "bs-ws.localhost"},
		{"no config leaves domain unchanged", "", false, nil, ""},
		{"configured but no assigned domain leaves it empty", "", false, emptyCfg, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := resolveWorkspaceInitDomain(tt.domain, tt.local, tt.cfg); got != tt.want {
				t.Errorf("resolveWorkspaceInitDomain(%q, %v, cfg) = %q; want %q", tt.domain, tt.local, got, tt.want)
			}
		})
	}
}
