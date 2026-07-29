package daemon

import (
	"fmt"
	"os/exec"
	"strings"
)

// reconcileProtectedProxyConfig re-provisions the shared oauth2-proxy on daemon
// startup when its RUNNING config is stale — i.e. missing a setting the current
// daemon would apply.
//
// The proxy's env is baked into the container at PROVISION time (bitswan
// register / `bitswan ingress provision-protected-proxy`); nothing else
// re-applies it, so a daemon UPDATE alone never reaches an already-running
// proxy. That is how a "fully up to date" server can still run an oauth2-proxy
// without the CSRF per-request cap — letting _oauth2_proxy_<nonce>_csrf cookies
// pile up until requests 431 (Request Header Fields Too Large).
//
// Re-provisioning is safe now that the cookie secret persists
// (loadOrCreateProxyCookieSecret): `docker compose up -d` recreates the
// container ONLY when the rendered config actually changed, and sessions survive
// the swap. Best-effort and backgrounded — it touches the AOC and Docker,
// neither of which should block or fail daemon startup.
func reconcileProtectedProxyConfig() {
	if protectedHostnameDomain() == "" {
		return // not registered → no proxy to reconcile
	}
	env, err := runningProxyEnv()
	if err != nil {
		return // not running / not found → nothing to reconcile here
	}
	if !proxyConfigNeedsUpdate(env) {
		return // already current
	}
	fmt.Println("protected-proxy: running config is stale (missing the CSRF per-request cap); re-provisioning")
	if err := provisionProtectedProxy(); err != nil {
		fmt.Printf("protected-proxy: reconcile re-provision failed: %v\n", err)
	}
}

// runningProxyEnv returns the environment of the running bitswan-protected-proxy
// container as KEY=VALUE lines. Errors (container absent) are the caller's cue
// that there's nothing to reconcile.
func runningProxyEnv() (string, error) {
	out, err := exec.Command("docker", "inspect", protectedProxyProject,
		"--format", "{{range .Config.Env}}{{println .}}{{end}}").Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// proxyConfigNeedsUpdate reports whether a running proxy's env (KEY=VALUE lines)
// is missing a setting the current daemon applies. Today that is the CSRF
// per-request cap, the setting whose absence causes the _oauth2_proxy_*_csrf
// pile-up → 431. Pure, so the reconcile rule is unit-testable without Docker.
func proxyConfigNeedsUpdate(env string) bool {
	return !strings.Contains(env, "OAUTH2_PROXY_COOKIE_CSRF_PER_REQUEST_LIMIT=")
}
