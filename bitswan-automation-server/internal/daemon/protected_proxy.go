package daemon

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

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

	var clientID, clientSecret, issuerURL string
	brokered := ssoActive()
	if brokered {
		secret, err := loadOrCreateDexProxySecret()
		if err != nil {
			return err
		}
		clientID, clientSecret, issuerURL = dexProxyClientID, secret, dexIssuerURL(domain)
	} else {
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
		clientID, clientSecret, issuerURL = client.ClientID, client.ClientSecret, client.IssuerURL
	}

	homeDir := os.Getenv("HOME")
	proxyDir := homeDir + "/.config/bitswan/protected-proxy"
	if err := os.MkdirAll(proxyDir, 0755); err != nil {
		return fmt.Errorf("create protected-proxy config directory: %w", err)
	}

	cookieSecret, err := loadOrCreateProxyCookieSecret(proxyDir)
	if err != nil {
		return err
	}

	// The custom page templates have to exist before `up`: the compose file mounts
	// them as a strict named-volume subpath, so Docker refuses to start the proxy
	// if the directory is missing.
	if err := writeProtectedProxyTemplates(proxyDir); err != nil {
		return err
	}

	env := protectedProxyOAuthEnv(domain, clientID, clientSecret, issuerURL, cookieSecret)
	if brokered {
		env["OAUTH2_PROXY_OIDC_GROUPS_CLAIM"] = "groups"
		env["OAUTH2_PROXY_REDIRECT_URL"] = dexProxyRedirectURL(domain)
		env["OAUTH2_PROXY_SCOPE"] = "openid email profile groups offline_access"
		env["OAUTH2_PROXY_APPROVAL_PROMPT"] = "auto"
	}

	composeYAML, err := dockercompose.CreateProtectedProxyDockerComposeFile(env)
	if err != nil {
		return fmt.Errorf("render protected-proxy compose: %w", err)
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
		"OAUTH2_PROXY_PROVIDER":          "oidc",
		"OAUTH2_PROXY_OIDC_ISSUER_URL":   issuerURL,
		"OAUTH2_PROXY_CLIENT_ID":         clientID,
		"OAUTH2_PROXY_CLIENT_SECRET":     clientSecret,
		"OAUTH2_PROXY_HTTP_ADDRESS":      "0.0.0.0:80",
		"OAUTH2_PROXY_UPSTREAMS":         "http://" + daemonContainerName + ":9080",
		"OAUTH2_PROXY_EMAIL_DOMAINS":     "*",
		"OAUTH2_PROXY_COOKIE_SECRET":     cookieSecret,
		"OAUTH2_PROXY_COOKIE_DOMAINS":    "." + domain,
		"OAUTH2_PROXY_WHITELIST_DOMAINS": whitelist,
		"OAUTH2_PROXY_REVERSE_PROXY":     "true",
		"OAUTH2_PROXY_PASS_USER_HEADERS": "true",
		"OAUTH2_PROXY_PASS_HOST_HEADER":  "true",
		// offline_access makes Keycloak issue an OFFLINE refresh token: it
		// survives browser close and the SSO session's idle death, so oauth2-proxy
		// can keep the session alive indefinitely by refreshing it — transparently,
		// with the app behind the proxy none the wiser. Combined with realm-side
		// single-use refresh-token rotation, each transparent refresh rotates the
		// token, so a stolen cookie's next refresh collides with ours (breach
		// detection) and only one holder survives.
		"OAUTH2_PROXY_SCOPE":                "openid email profile offline_access",
		"OAUTH2_PROXY_OIDC_GROUPS_CLAIM":    "group_membership",
		"OAUTH2_PROXY_SKIP_PROVIDER_BUTTON": "true",
		"OAUTH2_PROXY_COOKIE_SECURE":        "true",
		// Server-side session store so oauth2-proxy can hold a per-session refresh
		// lock: concurrent requests serialize on refresh (one rotates the token,
		// the rest reuse the result), which is what makes single-use refresh-token
		// rotation safe. Without it, parallel requests replay the pre-rotation
		// token and Keycloak revokes the session (spurious logout).
		"OAUTH2_PROXY_SESSION_STORE_TYPE":   "redis",
		"OAUTH2_PROXY_REDIS_CONNECTION_URL": "redis://bitswan-protected-proxy-redis:6379",
		// Refresh the token well before it expires (must stay < the realm's
		// access-token lifespan). On each refresh oauth2-proxy re-issues the
		// cookie with a fresh COOKIE_EXPIRE window, so an actively-used session
		// rolls forward and never forces a re-login.
		"OAUTH2_PROXY_COOKIE_REFRESH": "4m",
		// A long absolute cookie lifetime so the session survives long idle gaps
		// (backed by the non-expiring offline refresh token). Rolled forward on
		// every refresh; the real ceiling is the offline session, which the realm
		// keeps effectively unbounded.
		"OAUTH2_PROXY_COOKIE_EXPIRE":     "8760h",
		"OAUTH2_PROXY_SET_XAUTHREQUEST":  "true",
		"OAUTH2_PROXY_PASS_ACCESS_TOKEN": "true",
		// SECURITY (issue #127): the gate strips the proxy-injected
		// X-Forwarded-Access-Token from tenant-code upstreams but
		// deliberately passes the Authorization header through (it carries
		// the Bearer token BP frontends fetch from /oauth2/auth and send to
		// their own backends). That pass-through is safe only while
		// oauth2-proxy never injects an Authorization header of its own.
		// pass_basic_auth defaults to TRUE upstream; today it is inert
		// because basic_auth_password is unset (the legacy-header conversion
		// requires both), but pin it off so the invariant survives config
		// drift. PASS_AUTHORIZATION_HEADER must likewise stay unset — see
		// gateDirector before enabling either.
		"OAUTH2_PROXY_PASS_BASIC_AUTH": "false",
		// Without per-request CSRF cookies every in-flight login shares ONE
		// state cookie across the whole cookie_domains family — a second tab
		// (or a second *.domain host) starting its own handshake clobbers the
		// first flow's cookie and that flow 403s at /oauth2/callback right
		// after the Keycloak login (issue #47). Per-request gives each flow
		// its own cookie.
		"OAUTH2_PROXY_COOKIE_CSRF_PER_REQUEST": "true",
		// But per-request cookies are UNIQUELY named (_oauth2_proxy_<nonce>_csrf)
		// and scoped to the parent cookie_domain, so a handshake that never
		// reaches /oauth2/callback (abandoned tab, prefetch, superseded redirect,
		// a background *.domain host) orphans its cookie for the full expiry —
		// and the browser then replays EVERY orphan to EVERY *.domain host on
		// every request. Left unbounded they stack up until the request header
		// blows past the ingress limit and the whole app starts returning
		// 431 Request Header Fields Too Large (observed live). PER_REQUEST_LIMIT
		// hard-caps how many CSRF cookies can exist at once: on each new
		// handshake oauth2-proxy evicts the oldest beyond the cap, so the header
		// contribution is bounded (~5 cookies) no matter how many logins churn
		// through. This needs oauth2-proxy >= the version pinned in
		// dockercompose.go (added mid-7.1x; earlier images silently ignore it).
		"OAUTH2_PROXY_COOKIE_CSRF_PER_REQUEST_LIMIT": "5",
		// 1h (default 15m) keeps a Keycloak login form that sat open a while
		// redeemable instead of 403ing at /oauth2/callback (the issue #47
		// follow-up). The PER_REQUEST_LIMIT above bounds the orphan pile-up
		// regardless of lifetime, so the longer expiry costs nothing.
		"OAUTH2_PROXY_COOKIE_CSRF_EXPIRE": "1h",
		// Bailey's own sign-in failure page instead of oauth2-proxy's stock
		// "500 — Oops! Something went wrong", which left a person whose Keycloak
		// email was unverified with nothing but a request ID. The templates are
		// written by writeProtectedProxyTemplates and mounted read-only.
		"OAUTH2_PROXY_CUSTOM_TEMPLATES_DIR": dockercompose.ProtectedProxyTemplatesTarget,
		// The real reason a callback failed travels in ErrorPageOpts.AppError,
		// which is NOT a field of the error-page template data — the only way a
		// template can see it is this switch, which makes .Message be the raw
		// error. Upstream warns against it because the stock page prints .Message
		// verbatim; ours never does. It matches .Message against a short allowlist
		// of prefixes (unverified email, oauth2-proxy's own "Login Failed:"
		// messages) and renders Bailey's copy for those, or a generic page naming
		// the checkable causes for everything else. See
		// protected_proxy_error_page.go, and the test that asserts a
		// leak-shaped error never reaches the rendered page.
		"OAUTH2_PROXY_SHOW_DEBUG_ON_ERROR": "true",
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

// loadOrCreateProxyCookieSecret returns the proxy's persisted cookie secret,
// generating one on first provision. Persisting it matters: the secret
// encrypts both sessions and the login state cookies, so rotating it on every
// re-provision (as we used to) recreates the container, logs everyone out, and
// 403s any login that was mid-handshake at /oauth2/callback — one more source
// of the "random 403 right after logging in" from issue #47. A file that went
// missing or corrupt just falls through to a fresh secret.
func loadOrCreateProxyCookieSecret(proxyDir string) (string, error) {
	path := filepath.Join(proxyDir, "cookie-secret")
	if b, err := os.ReadFile(path); err == nil {
		s := strings.TrimSpace(string(b))
		if raw, err := base64.URLEncoding.DecodeString(s); err == nil && len(raw) == 32 {
			return s, nil
		}
	}
	secret, err := generateProxyCookieSecret()
	if err != nil {
		return "", err
	}
	// 0600: the secret guards every session cookie on the domain.
	if err := os.WriteFile(path, []byte(secret), 0600); err != nil {
		return "", fmt.Errorf("persist protected-proxy cookie secret: %w", err)
	}
	return secret, nil
}

// writeProtectedProxyTemplates writes the proxy's custom page templates into
// <proxyDir>/templates, which the compose file mounts read-only into the
// container at dockercompose.ProtectedProxyTemplatesTarget. Called on every
// provision, so an updated daemon ships an updated page.
//
// Only error.html is written. oauth2-proxy falls back to its own default for any
// template the directory doesn't contain, and sign_in.html is never shown here:
// skip_provider_button sends people straight to Keycloak.
func writeProtectedProxyTemplates(proxyDir string) error {
	dir := filepath.Join(proxyDir, "templates")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create protected-proxy templates directory: %w", err)
	}
	// 0644: the proxy container reads these as a different user, and they hold
	// nothing secret.
	path := filepath.Join(dir, "error.html")
	if err := os.WriteFile(path, []byte(protectedProxyErrorTemplate()), 0644); err != nil {
		return fmt.Errorf("write protected-proxy error page: %w", err)
	}
	return nil
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
