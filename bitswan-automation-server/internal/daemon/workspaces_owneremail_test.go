package daemon

import "testing"

// workspaceOwnerEmail surfaces the recorded owner of the membership surface,
// falling back across dashboard → gitops so a real owner is shown
// even when the dashboard endpoint has none.
func TestWorkspaceOwnerEmail(t *testing.T) {
	dash := "wsone-dashboard.test.example.com"
	git := "wsone-gitops.test.example.com"
	t.Cleanup(func() { _ = deleteEndpoint(dash); _ = deleteEndpoint(git) })

	// Dashboard owner wins.
	if _, err := registerEndpoint(dash, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if got := workspaceOwnerEmail(dash, git); got != "owner@example.com" {
		t.Errorf("dashboard owner = %q; want owner@example.com", got)
	}

	// No dashboard → fall back to the gitops owner.
	if got := workspaceOwnerEmail("wsone-missing-dashboard.test.example.com", git); got != "" {
		// gitops not registered yet → empty
		t.Errorf("no owner anywhere = %q; want empty", got)
	}
	if _, err := registerEndpoint(git, "gitops-owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if got := workspaceOwnerEmail("wsone-missing-dashboard.test.example.com", git); got != "gitops-owner@example.com" {
		t.Errorf("gitops fallback owner = %q; want gitops-owner@example.com", got)
	}
}
