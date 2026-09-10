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
	if ssoActive() || loginTopologyDrifted(env) {
		fmt.Println("protected-proxy: reconciling the login topology against the configured providers")
		if err := reconcileLoginTopology(); err != nil {
			fmt.Printf("protected-proxy: login topology reconcile failed: %v\n", err)
		}
		return
	}
	if !proxyConfigNeedsUpdate(env) {
		return // already current
	}
	fmt.Println("protected-proxy: running config is stale (missing a setting this daemon applies); re-provisioning")
	if err := provisionProtectedProxy(); err != nil {
		fmt.Printf("protected-proxy: reconcile re-provision failed: %v\n", err)
	}
}

func loginTopologyDrifted(env string) bool {
	domain := protectedHostnameDomain()
	if domain == "" {
		return false
	}
	onBroker := strings.Contains(env, "OAUTH2_PROXY_OIDC_ISSUER_URL="+dexIssuerURL(domain))
	if ssoActive() != onBroker {
		return true
	}
	return onBroker && !containerRunning(dexContainerName)
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
// is missing a setting the current daemon applies. Pure, so the reconcile rule is
// unit-testable without Docker.
//
// Each entry is a setting whose absence is a user-visible defect:
//
//   - COOKIE_CSRF_PER_REQUEST_LIMIT — without the cap, _oauth2_proxy_*_csrf
//     cookies pile up until requests 431 (Request Header Fields Too Large).
//   - CUSTOM_TEMPLATES_DIR — without it the proxy still serves the stock
//     "500 Oops! Something went wrong" instead of Bailey's sign-in failure page
//     (protected_proxy_error_page.go). Re-provisioning also writes the template
//     files themselves, so this one entry covers both halves.
func proxyConfigNeedsUpdate(env string) bool {
	for _, required := range []string{
		"OAUTH2_PROXY_COOKIE_CSRF_PER_REQUEST_LIMIT=",
		"OAUTH2_PROXY_CUSTOM_TEMPLATES_DIR=",
	} {
		if !strings.Contains(env, required) {
			return true
		}
	}
	return false
}
