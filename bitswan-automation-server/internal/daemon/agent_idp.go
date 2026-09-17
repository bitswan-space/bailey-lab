package daemon

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/traefikapi"
)

// The coding agent's identity provider (issue #210).
//
// The agent needs to open a live-dev frontend as a user, with a group layout it
// chooses, so it can see what a person sees. Doing that with a Keycloak account
// would mean minting real identities in the directory the whole platform trusts
// — for a robot, with credentials living in a container that runs
// member-authored code.
//
// So it does not. This is a second issuer the server runs itself, for test
// users only. It is the same shape as the broker the server already stands up
// when an admin adds their own OIDC provider (dex.go): an issuer of our own in
// front of identities Keycloak never learns about. The difference is that this
// one's users are invented by the agent rather than federated from a directory,
// which is exactly why its tokens are only ever accepted on live-dev.
//
// It signs, and never verifies. There is no login here, no authorization
// endpoint and no session: the agent's browser is handed a session cookie by
// the CLI, the gate exchanges that cookie for one of these identities, and this
// file's only job is to produce the bearer token the app's backend will check
// against the JWKS below.

const (
	// agentJWKSPath is where the key set lives. The discovery path next to it is
	// fixed by the spec, and a worker builds it by appending to the issuer — so
	// both documents are served at the ROOT of the issuer host, not under the
	// gate's path prefix. Get this wrong and discovery 404s with a token that
	// otherwise looks perfect.
	agentJWKSPath      = "/keys"
	agentDiscoveryPath = "/.well-known/openid-configuration"

	// agentTokenTTL is short: a token is minted per request from a session that
	// is itself revocable, so there is no reason to hand out a long-lived one.
	agentTokenTTL = 10 * time.Minute
)

// agentIssuerHost is the issuer's hostname — one label under the server's own
// domain, so the wildcard certificate it already holds covers it. Anything
// deeper would need a certificate of its own, which is the trap derivePublicHost
// documents for published endpoints.
func agentIssuerHost(domain string) string {
	return "agent-auth." + strings.TrimPrefix(domain, ".")
}

func agentIssuerURL(domain string) string {
	return "https://" + agentIssuerHost(domain)
}

// currentAgentIssuerURL is the issuer for this server, or "" when no domain is
// registered yet (in which case the feature is simply unavailable).
func currentAgentIssuerURL() string {
	domain := protectedHostnameDomain()
	if domain == "" {
		return ""
	}
	return agentIssuerURL(domain)
}

func agentIDPDir() string {
	return filepath.Join(os.Getenv("HOME"), ".config", "bitswan", "agent-idp")
}

var (
	agentKeyMu  sync.Mutex
	agentKeyVal *rsa.PrivateKey
)

// loadOrCreateAgentKey returns the issuer's signing key, generating it on first
// use. Same handling as the broker's client secret (login_topology.go): 0600 in
// the daemon's own config dir, created once and reused, so the JWKS a deployed
// worker cached stays valid across daemon restarts.
func loadOrCreateAgentKey() (*rsa.PrivateKey, error) {
	agentKeyMu.Lock()
	defer agentKeyMu.Unlock()
	if agentKeyVal != nil {
		return agentKeyVal, nil
	}
	dir := agentIDPDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create agent-idp directory: %w", err)
	}
	path := filepath.Join(dir, "key.pem")
	if b, err := os.ReadFile(path); err == nil && len(b) > 0 {
		block, _ := pem.Decode(b)
		if block == nil {
			return nil, fmt.Errorf("agent-idp key at %s is not PEM", path)
		}
		key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse agent-idp key: %w", err)
		}
		agentKeyVal = key
		return key, nil
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, fmt.Errorf("generate agent-idp key: %w", err)
	}
	encoded := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	})
	if err := os.WriteFile(path, encoded, 0600); err != nil {
		return nil, fmt.Errorf("write agent-idp key: %w", err)
	}
	agentKeyVal = key
	return key, nil
}

// agentKeyID names the key in the JWKS and in every token header. It is derived
// from the public key itself, so it changes if and only if the key does.
func agentKeyID(key *rsa.PrivateKey) string {
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return "agent"
	}
	sum := sha256.Sum256(der)
	return base64.RawURLEncoding.EncodeToString(sum[:16])
}

func b64u(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// mintAgentToken issues a bearer token for one test identity.
//
// The group claim is written under BOTH names the platform's workers know:
// Keycloak emits group_membership, the broker that fronts sign-in once a server
// adds its own identity provider emits groups, and a worker accepts either. An
// issuer that used only one of them would work against half the deployments.
func mintAgentToken(id agentIdentity, issuer string) (string, error) {
	key, err := loadOrCreateAgentKey()
	if err != nil {
		return "", err
	}
	now := time.Now().UTC()
	header := map[string]any{"alg": "RS256", "typ": "JWT", "kid": agentKeyID(key)}
	groups := id.Groups
	if groups == nil {
		groups = []string{}
	}
	claims := map[string]any{
		"iss":                issuer,
		"sub":                "agent:" + id.Label,
		"aud":                "bitswan-agent",
		"azp":                "bitswan-agent",
		"iat":                now.Unix(),
		"exp":                now.Add(agentTokenTTL).Unix(),
		"email":              id.Email,
		"email_verified":     true,
		"preferred_username": id.Email,
		"name":               id.Label,
		"group_membership":   groups,
		"groups":             groups,
	}
	headerJSON, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signing := b64u(headerJSON) + "." + b64u(claimsJSON)
	digest := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", fmt.Errorf("sign agent token: %w", err)
	}
	return signing + "." + b64u(sig), nil
}

var (
	agentTokenMu    sync.Mutex
	agentTokenCache = map[string]agentCachedToken{}
)

type agentCachedToken struct {
	token   string
	expires time.Time
}

// agentAccessToken is mintAgentToken with a cache, so a page that calls
// /oauth2/auth on every request does not re-sign each time. Refreshes at ~80%
// of the token's life, the same rule anonAccessToken uses.
func agentAccessToken(id agentIdentity, issuer string) (string, error) {
	agentTokenMu.Lock()
	defer agentTokenMu.Unlock()
	key := id.Label + "|" + issuer
	if c, ok := agentTokenCache[key]; ok && time.Now().Before(c.expires) {
		return c.token, nil
	}
	tok, err := mintAgentToken(id, issuer)
	if err != nil {
		return "", err
	}
	agentTokenCache[key] = agentCachedToken{
		token:   tok,
		expires: time.Now().Add(agentTokenTTL * 8 / 10),
	}
	return tok, nil
}

// forgetAgentTokens drops a label's cached token, so a change to its groups is
// visible on the next request rather than up to a token lifetime later.
func forgetAgentTokens(label string) {
	agentTokenMu.Lock()
	defer agentTokenMu.Unlock()
	for k := range agentTokenCache {
		if strings.HasPrefix(k, label+"|") {
			delete(agentTokenCache, k)
		}
	}
}

// upstreamIssuerURL is the identity provider a worker would otherwise verify
// against: the broker when an admin has added their own provider, else the one
// the AOC hands out. Empty when neither can be resolved.
func upstreamIssuerURL() string {
	if iss := strings.TrimSpace(os.Getenv("KEYCLOAK_URL")); iss != "" {
		return strings.TrimRight(iss, "/")
	}
	if iss := brokeredWorkerIssuer(); iss != "" {
		return strings.TrimRight(iss, "/")
	}
	domain := protectedHostnameDomain()
	if domain == "" {
		return ""
	}
	cl, err := aocProtectedOAuthClient(domain)
	if err != nil || cl == nil {
		return ""
	}
	return strings.TrimRight(cl.IssuerURL, "/")
}

var (
	upstreamKeysMu  sync.Mutex
	upstreamKeysVal []any
	upstreamKeysExp time.Time
)

// upstreamKeys returns the identity provider's own signing keys, cached.
//
// They are republished in this issuer's key set so that a live-dev worker
// verifying against it still accepts a REAL person's token. Without that, one
// deployment could be browsed by the agent or by a human, never both.
//
// A failure serves the last set we had rather than nothing: dropping the real
// provider's keys would 401 every person using that live-dev app, which is a
// far worse outcome than a stale key set (keys rotate rarely, and an unknown
// kid is refetched by the worker anyway).
func upstreamKeys() []any {
	upstreamKeysMu.Lock()
	defer upstreamKeysMu.Unlock()
	if upstreamKeysVal != nil && time.Now().Before(upstreamKeysExp) {
		return upstreamKeysVal
	}
	keys, err := fetchUpstreamKeys(upstreamIssuerURL())
	if err != nil {
		fmt.Printf("Warning: could not refresh the identity provider's keys for the agent issuer: %v\n", err)
		if upstreamKeysVal != nil {
			upstreamKeysExp = time.Now().Add(time.Minute)
			return upstreamKeysVal
		}
		return nil
	}
	upstreamKeysVal = keys
	upstreamKeysExp = time.Now().Add(10 * time.Minute)
	return keys
}

func fetchUpstreamKeys(issuer string) ([]any, error) {
	if issuer == "" {
		return nil, fmt.Errorf("no identity provider configured")
	}
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Get(issuer + agentDiscoveryPath)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var doc struct {
		JWKSURI string `json:"jwks_uri"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return nil, err
	}
	// Keycloak's path is the fallback for a provider whose discovery document
	// does not advertise one — the same fallback the workers use.
	jwksURL := doc.JWKSURI
	if jwksURL == "" {
		jwksURL = issuer + "/protocol/openid-connect/certs"
	}
	kresp, err := client.Get(jwksURL)
	if err != nil {
		return nil, err
	}
	defer kresp.Body.Close()
	var set struct {
		Keys []any `json:"keys"`
	}
	if err := json.NewDecoder(kresp.Body).Decode(&set); err != nil {
		return nil, err
	}
	if len(set.Keys) == 0 {
		return nil, fmt.Errorf("%s published no keys", jwksURL)
	}
	return set.Keys, nil
}

// serveAgentIDP answers the two documents a token consumer needs: discovery and
// the key set. Workers resolve the JWKS from the discovery document rather than
// assuming a provider's path, so this pair is the whole contract.
//
// Both are public by construction — a JWKS is public key material, and the
// discovery document says only where it lives. They are served UNAUTHENTICATED
// and before the device gate, because the consumer is a worker container with
// no session, not a browser.
func serveAgentIDP(w http.ResponseWriter, r *http.Request) bool {
	domain := protectedHostnameDomain()
	if domain == "" {
		return false
	}
	if !strings.EqualFold(toOuterHost(requestEndpointHost(r)), agentIssuerHost(domain)) {
		return false
	}
	issuer := agentIssuerURL(domain)
	switch strings.TrimSuffix(r.URL.Path, "/") {
	case agentDiscoveryPath:
		writeAgentJSON(w, map[string]any{
			"issuer":                                issuer,
			"jwks_uri":                              issuer + agentJWKSPath,
			"response_types_supported":              []string{"token"},
			"subject_types_supported":               []string{"public"},
			"id_token_signing_alg_values_supported": []string{"RS256"},
			"claims_supported": []string{
				"iss", "sub", "aud", "exp", "iat", "email", "email_verified",
				"preferred_username", "name", "groups", "group_membership",
			},
		})
		return true
	case agentJWKSPath:
		key, err := loadOrCreateAgentKey()
		if err != nil {
			http.Error(w, "agent issuer key unavailable: "+err.Error(), http.StatusInternalServerError)
			return true
		}
		// Ours FIRST, then the identity provider's own, so a live-dev worker
		// pointed at this issuer accepts both the agent and a real person.
		keys := []any{map[string]any{
			"kty": "RSA",
			"use": "sig",
			"alg": "RS256",
			"kid": agentKeyID(key),
			"n":   b64u(key.PublicKey.N.Bytes()),
			"e":   b64u(big.NewInt(int64(key.PublicKey.E)).Bytes()),
		}}
		keys = append(keys, upstreamKeys()...)
		writeAgentJSON(w, map[string]any{"keys": keys})
		return true
	}
	return false
}

func writeAgentJSON(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(body)
}

// registerAgentIssuerRoute publishes the issuer host so a deployed worker can
// fetch the discovery document and the keys. It points at the gate, which
// serves them from serveAgentIDP.
func registerAgentIssuerRoute(domain string) {
	host := agentIssuerHost(domain)
	resolver, tlsDomains := certResolverForHostname(host)
	upstream := daemonContainerName + gateListenAddr
	if err := traefikapi.AddRouteWithTLSDomains(host, upstream, "", resolver, tlsDomains); err != nil {
		fmt.Printf("Warning: register agent issuer route for %s: %v\n", host, err)
	}
}
