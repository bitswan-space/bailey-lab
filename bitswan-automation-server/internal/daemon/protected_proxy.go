package daemon

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"

	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
	"github.com/bitswan-space/bitswan-workspaces/internal/dockercompose"
)

// daemonContainerName is the name of the daemon's own container. The
// protected proxy is a separate container that reaches the daemon's gate
// (:9080) over bitswan_network by this name.
const daemonContainerName = "bitswan-automation-server-daemon"

// protectedProxyProject is the docker-compose project name for the proxy.
const protectedProxyProject = "bitswan-protected-proxy"

// provisionProtectedProxy brings up the shared bitswan-protected-proxy
// (oauth2-proxy) container that fronts every protected endpoint. It is the
// piece deliberately left out of stage 1 (see docs/protected_ingress.md): the
// daemon used to only check for the container and fall back to direct routing.
//
// Requires a configured domain (the AOC assigns it at register time) and a
// reachable AOC (for the shared Keycloak client credentials). Idempotent:
// re-running with unchanged inputs is a no-op `docker compose up -d`. After the
// proxy is up it wires the Bailey management hostnames through it via
// setupBaileyRoutes; subsequent workspace route registrations pick up the
// wrapped path automatically (see addRouteTraefik).
func provisionProtectedProxy() error {
	domain := protectedHostnameDomain()
	if domain == "" {
		return fmt.Errorf("no domain configured — register with the AOC first")
	}

	aocClient, err := aoc.NewAOCClient()
	if err != nil {
		return fmt.Errorf("AOC not configured: %w", err)
	}
	// The shared protected client. Fetching it here also registers the
	// bailey callback URI; per-endpoint callbacks are added as routes appear.
	client, err := aocClient.GetOrCreateOAuthClient("bitswan-protected",
		"https://bailey."+domain+"/oauth2/callback")
	if err != nil {
		return fmt.Errorf("fetch protected OAuth client from AOC: %w", err)
	}
	if client.ClientID == "" || client.ClientSecret == "" || client.IssuerURL == "" {
		return fmt.Errorf("AOC returned an incomplete protected OAuth client")
	}

	cookieSecret, err := generateProxyCookieSecret()
	if err != nil {
		return err
	}

	env := protectedProxyOAuthEnv(domain, client.ClientID, client.ClientSecret, client.IssuerURL, cookieSecret)

	composeYAML, err := dockercompose.CreateProtectedProxyDockerComposeFile(env)
	if err != nil {
		return fmt.Errorf("render protected-proxy compose: %w", err)
	}

	homeDir := os.Getenv("HOME")
	proxyDir := homeDir + "/.config/bitswan/protected-proxy"
	if err := os.MkdirAll(proxyDir, 0755); err != nil {
		return fmt.Errorf("create protected-proxy config directory: %w", err)
	}
	composePath := proxyDir + "/docker-compose.yml"
	// 0600: the compose file carries the OAuth client secret + cookie secret.
	if err := os.WriteFile(composePath, []byte(composeYAML), 0600); err != nil {
		return fmt.Errorf("write protected-proxy compose: %w", err)
	}

	upCmd := exec.Command("docker", "compose", "-p", protectedProxyProject, "up", "-d")
	upCmd.Dir = proxyDir
	upCmd.Stdout = os.Stdout
	upCmd.Stderr = os.Stderr
	if err := upCmd.Run(); err != nil {
		return fmt.Errorf("start bitswan-protected-proxy: %w", err)
	}

	// Now that the proxy is running, wire the Bailey hostnames through it.
	// (At boot this was a no-op because the container didn't exist yet.)
	setupBaileyRoutes()
	return nil
}

// protectedProxyOAuthEnv builds the oauth2-proxy environment for the shared
// protected proxy. The values mirror the live reference configuration: the
// proxy authenticates against Keycloak (provider "oidc"), forwards identity to
// the daemon gate on :9080, and shares one session cookie across the whole
// domain family (outer/inner/bailey subdomains). No fixed redirect URL is set —
// with reverse_proxy + pass_host_header the callback derives per-request from
// the request host, so a single proxy fronts every protected hostname; each
// host's /oauth2/callback is registered in Keycloak via
// registerProtectedRedirectURI.
func protectedProxyOAuthEnv(domain, clientID, clientSecret, issuerURL, cookieSecret string) map[string]string {
	// whitelist_domains must include the IdP host so the wrap's Logout
	// (/oauth2/sign_out?rd=<keycloak end_session>) is honoured rather than
	// silently dropped, alongside the endpoint domain family.
	whitelist := "." + domain
	if kcHost := keycloakHostFromIssuer(issuerURL); kcHost != "" {
		whitelist += "," + kcHost
	}

	return map[string]string{
		"OAUTH2_PROXY_PROVIDER":             "oidc",
		"OAUTH2_PROXY_OIDC_ISSUER_URL":      issuerURL,
		"OAUTH2_PROXY_CLIENT_ID":            clientID,
		"OAUTH2_PROXY_CLIENT_SECRET":        clientSecret,
		"OAUTH2_PROXY_HTTP_ADDRESS":         "0.0.0.0:80",
		"OAUTH2_PROXY_UPSTREAMS":            "http://" + daemonContainerName + ":9080",
		"OAUTH2_PROXY_EMAIL_DOMAINS":        "*",
		"OAUTH2_PROXY_COOKIE_SECRET":        cookieSecret,
		"OAUTH2_PROXY_COOKIE_DOMAINS":       "." + domain,
		"OAUTH2_PROXY_WHITELIST_DOMAINS":    whitelist,
		"OAUTH2_PROXY_REVERSE_PROXY":        "true",
		"OAUTH2_PROXY_PASS_USER_HEADERS":    "true",
		"OAUTH2_PROXY_PASS_HOST_HEADER":     "true",
		"OAUTH2_PROXY_SCOPE":                "openid email profile",
		"OAUTH2_PROXY_OIDC_GROUPS_CLAIM":    "group_membership",
		"OAUTH2_PROXY_SKIP_PROVIDER_BUTTON": "true",
		"OAUTH2_PROXY_COOKIE_SECURE":        "true",
		"OAUTH2_PROXY_COOKIE_REFRESH":       "4m",
		"OAUTH2_PROXY_SET_XAUTHREQUEST":     "true",
		"OAUTH2_PROXY_PASS_ACCESS_TOKEN":    "true",
	}
}

// keycloakHostFromIssuer extracts the bare hostname from an OIDC issuer URL
// (e.g. "https://keycloak.example.com/realms/master" → "keycloak.example.com").
// Returns "" if the issuer can't be parsed.
func keycloakHostFromIssuer(issuer string) string {
	u, err := url.Parse(issuer)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// generateProxyCookieSecret returns a base64url-encoded 32-byte secret, the
// form oauth2-proxy expects for AES-256 cookie encryption.
func generateProxyCookieSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate cookie secret: %w", err)
	}
	return base64.URLEncoding.EncodeToString(b), nil
}

// handleIngressProvisionProtectedProxy handles POST
// /ingress/provision-protected-proxy — brings up the shared oauth2-proxy.
func (s *Server) handleIngressProvisionProtectedProxy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if err := provisionProtectedProxy(); err != nil {
		writeJSONError(w, "failed to provision protected proxy: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = writeProtectedProxyOK(w)
}

func writeProtectedProxyOK(w http.ResponseWriter) error {
	_, err := w.Write([]byte(`{"success":true,"message":"bitswan-protected-proxy provisioned"}`))
	return err
}
