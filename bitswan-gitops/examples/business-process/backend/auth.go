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
	"time"

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
//   - at least one issuer → AOC mode: validate Bearer JWTs against the JWKS of
//     whichever accepted issuer the token names. Nothing to report.
//   - authMode "aoc" without an issuer → FATAL. The platform is
//     AOC-connected and should have injected KEYCLOAK_ISSUER_URL; running
//     anyway would silently trust every request (this exact silent degrade
//     is how a misdeployed app once granted everyone admin).
//   - a deployed stage without an issuer → the platform has no identity
//     provider at all; the Bailey gate upstream is the only authentication.
//     Warn loudly so the posture is visible in the logs.
//   - neither → genuinely local development; quiet simple mode.
func resolveAuthStartup(issuers []string, authMode, stage string) (fatal, warning string) {
	switch {
	case len(issuers) > 0:
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

// parseIssuerList splits the platform-injected issuer setting into the issuers
// this worker will accept. It is a LIST because a server can have more than one
// provider at once: Bitswan accounts, an admin's own OIDC provider behind the
// broker, and the coding agent's issuer on a live-dev deployment. A worker that
// only ever trusted one of them would 401 every caller who signed in through
// another — which is not a configuration mistake, it is the normal shape of a
// server with a second provider.
func parseIssuerList(raw string) []string {
	out := []string{}
	for _, part := range strings.Split(raw, ",") {
		if p := strings.TrimRight(strings.TrimSpace(part), "/"); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// JWKSSet holds one JWKSProvider per accepted issuer and picks between them by
// the token's own iss claim.
//
// Reading iss before the signature is checked is safe here and only here: it
// selects WHICH keys to verify against, and an unknown iss is refused outright.
// A forged iss therefore buys nothing — the token still has to be signed by the
// issuer it names.
type JWKSSet struct {
	providers map[string]*JWKSProvider
	issuers   []string
}

func NewJWKSSet(issuers []string) *JWKSSet {
	s := &JWKSSet{providers: map[string]*JWKSProvider{}, issuers: issuers}
	for _, iss := range issuers {
		s.providers[iss] = NewJWKSProvider(iss)
	}
	return s
}

// keyFor returns the verification key for a token naming issuer iss, or an
// error naming what this worker does accept.
func (s *JWKSSet) keyFor(iss, kid string) (*rsa.PublicKey, error) {
	p, ok := s.providers[strings.TrimRight(strings.TrimSpace(iss), "/")]
	if !ok {
		return nil, fmt.Errorf("token issuer %q is not one this deployment accepts (%s)",
			iss, strings.Join(s.issuers, ", "))
	}
	return p.getKey(kid)
}

// JWKSProvider fetches and caches RSA public keys from the issuer's JWKS
// endpoint. The endpoint is discovered rather than assumed: a server whose
// admin has added their own identity provider authenticates through a broker,
// which publishes its keys somewhere other than Keycloak's path.
type JWKSProvider struct {
	issuerURL string
	jwksURL   string
	mu        sync.Mutex
	keys      map[string]*rsa.PublicKey
}

func NewJWKSProvider(issuerURL string) *JWKSProvider {
	return &JWKSProvider{issuerURL: strings.TrimRight(issuerURL, "/")}
}

// resolveJWKSURL reads jwks_uri from the issuer's discovery document, falling
// back to Keycloak's well-known path when the issuer cannot be reached or does
// not advertise one. Resolved once and remembered.
func (p *JWKSProvider) resolveJWKSURL() string {
	if p.jwksURL != "" {
		return p.jwksURL
	}
	p.jwksURL = p.issuerURL + "/protocol/openid-connect/certs"

	client := &http.Client{
		Timeout:   10 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}},
	}
	resp, err := client.Get(p.issuerURL + "/.well-known/openid-configuration")
	if err != nil {
		return p.jwksURL
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return p.jwksURL
	}
	var doc struct {
		JWKSURI string `json:"jwks_uri"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil || doc.JWKSURI == "" {
		return p.jwksURL
	}
	p.jwksURL = doc.JWKSURI
	return p.jwksURL
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
	resp, err := client.Get(p.resolveJWKSURL())
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
			claims, _ := t.Claims.(jwtv5.MapClaims)
			iss, _ := claims["iss"].(string)
			return app.jwks.keyFor(iss, kid)
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
	for _, g := range claimGroups(claims) {
		if g == group {
			return true
		}
	}
	return false
}

// rawGroupClaim returns the group list from the token, under whichever name
// the thing that issued it uses: Keycloak emits group_membership, the broker
// that fronts sign-in once a server adds its own identity provider emits
// groups. Keycloak's name wins when a token carries both.
func rawGroupClaim(claims jwtv5.MapClaims) []interface{} {
	for _, name := range []string{"group_membership", "groups"} {
		if raw, ok := claims[name].([]interface{}); ok && len(raw) > 0 {
			return raw
		}
	}
	return nil
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

// claimGroups returns the org-scoped group paths from the verified group
// claim (e.g. ["/Example Org", "/Example Org/admin"]).
func claimGroups(claims jwtv5.MapClaims) []string {
	groups := []string{}
	if claims == nil {
		return groups
	}
	for _, g := range rawGroupClaim(claims) {
		if s, ok := g.(string); ok {
			groups = append(groups, s)
		}
	}
	return groups
}
