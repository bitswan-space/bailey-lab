package daemon

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestKeycloakHostFromIssuer(t *testing.T) {
	cases := map[string]string{
		"https://keycloak.staging2.bitswan.ai/realms/master": "keycloak.staging2.bitswan.ai",
		"https://kc.example.com/auth/realms/master":          "kc.example.com",
		"http://keycloak.bitswan.localhost/realms/master":    "keycloak.bitswan.localhost",
		"":          "",
		"not a url": "",
	}
	for issuer, want := range cases {
		if got := keycloakHostFromIssuer(issuer); got != want {
			t.Errorf("keycloakHostFromIssuer(%q) = %q, want %q", issuer, got, want)
		}
	}
}

func TestGenerateProxyCookieSecret(t *testing.T) {
	s, err := generateProxyCookieSecret()
	if err != nil {
		t.Fatalf("generateProxyCookieSecret: %v", err)
	}
	raw, err := base64.URLEncoding.DecodeString(s)
	if err != nil {
		t.Fatalf("cookie secret is not valid base64url: %v", err)
	}
	if len(raw) != 32 {
		t.Errorf("cookie secret decodes to %d bytes, want 32 (AES-256)", len(raw))
	}
}

func TestProtectedProxyOAuthEnv(t *testing.T) {
	const (
		domain = "timssandbox2.bswn.io"
		issuer = "https://keycloak.staging2.bitswan.ai/realms/master"
	)
	env := protectedProxyOAuthEnv(domain, "client-id", "client-secret", issuer, "cookie-secret")

	want := map[string]string{
		"OAUTH2_PROXY_PROVIDER":          "oidc",
		"OAUTH2_PROXY_OIDC_ISSUER_URL":   issuer,
		"OAUTH2_PROXY_CLIENT_ID":         "client-id",
		"OAUTH2_PROXY_CLIENT_SECRET":     "client-secret",
		"OAUTH2_PROXY_COOKIE_SECRET":     "cookie-secret",
		"OAUTH2_PROXY_HTTP_ADDRESS":      "0.0.0.0:80",
		"OAUTH2_PROXY_UPSTREAMS":         "http://bitswan-automation-server-daemon:9080",
		"OAUTH2_PROXY_EMAIL_DOMAINS":     "*",
		"OAUTH2_PROXY_COOKIE_DOMAINS":    ".timssandbox2.bswn.io",
		"OAUTH2_PROXY_WHITELIST_DOMAINS": ".timssandbox2.bswn.io,keycloak.staging2.bitswan.ai",
		"OAUTH2_PROXY_REVERSE_PROXY":     "true",
		"OAUTH2_PROXY_PASS_USER_HEADERS": "true",
		"OAUTH2_PROXY_SET_XAUTHREQUEST":  "true",
		"OAUTH2_PROXY_OIDC_GROUPS_CLAIM": "group_membership",
	}
	for k, v := range want {
		if env[k] != v {
			t.Errorf("env[%q] = %q, want %q", k, env[k], v)
		}
	}

	// The proxy fronts many hostnames, so it must NOT pin a single redirect
	// URL — the callback is derived per-request from the request host.
	if _, ok := env["OAUTH2_PROXY_REDIRECT_URL"]; ok {
		t.Errorf("env must not set OAUTH2_PROXY_REDIRECT_URL (per-host redirect derivation), got %q", env["OAUTH2_PROXY_REDIRECT_URL"])
	}
	// whitelist_domains must carry the IdP host so the logout rd= is honoured.
	if !strings.Contains(env["OAUTH2_PROXY_WHITELIST_DOMAINS"], "keycloak.staging2.bitswan.ai") {
		t.Errorf("whitelist_domains missing IdP host: %q", env["OAUTH2_PROXY_WHITELIST_DOMAINS"])
	}
}

func TestProtectedProxyOAuthEnvUnparseableIssuer(t *testing.T) {
	// When the issuer host can't be derived, whitelist is just the domain.
	env := protectedProxyOAuthEnv("example.com", "id", "secret", "", "cookie")
	if got := env["OAUTH2_PROXY_WHITELIST_DOMAINS"]; got != ".example.com" {
		t.Errorf("whitelist_domains = %q, want \".example.com\"", got)
	}
}
