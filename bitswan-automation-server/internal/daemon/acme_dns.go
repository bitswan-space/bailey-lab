package daemon

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/traefikapi"
)

// ACME DNS-01 bridge.
//
// Traefik's httpreq DNS-01 provider (lego) can only authenticate with HTTP
// basic auth, while the AOC's /api/automation_server/dns/acme-challenge/*
// endpoints require the automation server's Bearer token. The daemon bridges
// the two: Traefik is pointed (via HTTPREQ_ENDPOINT) at the daemon's TCP
// listener on the bitswan_network, and the daemon forwards present/cleanup
// calls to the AOC with its own credentials. This also keeps the AOC access
// token out of Traefik's environment.
const (
	// dnsCertResolverName is the Traefik certificatesResolver that issues
	// wildcard certificates via the DNS-01 challenge.
	dnsCertResolverName = "letsencrypt-dns"

	// acmeBridgeUsername is the basic-auth username Traefik uses against the
	// daemon's ACME DNS-01 bridge endpoints.
	acmeBridgeUsername = "traefik"

	// acmeBridgeSecretFile (inside the traefik config dir) holds the
	// basic-auth password shared between Traefik and the daemon.
	acmeBridgeSecretFile = "acme-httpreq-secret"

	// acmeBridgePath is the base path of the bridge endpoints on the daemon's
	// TCP listener. lego appends /present and /cleanup to HTTPREQ_ENDPOINT.
	acmeBridgePath = "/dns/acme-challenge"
)

// acmeBridgeEndpoint is the HTTPREQ_ENDPOINT URL handed to Traefik. The
// daemon container is reachable by name on the shared bitswan_network, and
// docsPort is the daemon's TCP listener.
func acmeBridgeEndpoint() string {
	return fmt.Sprintf("http://bitswan-automation-server-daemon:%d%s", docsPort, acmeBridgePath)
}

// getWildcardCertDomain returns the automation server's domain when the AOC
// is configured with one (e.g. acme-prod.bswn.io), or "" otherwise. A
// non-empty result means Traefik should obtain a *.<domain> wildcard
// certificate via the DNS-01 challenge.
func getWildcardCertDomain() string {
	cfg := config.NewAutomationServerConfig()
	settings, err := cfg.GetAutomationOperationsCenterSettings()
	if err != nil || settings.AccessToken == "" {
		return ""
	}
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(settings.Domain)), ".")
}

// getOrCreateACMEBridgeSecret returns the shared basic-auth secret, creating
// and persisting a new one on first use.
func getOrCreateACMEBridgeSecret(traefikConfigDir string) (string, error) {
	path := filepath.Join(traefikConfigDir, acmeBridgeSecretFile)
	if data, err := os.ReadFile(path); err == nil {
		if secret := strings.TrimSpace(string(data)); secret != "" {
			return secret, nil
		}
	}

	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("failed to generate ACME bridge secret: %w", err)
	}
	secret := hex.EncodeToString(buf)

	if err := os.MkdirAll(traefikConfigDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create traefik config directory: %w", err)
	}
	if err := os.WriteFile(path, []byte(secret+"\n"), 0600); err != nil {
		return "", fmt.Errorf("failed to write ACME bridge secret: %w", err)
	}
	return secret, nil
}

// loadACMEBridgeSecret returns the shared secret, or an error if it has not
// been generated yet (i.e. the ingress was never configured for DNS-01).
func loadACMEBridgeSecret() (string, error) {
	path := filepath.Join(os.Getenv("HOME"), ".config", "bitswan", "traefik", acmeBridgeSecretFile)
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("ACME bridge secret not available: %w", err)
	}
	secret := strings.TrimSpace(string(data))
	if secret == "" {
		return "", fmt.Errorf("ACME bridge secret file is empty")
	}
	return secret, nil
}

// certResolverForHostname picks the ACME cert resolver for a public route.
// Hostnames covered by the automation server's wildcard domain share one
// DNS-01 wildcard certificate; anything else gets a per-hostname HTTP-01
// certificate. Returns ("", nil) for .localhost hostnames, which use local
// certificates instead of ACME.
func certResolverForHostname(hostname string) (string, []traefikapi.TLSDomain) {
	if strings.HasSuffix(hostname, ".localhost") {
		return "", nil
	}
	if domain := getWildcardCertDomain(); domain != "" && traefikapi.HostCoveredByWildcard(hostname, domain) {
		return dnsCertResolverName, traefikapi.WildcardTLSDomains(domain)
	}
	return "letsencrypt", nil
}

// acmeChallengeFQDNAllowed reports whether an ACME DNS-01 challenge FQDN is
// in scope for this automation server: _acme-challenge.<domain> or
// _acme-challenge.<sub>.<domain>. The AOC enforces the same check
// server-side; this is defence in depth so a caller that obtained the bridge
// secret still can't relay arbitrary requests through the daemon.
func acmeChallengeFQDNAllowed(fqdn, domain string) bool {
	if fqdn == "" || domain == "" {
		return false
	}
	bare := strings.TrimSuffix(strings.ToLower(fqdn), ".")
	const prefix = "_acme-challenge."
	rest, found := strings.CutPrefix(bare, prefix)
	if !found || rest == "" {
		return false
	}
	return rest == domain || strings.HasSuffix(rest, "."+domain)
}

// acmeDNSChallengeRequest matches the body lego's httpreq provider sends.
type acmeDNSChallengeRequest struct {
	FQDN  string `json:"fqdn"`
	Value string `json:"value"`
}

// handleACMEDNSChallenge returns a handler for one bridge action ("present"
// or "cleanup"). It is served on the daemon's TCP listener, which is
// reachable from other containers on the bitswan_network, so it requires
// basic auth with the shared bridge secret.
func (s *Server) handleACMEDNSChallenge(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		secret, err := loadACMEBridgeSecret()
		if err != nil {
			writeJSONError(w, "ACME DNS-01 bridge is not configured", http.StatusServiceUnavailable)
			return
		}
		user, pass, ok := r.BasicAuth()
		if !ok ||
			subtle.ConstantTimeCompare([]byte(user), []byte(acmeBridgeUsername)) != 1 ||
			subtle.ConstantTimeCompare([]byte(pass), []byte(secret)) != 1 {
			w.Header().Set("WWW-Authenticate", `Basic realm="bitswan-acme-bridge"`)
			writeJSONError(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		var req acmeDNSChallengeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSONError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
			return
		}
		if req.FQDN == "" || req.Value == "" {
			writeJSONError(w, "fqdn and value are both required", http.StatusBadRequest)
			return
		}

		domain := getWildcardCertDomain()
		if domain == "" {
			writeJSONError(w, "no AOC wildcard domain configured", http.StatusServiceUnavailable)
			return
		}
		if !acmeChallengeFQDNAllowed(req.FQDN, domain) {
			writeJSONError(w, fmt.Sprintf("fqdn %q is not under this server's domain (%s)", req.FQDN, domain), http.StatusForbidden)
			return
		}

		aocClient, err := aoc.NewAOCClient()
		if err != nil {
			writeJSONError(w, "AOC is not configured: "+err.Error(), http.StatusServiceUnavailable)
			return
		}

		switch action {
		case "present":
			err = aocClient.PresentDNSChallenge(req.FQDN, req.Value)
		case "cleanup":
			err = aocClient.CleanupDNSChallenge(req.FQDN, req.Value)
		default:
			writeJSONError(w, "unknown action", http.StatusNotFound)
			return
		}
		if err != nil {
			fmt.Printf("ACME DNS-01 %s failed for %s: %v\n", action, req.FQDN, err)
			writeJSONError(w, err.Error(), http.StatusBadGateway)
			return
		}

		fmt.Printf("ACME DNS-01 %s forwarded to AOC for %s\n", action, req.FQDN)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}
}
