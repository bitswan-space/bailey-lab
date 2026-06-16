package daemon

import "testing"

// workspaceOwnerEmail surfaces the recorded owner of the membership surface,
// falling back across dashboard → editor → gitops so a real owner is shown
// even when the dashboard endpoint has none.
func TestWorkspaceOwnerEmail(t *testing.T) {
	dash := "wsone-dashboard.test.example.com"
	edit := "wsone-editor.test.example.com"
	git := "wsone-gitops.test.example.com"
	t.Cleanup(func() { _ = deleteEndpoint(dash); _ = deleteEndpoint(edit); _ = deleteEndpoint(git) })

	// Dashboard owner wins.
	if _, err := registerEndpoint(dash, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if got := workspaceOwnerEmail(dash, edit, git); got != "owner@example.com" {
		t.Errorf("dashboard owner = %q; want owner@example.com", got)
	}

	// No dashboard → fall back to the editor's owner.
	if got := workspaceOwnerEmail("wsone-missing-dashboard.test.example.com", edit, git); got != "" {
		// editor not registered yet → empty
		t.Errorf("no owner anywhere = %q; want empty", got)
	}
	if _, err := registerEndpoint(edit, "editor-owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if got := workspaceOwnerEmail("wsone-missing-dashboard.test.example.com", edit, git); got != "editor-owner@example.com" {
		t.Errorf("editor fallback owner = %q; want editor-owner@example.com", got)
	}
}
