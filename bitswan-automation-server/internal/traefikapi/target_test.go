package traefikapi

import (
	"os"
	"strings"
	"testing"
)

// TestWorkspaceTargetingIsEnvIndependent guards against the regression where a
// sub-traefik was targeted by mutating the process-global BITSWAN_TRAEFIK_HOST
// env. That env is shared by every concurrent request, so a global route push
// racing a workspace op was redirected into the sub-traefik and dumped the
// entire global route table there (observed live: a workspace sub-traefik with
// 100 services, every other workspace's outer host pointing at it).
//
// The contract: an explicit workspace name must select the sub-traefik's state
// file regardless of what BITSWAN_TRAEFIK_HOST happens to be set to, and an
// empty workspace name must select the global traefik.
func TestWorkspaceTargetingIsEnvIndependent(t *testing.T) {
	// Set the env to a DIFFERENT workspace's sub-traefik to prove it's ignored
	// when an explicit workspace name is passed.
	t.Setenv("BITSWAN_TRAEFIK_HOST", "http://other__traefik:8080")

	wsPath := getStateFilePath(getTraefikBaseURL("wraptest"))
	if !strings.Contains(wsPath, "workspaces/wraptest/traefik") {
		t.Errorf("explicit workspace not honored: state path = %q, want it under workspaces/wraptest/traefik", wsPath)
	}
	if strings.Contains(wsPath, "other") {
		t.Errorf("targeting leaked the env value: state path = %q must not reference the env's workspace", wsPath)
	}

	// With no explicit workspace, the env selects the target (the global daemon
	// sets it to the platform traefik) — this path is the only legitimate env use.
	globalEnvURL := getTraefikBaseURL()
	if !strings.Contains(globalEnvURL, "other__traefik") {
		t.Errorf("no-arg targeting should read the env: got %q", globalEnvURL)
	}

	// And an unset env defaults to the global traefik state file, not a workspace one.
	os.Unsetenv("BITSWAN_TRAEFIK_HOST")
	globalPath := getStateFilePath(getTraefikBaseURL())
	if strings.Contains(globalPath, "workspaces/") {
		t.Errorf("global target leaked into a workspace path: %q", globalPath)
	}
}
