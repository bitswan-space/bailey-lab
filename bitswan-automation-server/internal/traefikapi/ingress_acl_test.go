package traefikapi

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A workspace sub-traefik router must carry the ingress-only ACL, and the
// dynamic config must define that middleware as an ipAllowList permitting only
// the gate's network — this is the L3 half of the C1 cross-stage fix.
func TestWorkspaceRouterGetsIngressACL(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	os.Unsetenv("BITSWAN_TRAEFIK_HOST")
	if err := os.MkdirAll(filepath.Join(home, ".config", "bitswan", "workspaces", "testws", "traefik"), 0o755); err != nil {
		t.Fatal(err)
	}
	SetIngressAllowCIDRs([]string{"172.18.0.0/16"})
	t.Cleanup(func() { SetIngressAllowCIDRs(nil) })

	wsURL := GetWorkspaceTraefikBaseURL("testws")
	if err := AddRouteWithTraefik("app-production--inner.example.test", "http://app:80", wsURL); err != nil {
		t.Fatal(err)
	}
	out, err := os.ReadFile(dynamicConfigPath(wsURL))
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if !strings.Contains(s, "middlewares:") || !strings.Contains(s, IngressAllowMiddlewareName) {
		t.Errorf("workspace router is missing the ingress ACL middleware:\n%s", s)
	}
	if !strings.Contains(s, "ipAllowList") || !strings.Contains(s, "sourceRange") || !strings.Contains(s, "172.18.0.0/16") {
		t.Errorf("ingress middleware missing the gate CIDR allowlist:\n%s", s)
	}
}

// With no allowlist set, a workspace config must fail CLOSED (a non-routable
// range), never leave the routers open — a mis-started daemon must break
// loudly, not silently expose production cross-stage.
func TestWorkspaceIngressACLFailsClosedWhenUnset(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	os.Unsetenv("BITSWAN_TRAEFIK_HOST")
	if err := os.MkdirAll(filepath.Join(home, ".config", "bitswan", "workspaces", "closedws", "traefik"), 0o755); err != nil {
		t.Fatal(err)
	}
	SetIngressAllowCIDRs(nil) // not resolved

	wsURL := GetWorkspaceTraefikBaseURL("closedws")
	if err := AddRouteWithTraefik("app-dev--inner.example.test", "http://app:80", wsURL); err != nil {
		t.Fatal(err)
	}
	out, _ := os.ReadFile(dynamicConfigPath(wsURL))
	if !strings.Contains(string(out), "0.0.0.0/32") {
		t.Errorf("expected a fail-closed sourceRange when the allowlist is unset:\n%s", string(out))
	}
}

// The public-facing GLOBAL traefik must NOT gate its routers to the gate
// network — it terminates real public traffic. No ingress-only middleware.
func TestGlobalRouterHasNoIngressACL(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	os.Unsetenv("BITSWAN_TRAEFIK_HOST")
	if err := os.MkdirAll(filepath.Join(home, ".config", "bitswan", "traefik"), 0o755); err != nil {
		t.Fatal(err)
	}
	SetIngressAllowCIDRs([]string{"172.18.0.0/16"})
	t.Cleanup(func() { SetIngressAllowCIDRs(nil) })

	gURL := getTraefikBaseURL() // global (env unset → global)
	if err := AddRouteWithTraefik("public.example.test", "http://x:80", gURL); err != nil {
		t.Fatal(err)
	}
	out, _ := os.ReadFile(dynamicConfigPath(gURL))
	if strings.Contains(string(out), IngressAllowMiddlewareName) {
		t.Errorf("the global public traefik must not carry the ingress ACL:\n%s", string(out))
	}
}
