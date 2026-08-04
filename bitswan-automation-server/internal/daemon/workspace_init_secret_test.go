package daemon

import (
	"bytes"
	"strings"
	"testing"
)

// Init output is streamed verbatim to the Bailey console (handleWorkspaceInit
// pipes os.Stdout into the NDJSON response), where viewers are not authorized
// to hold the gitops secret — so the end-of-init summary must never contain
// it (#336). The secret is passed in precisely so this test fails if the
// print is ever casually re-added during debugging.
func TestPrintGitopsInfo_DoesNotLeakSecret(t *testing.T) {
	const secret = "sentinel-gitops-secret-value"
	var buf bytes.Buffer
	printGitopsInfo(&buf, "tenant-a", "example.com", secret)

	out := buf.String()
	if strings.Contains(out, secret) {
		t.Fatalf("init summary leaked the gitops secret:\n%s", out)
	}
	for _, want := range []string{
		"GitOps ID: tenant-a",
		"GitOps URL: https://tenant-a-gitops.example.com",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("init summary missing %q:\n%s", want, out)
		}
	}
}
