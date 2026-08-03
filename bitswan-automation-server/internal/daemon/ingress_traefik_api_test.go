package daemon

import (
	"strings"
	"testing"
)

// TestTraefikStaticConfigsDisableTheAPI is a security regression guard. Traefik's
// API/dashboard serves the FULL routing topology with NO authentication, so it
// must not be enabled on any of our Traefik instances (the daemon manages routes
// via the file provider and never needs the HTTP API). A public exposure of it
// was reported by an external researcher; this locks the config down.
func TestTraefikStaticConfigsDisableTheAPI(t *testing.T) {
	configs := map[string]string{
		"global (http-challenge)": renderTraefikStaticConfig("ops@example.com", false),
		"global (dns-challenge)":  renderTraefikStaticConfig("ops@example.com", true),
		"workspace sub-traefik":   workspaceTraefikStaticConfig,
	}
	for name, cfg := range configs {
		for _, line := range strings.Split(cfg, "\n") {
			if strings.TrimSpace(line) == "api:" {
				t.Errorf("%s: Traefik `api:` section is present — the dashboard/API must stay disabled "+
					"(it exposes the full routing topology unauthenticated). Config:\n%s", name, cfg)
			}
		}
	}
	// The sub-traefik must still trust the upstream gate's forwarded headers on the
	// web entrypoint — that `forwardedHeaders.insecure` is unrelated to the API and
	// must not be removed by an over-eager cleanup.
	if !strings.Contains(workspaceTraefikStaticConfig, "forwardedHeaders") {
		t.Error("sub-traefik lost forwardedHeaders — the gate's X-Forwarded-* would no longer be trusted")
	}
}
