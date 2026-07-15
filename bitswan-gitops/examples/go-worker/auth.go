package main

import (
	"context"
	"crypto/rsa"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"os"
	"strings"
	"sync"

	jwtv5 "github.com/golang-jwt/jwt/v5"
)

var (
	allowedGroup      string
	adminGroup        string
	groupCheckEnabled bool
)

func init() {
	allowedGroup = os.Getenv("BITSWAN_ALLOWED_GROUP")
	groupCheckEnabled = allowedGroup != ""
	if !groupCheckEnabled {
		// Simple-mode (no AOC): the platform does not inject BITSWAN_ALLOWED_GROUP
		// because the Bailey protected gate in front already authenticates every
		// request. Run without per-request group gating rather than refusing to
		// start — the example must work in the default simple deployment.
		log.Println("BITSWAN_ALLOWED_GROUP not set — simple mode: the Bailey gate enforces access; skipping per-request group membership checks.")
	}
	adminGroup = deriveAdminGroup(os.Getenv("BITSWAN_ADMIN_GROUP"), allowedGroup)
}

// deriveAdminGroup resolves the group whose members are admins: the explicit
// BITSWAN_ADMIN_GROUP when set, otherwise the platform convention — the AOC
// provisions an `admin` child group under every org group, so the default is
// {BITSWAN_ALLOWED_GROUP}/admin (e.g. "/Example Org/admin"). Empty when
// neither is available: admin checks then fail closed.
func deriveAdminGroup(explicit, allowed string) string {
	if explicit != "" {
		return explicit
	}
	if allowed != "" {
		return allowed + "/admin"
	}
	return ""
}

// resolveAuthStartup decides the worker's auth posture from the
// platform-injected env (see README.md, "Identity & admin contract").
// Returned fatal/warning messages are for main to act on; token
// verification itself is keyed on KEYCLOAK_ISSUER_URL being set.
//
//   - issuerURL set → AOC mode: validate Bearer JWTs against the issuer's
//     JWKS. Nothing to report.
//   - authMode "aoc" without an issuer → FATAL. The platform is
//     AOC-connected and should have injected KEYCLOAK_ISSUER_URL; running
//     anyway would silently trust every request (this exact silent degrade
//     is how a misdeployed app once granted everyone admin).
//   - a deployed stage without an issuer → the platform has no identity
//     provider at all; the Bailey gate upstream is the only authentication.
//     Warn loudly so the posture is visible in the logs.
//   - neither → genuinely local development; quiet simple mode.
func resolveAuthStartup(issuerURL, authMode, stage string) (fatal, warning string) {
	switch {
	case issuerURL != "":
		return "", ""
	case authMode == "aoc":
		return "KEYCLOAK_ISSUER_URL is not set, but BITSWAN_AUTH_MODE=aoc means this platform is AOC-connected and should have injected it. " +
			"Refusing to start without token verification — every request would be trusted unverified. " +
			"This is a platform misconfiguration: re-run `bitswan workspace update` (or check the automation server's AOC connection), then redeploy.", ""
	case stage != "":
		return "", "deployed stage " + stage + " without KEYCLOAK_ISSUER_URL — this backend cannot verify identities itself and fully trusts the upstream Bailey gate. Never expose it except through the gate."
	default:
		return "", ""
	}
}

type contextKey string

const claimsKey contextKey = "claims"

// JWKSProvider fetches and caches RSA public keys from a Keycloak JWKS endpoint.
type JWKSProvider struct {
	jwksURL string
	mu      sync.Mutex
	keys    map[string]*rsa.PublicKey
}

func NewJWKSProvider(issuerURL string) *JWKSProvider {
	return &JWKSProvider{
		jwksURL: issuerURL + "/protocol/openid-connect/certs",
	}
}

type jwksResponse struct {
	Keys []jwkKey `json:"keys"`
}

type jwkKey struct {
	Kid string `json:"kid"`
	N   string `json:"n"`
	E   string `json:"e"`
}

func (p *JWKSProvider) fetchKeys() error {
	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
	}
	resp, err := client.Get(p.jwksURL)
	if err != nil {
		return fmt.Errorf("fetching JWKS: %w", err)
	}
	defer resp.Body.Close()

	var jwks jwksResponse
	if err := json.NewDecoder(resp.Body).Decode(&jwks); err != nil {
		return fmt.Errorf("decoding JWKS: %w", err)
	}

	keys := make(map[string]*rsa.PublicKey, len(jwks.Keys))
	for _, k := range jwks.Keys {
		nBytes, err := base64.RawURLEncoding.DecodeString(k.N)
		if err != nil {
			continue
		}
		eBytes, err := base64.RawURLEncoding.DecodeString(k.E)
		if err != nil {
			continue
		}
		n := new(big.Int).SetBytes(nBytes)
		e := 0
		for _, b := range eBytes {
			e = e<<8 + int(b)
		}
		keys[k.Kid] = &rsa.PublicKey{N: n, E: e}
	}
	p.keys = keys
	return nil
}

func (p *JWKSProvider) getKey(kid string) (*rsa.PublicKey, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.keys != nil {
		if key, ok := p.keys[kid]; ok {
			return key, nil
		}
	}
	// Refetch once on miss (key rotation).
	if err := p.fetchKeys(); err != nil {
		return nil, err
	}
	key, ok := p.keys[kid]
	if !ok {
		return nil, fmt.Errorf("unknown signing key kid=%s", kid)
	}
	return key, nil
}

// requireAuth returns middleware that validates a Bearer JWT and stores claims in context.
func (app *App) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Simple mode (no JWKS provider configured): the Bailey gate has already
		// authenticated this request upstream, so trust it and pass through.
		if app.jwks == nil {
			next.ServeHTTP(w, r)
			return
		}
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			writeError(w, http.StatusUnauthorized, "Missing authorization token")
			return
		}
		tokenStr := strings.TrimPrefix(auth, "Bearer ")

		token, err := jwtv5.Parse(tokenStr, func(t *jwtv5.Token) (any, error) {
			if _, ok := t.Method.(*jwtv5.SigningMethodRSA); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
			}
			kid, _ := t.Header["kid"].(string)
			return app.jwks.getKey(kid)
		})
		if err != nil {
			writeError(w, http.StatusUnauthorized, "Invalid token: "+err.Error())
			return
		}

		claims, ok := token.Claims.(jwtv5.MapClaims)
		if !ok || !token.Valid {
			writeError(w, http.StatusUnauthorized, "Invalid token claims")
			return
		}

		// Verify group membership — only when a group is configured (AOC mode).
		if groupCheckEnabled && !hasGroup(claims, allowedGroup) {
			writeError(w, http.StatusForbidden, "User not in required group: "+allowedGroup)
			return
		}

		ctx := context.WithValue(r.Context(), claimsKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// requireAdmin returns middleware that, on top of requireAuth, only admits
// members of the admin group (BITSWAN_ADMIN_GROUP, default
// {BITSWAN_ALLOWED_GROUP}/admin). With verified identities this fails
// closed: there is NO implicit admin — an authenticated user without the
// admin group in their verified group_membership claim gets 403, in every
// stage. In simple mode (no JWKS provider — genuinely local development)
// there is no verified identity to key on and requireAuth already passes
// the fully-trusted request through, so this does too.
func (app *App) requireAdmin(next http.Handler) http.Handler {
	return app.requireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if app.jwks == nil {
			next.ServeHTTP(w, r)
			return
		}
		claims, _ := r.Context().Value(claimsKey).(jwtv5.MapClaims)
		if !isAdmin(claims) {
			writeError(w, http.StatusForbidden, "Admin group membership required: "+adminGroup)
			return
		}
		next.ServeHTTP(w, r)
	}))
}

// isAdmin reports whether the verified claims place the caller in the admin
// group. Fail-closed: no admin group configured, or no group_membership
// claim, means not admin.
func isAdmin(claims jwtv5.MapClaims) bool {
	return adminGroup != "" && hasGroup(claims, adminGroup)
}

func hasGroup(claims jwtv5.MapClaims, group string) bool {
	rawGroups, ok := claims["group_membership"].([]interface{})
	if !ok {
		return false
	}
	for _, g := range rawGroups {
		if s, ok := g.(string); ok && s == group {
			return true
		}
	}
	return false
}

func getUsername(r *http.Request) string {
	if u := claimString(claimsFrom(r), "preferred_username"); u != "" {
		return u
	}
	return "anonymous"
}

// claimsFrom returns the verified token claims requireAuth stored on the
// request, or nil in simple mode. Identity is ALWAYS read from these
// verified claims — never from forwarded headers, which the gate strips
// for user apps by design.
func claimsFrom(r *http.Request) jwtv5.MapClaims {
	claims, _ := r.Context().Value(claimsKey).(jwtv5.MapClaims)
	return claims
}

func claimString(claims jwtv5.MapClaims, key string) string {
	if claims == nil {
		return ""
	}
	s, _ := claims[key].(string)
	return s
}

// claimGroups returns the org-scoped group paths from the verified
// group_membership claim (e.g. ["/Example Org", "/Example Org/admin"]).
func claimGroups(claims jwtv5.MapClaims) []string {
	groups := []string{}
	if claims == nil {
		return groups
	}
	raw, _ := claims["group_membership"].([]interface{})
	for _, g := range raw {
		if s, ok := g.(string); ok {
			groups = append(groups, s)
		}
	}
	return groups
}
