package daemon

import (
	"os"
	"testing"
)

// TestRenderLauncherHTML dumps the chrome footer + launcher HTML with sample
// data for visual inspection. Opt-in: set BAILEY_RENDER_OUT=/path to emit;
// skipped during normal test runs so it has no side effects.
func TestRenderLauncherHTML(t *testing.T) {
	out := os.Getenv("BAILEY_RENDER_OUT")
	if out == "" {
		t.Skip("set BAILEY_RENDER_OUT=/path to render the launcher HTML")
	}
	d := launcherData{
		AOCUrl:       "https://aoc.harmonum.ai/",
		DashboardURL: "https://bailey.harmonum.ai/",
		Workspaces: []launcherWorkspace{
			{Name: "HR Platform", URL: "https://hr-dashboard.harmonum.ai", Frontends: []launcherFrontend{
				{Name: "HR Self-Service", URL: "https://hr.harmonum.ai"},
				{Name: "HR Admin Console", URL: "https://admin.hr.harmonum.ai"},
			}},
			{Name: "Invoice Automation", URL: "https://inv-dashboard.harmonum.ai", Frontends: []launcherFrontend{
				{Name: "Invoice Console", URL: "https://inv.harmonum.ai"},
			}},
		},
	}
	html := baileyChromeHTML("tomas@harmonum.ai", "hr.harmonum.ai", "about:blank", true, d)
	if err := os.WriteFile(out, []byte(html), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %s (%d bytes)", out, len(html))
}
