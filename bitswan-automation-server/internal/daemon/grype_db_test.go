package daemon

import "testing"

// gitopsImageForGrype prefers the operator's explicit pin. (The fallback path
// resolves a track-aware image from Docker Hub — network-dependent, so it isn't
// asserted here; the fix is that it uses the DEPLOY track, not the stale
// production channel, so the refresh image actually carries a grype binary.)
func TestGitopsImageForGrype_PrefersEnvPin(t *testing.T) {
	t.Setenv("BITSWAN_GITOPS_IMAGE", "bitswan/gitops-staging:pinned")
	if got := gitopsImageForGrype(); got != "bitswan/gitops-staging:pinned" {
		t.Errorf("gitopsImageForGrype() = %q, want the env pin", got)
	}
}
