package daemon

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/relay"
)

// relayLocalTarget is where the daemon splices relayed browser streams: this
// server's OWN Traefik, which terminates TLS with the real *.<domain>
// certificate. Reachable in-network as traefik:443 (both containers share
// bitswan_network); overridable for unusual deployments.
func relayLocalTarget() string {
	if t := os.Getenv("BITSWAN_RELAY_LOCAL_TARGET"); t != "" {
		return t
	}
	return "traefik:443"
}

// startRelayTunnel launches the reverse-proxy tunnel client when this server is
// on the relay path (force-proxy config OR the AOC reports it proxied). It is a
// no-op otherwise, and idempotent — safe to call both at daemon startup and
// again from register once the AOC has provisioned the proxy path.
func (s *Server) startRelayTunnel() {
	s.relayMu.Lock()
	if s.relayStarted {
		s.relayMu.Unlock()
		return // tunnel already running
	}
	cfg := config.NewAutomationServerConfig()
	settings, err := cfg.GetAutomationOperationsCenterSettings()
	if err != nil || settings == nil || settings.AccessToken == "" || settings.Domain == "" {
		s.relayMu.Unlock()
		return // not registered, or no domain
	}

	// A private server never dials the relay — full stop, before we even ask the
	// AOC. The relay is the AOC's uniform default for its own domains, so a
	// server deployed behind a VPN would otherwise be re-published to the public
	// internet through the relay on the next daemon restart. This local pin is
	// what makes that impossible rather than merely unlikely: it holds even if
	// the AOC's record for this server is wrong, is changed later, or the AOC is
	// rolled back to a build that doesn't know about private servers.
	if settings.Private {
		s.relayMu.Unlock()
		fmt.Printf("relay: this server is registered as private (reached over a VPN or LAN at %s) — "+
			"not dialing the AOC relay\n", privateAddressLabel(settings.PrivateAddress))
		return
	}

	// Resolve the relay endpoint. Two sources, in order:
	//   1. Local config set by `register --force-proxy` (--relay-addr /
	//      --relay-fingerprint) — the testing path, forces the proxy on a
	//      public-IP server.
	//   2. The AOC, which is the source of truth for real deployments: it knows
	//      whether this server is proxied (domain_status) and where the relay is.
	// This means a NAT'd server needs NO hand-configuration — the AOC tells it.
	relayAddr, relayFingerprint := settings.RelayAddr, settings.RelayFingerprint
	forced := settings.Proxied && relayAddr != "" && relayFingerprint != ""
	if !forced {
		info, ierr := fetchRelayInfoFromAOC(settings.AOCUrl, settings.AccessToken)
		if ierr != nil {
			s.relayMu.Unlock()
			fmt.Printf("relay: could not fetch relay info from AOC: %v\n", ierr)
			return
		}
		if !info.Proxied {
			s.relayMu.Unlock()
			return // AOC says this server is directly addressed — no tunnel
		}
		if info.RelayAddr == "" || info.RelayFingerprint == "" {
			s.relayMu.Unlock()
			fmt.Printf("relay: AOC marks this server proxied but advertises no relay endpoint; cannot start tunnel\n")
			return
		}
		relayAddr, relayFingerprint = info.RelayAddr, info.RelayFingerprint
	}

	client := relay.NewClient(relay.ClientConfig{
		RelayAddr:        relayAddr,
		RelayFingerprint: relayFingerprint,
		AOCApiURL:        settings.AOCUrl,
		Token:            settings.AccessToken,
		Subdomain:        settings.Domain,
		LocalTarget:      relayLocalTarget(),
	})

	s.relayStarted = true
	s.relayMu.Unlock()

	fmt.Printf("relay: server is on the reverse-proxy path; dialing relay %s for %s\n",
		relayAddr, settings.Domain)

	ctx := context.Background()
	go func() {
		if err := client.Run(ctx); err != nil && ctx.Err() == nil {
			fmt.Printf("relay: tunnel client exited: %v\n", err)
		}
	}()
}

// verifyResult is the outcome of verifying this server's own public endpoint.
// Pending distinguishes an EXPECTED transient (the cert is still being issued,
// or DNS/tunnel are still settling) from a hard failure (the served cert isn't
// ours — interception). Callers show the former as calm progress and the latter
// loudly.
type verifyResult struct {
	OK      bool   `json:"ok"`
	Issuer  string `json:"issuer,omitempty"`
	Pending bool   `json:"pending,omitempty"`
	Error   string `json:"error,omitempty"`
	// Trust says which root store accepted the served certificate: "public" (the
	// system CA roots — what a browser does) or "private" (nothing public trusts
	// it, but it is byte-for-byte the certificate our own Traefik holds). A
	// manual-mode server with an internal CA can only ever reach "private", and
	// treating that as a failure would make registration impossible for it.
	Trust string `json:"trust,omitempty"`
}

// verifyPublicEndpoint fetches this server's OWN public Bailey URL and confirms
// three things a human would otherwise discover only by loading it in a browser:
//
//  1. reachable — the URL actually answers on :443 (tunnel/DNS/ingress are up);
//  2. trusted — the served certificate validates against the public CA roots
//     for this hostname (no browser "not private" warning); this is what's
//     still false while the Let's Encrypt wildcard is being issued;
//  3. ours — the served leaf is byte-for-byte the cert our local Traefik holds,
//     so a *trusted* cert that isn't ours (a MITM with its own valid cert) is
//     still rejected.
//
// In a TLS mode that contacts no CA, (2) can never be true — an internal CA is by
// definition not in the public root store — so requiring it would make
// registration impossible on exactly the servers that mode exists for. There, the
// check falls back to (1) and (3) alone and reports trust: "private". (3) is the
// property that actually detects interception, and it is unaffected.
//
// register polls this so it only prints the URL once it's genuinely usable.
func (s *Server) verifyPublicEndpoint(domain string) verifyResult {
	publicHost := "bailey." + domain
	dialAddr := publicHost + ":443"

	localLeaf, err := fetchServedLeaf(relayLocalTarget(), publicHost)
	if err != nil {
		// Local Traefik still coming up — expected right after bring-up.
		return verifyResult{Pending: true, Error: "waiting for local ingress to start"}
	}

	// Full verification against the system CA roots — this is the check a
	// browser makes, so it fails exactly while the cert is still self-signed.
	d := &net.Dialer{Timeout: 15 * time.Second}
	raw, err := d.Dial("tcp", dialAddr)
	if err != nil {
		// DNS still resolving / tunnel still settling — expected transient. Keep
		// the message a clean stage label (the raw resolver error reads like a
		// crash); it resolves within a poll or two.
		return verifyResult{Pending: true, Error: "waiting for DNS to resolve"}
	}
	defer raw.Close()
	conn := tls.Client(raw, &tls.Config{ServerName: publicHost}) // verifies chain + hostname
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := conn.HandshakeContext(ctx); err != nil {
		if !currentTLSMode().usesACME() {
			// No public CA is coming: this mode serves what the operator installed.
			// Verify the two properties that still mean something.
			return verifyPrivatelyTrustedEndpoint(dialAddr, publicHost, localLeaf)
		}
		// The wildcard cert is still being issued (Traefik is serving its
		// self-signed default until Let's Encrypt responds) — the common wait.
		return verifyResult{Pending: true, Error: "waiting for the TLS certificate to be issued"}
	}
	defer conn.Close()

	served := conn.ConnectionState().PeerCertificates
	if len(served) == 0 {
		return verifyResult{Pending: true, Error: "no certificate served yet"}
	}
	if sha256.Sum256(served[0].Raw) != sha256.Sum256(localLeaf) {
		// HARD failure — a valid-but-not-ours cert means interception. Not pending.
		return verifyResult{Error: "served certificate is not ours — TLS is being intercepted in transit"}
	}
	return verifyResult{OK: true, Issuer: served[0].Issuer.CommonName, Trust: "public"}
}

// verifyPrivatelyTrustedEndpoint is the manual-mode form of the check: the served
// certificate is not expected to chain to a public root, so confirm instead that
// the endpoint answers and that what it serves is byte-for-byte our own
// certificate. That second property is the one that detects interception, and it
// does not depend on who signed anything.
func verifyPrivatelyTrustedEndpoint(dialAddr, publicHost string, localLeaf []byte) verifyResult {
	servedRaw, err := fetchServedLeaf(dialAddr, publicHost)
	if err != nil {
		return verifyResult{Pending: true, Error: "waiting for the ingress to serve " + publicHost}
	}
	if sha256.Sum256(servedRaw) != sha256.Sum256(localLeaf) {
		return verifyResult{Error: "served certificate is not ours — TLS is being intercepted in transit"}
	}
	issuer := ""
	if served, err := x509.ParseCertificate(servedRaw); err == nil {
		issuer = served.Issuer.CommonName
	}
	return verifyResult{OK: true, Issuer: issuer, Trust: "private"}
}

// handleRelayVerify runs verifyPublicEndpoint once and returns the result.
func (s *Server) handleRelayVerify(w http.ResponseWriter, r *http.Request) {
	cfg := config.NewAutomationServerConfig()
	settings, err := cfg.GetAutomationOperationsCenterSettings()
	if err != nil || settings == nil || settings.Domain == "" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(verifyResult{Error: "no domain configured"})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(s.verifyPublicEndpoint(settings.Domain))
}

// privateAddressLabel renders a declared private address for a log line,
// falling back to a phrase when the operator didn't state one (the address is
// the AOC's to publish; a server can be private without knowing it).
func privateAddressLabel(addr string) string {
	if addr == "" {
		return "an address this server did not declare"
	}
	return addr
}

// handleRelayStart lets `register` kick the tunnel after the AOC has just
// provisioned the proxy path — the daemon started before the AOC knew this
// server was proxied, so its boot-time check found nothing. Idempotent.
//
// Refuses outright on a private server: the caller is asking for the one thing
// a private registration exists to prevent, so this answers with an error the
// operator can act on rather than quietly doing nothing.
func (s *Server) handleRelayStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cfg := config.NewAutomationServerConfig()
	if settings, err := cfg.GetAutomationOperationsCenterSettings(); err == nil &&
		settings != nil && settings.Private {
		writeJSONError(w,
			"this server is registered as private (reached over a VPN or LAN); the AOC relay "+
				"would republish it on the public internet. Re-register without --private to use the relay.",
			http.StatusConflict)
		return
	}
	s.startRelayTunnel()
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"success":true}`))
}

// startEndpointTLSSelfCheck runs the paranoid end-to-end-TLS self-check for ANY
// registered server that has a public domain — not only proxied ones. The check
// fetches this server's own public Bailey URL and confirms the certificate the
// world is served is byte-for-byte the one our local Traefik holds. A mismatch
// means TLS is being terminated/re-signed between the public and us — a relay
// gone rogue, a corporate MITM box, a hijacked A record — and we surface it
// loudly. This matters everywhere: a directly-addressed server can be
// intercepted just as a proxied one can, so the guarantee should be universal.
// No-op when the server isn't registered or has no domain.
func (s *Server) startEndpointTLSSelfCheck() {
	cfg := config.NewAutomationServerConfig()
	settings, err := cfg.GetAutomationOperationsCenterSettings()
	if err != nil || settings == nil || settings.Domain == "" {
		return
	}
	go s.runEndpointTLSSelfCheck(settings.Domain, settings.Proxied)
}

// runEndpointTLSSelfCheck verifies the public endpoint at startup (retrying
// across a settle window while DNS/Traefik/tunnel come up) and then re-verifies
// periodically, so interception that begins later is still caught.
func (s *Server) runEndpointTLSSelfCheck(domain string, proxied bool) {
	// Initial pass: allow up to ~3 minutes for the path to settle (DNS
	// propagation, wildcard cert issuance, and — when proxied — the tunnel +
	// AOC-side passthrough router).
	if err := s.verifyEndpointTLS(domain, 3*time.Minute); err != nil {
		s.reportTLSSelfCheckFailure(domain, proxied, err)
	}

	// Steady state: re-verify every 6 hours (single attempt each).
	t := time.NewTicker(6 * time.Hour)
	defer t.Stop()
	for range t.C {
		if err := s.verifyEndpointTLS(domain, 30*time.Second); err != nil {
			s.reportTLSSelfCheckFailure(domain, proxied, err)
		}
	}
}

// verifyEndpointTLS retries the identity check until it passes or the window
// elapses. Returns nil on the first pass, or the last error otherwise.
func (s *Server) verifyEndpointTLS(domain string, window time.Duration) error {
	publicHost := "bailey." + domain
	dialAddr := publicHost + ":443"

	var lastErr error
	deadline := time.Now().Add(window)
	for attempt := 1; ; attempt++ {
		localLeaf, err := fetchServedLeaf(relayLocalTarget(), publicHost)
		if err != nil {
			lastErr = fmt.Errorf("read local leaf from %s: %w", relayLocalTarget(), err)
		} else {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			err = relay.VerifyEndToEndTLS(ctx, publicHost, dialAddr, localLeaf)
			cancel()
			if err == nil {
				fmt.Printf("tls-selfcheck: ✅ %s serves our own certificate end-to-end (no interception)\n", publicHost)
				return nil
			}
			lastErr = err
		}
		if !time.Now().Before(deadline) {
			return lastErr
		}
		backoff := time.Duration(attempt) * 2 * time.Second
		if backoff > 10*time.Second {
			backoff = 10 * time.Second
		}
		time.Sleep(backoff)
	}
}

// reportTLSSelfCheckFailure surfaces a failed identity check loudly and as a
// SIEM security event. We log rather than tear down: a transient mismatch during
// a cert rollover shouldn't take a healthy server offline, but a real
// interception must be impossible to miss.
func (s *Server) reportTLSSelfCheckFailure(domain string, proxied bool, err error) {
	path := "direct"
	if proxied {
		path = "via reverse-proxy relay"
	}
	fmt.Printf("tls-selfcheck: ⚠️  end-to-end TLS self-check FAILED for bailey.%s (%s): %v\n", domain, path, err)
	fmt.Printf("tls-selfcheck: ⚠️  the public URL is NOT serving our certificate — TLS may be intercepted/terminated in transit\n")
	// Record as a security event so it lands in the audit log AND is forwarded
	// to any configured SIEM. Best-effort — never let telemetry failure hide the
	// finding (it's already on stdout above).
	_ = recordEvent("system", "tls_selfcheck_failed",
		fmt.Sprintf("bailey.%s (%s): %v", domain, path, err))
}

// relayInfo mirrors the AOC's /api/automation_server/relay response.
type relayInfo struct {
	Proxied          bool   `json:"proxied"`
	RelayAddr        string `json:"relay_addr"`
	RelayFingerprint string `json:"relay_fingerprint"`
	// AocPublicId is the AOC's per-deployment namespace for published public
	// endpoints (issue #220): their hosts live under *.public.<aoc_public_id>.
	// The daemon receives the full allocated host from the allocate call, so
	// this is informational/forward-compatible.
	AocPublicId string `json:"aoc_public_id"`
}

// fetchRelayInfoFromAOC asks the AOC whether this server is proxied and, if so,
// where the relay is. The AOC authenticates us by our own bearer token, so we
// only ever learn our own status.
func fetchRelayInfoFromAOC(aocURL, token string) (relayInfo, error) {
	var info relayInfo
	base := strings.TrimRight(strings.TrimSpace(aocURL), "/")
	if base == "" {
		return info, fmt.Errorf("no AOC url configured")
	}
	req, err := http.NewRequest(http.MethodGet, base+"/api/automation_server/relay", nil)
	if err != nil {
		return info, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return info, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		// Older AOC without the relay endpoint: treat as "not proxied" rather
		// than failing — a legacy AOC simply doesn't offer the proxy path.
		return relayInfo{Proxied: false}, nil
	}
	if resp.StatusCode != http.StatusOK {
		return info, fmt.Errorf("AOC relay endpoint returned HTTP %d", resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return info, fmt.Errorf("decode relay info: %w", err)
	}
	return info, nil
}

// fetchServedLeaf opens a TLS connection to addr with the given SNI and returns
// the DER of the leaf certificate the server presents. Used to learn what cert
// our local Traefik serves for a host, without reading key material off disk.
func fetchServedLeaf(addr, sni string) ([]byte, error) {
	d := &net.Dialer{Timeout: 10 * time.Second}
	raw, err := d.Dial("tcp", addr)
	if err != nil {
		return nil, err
	}
	defer raw.Close()
	conn := tls.Client(raw, &tls.Config{ServerName: sni, InsecureSkipVerify: true})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := conn.HandshakeContext(ctx); err != nil {
		return nil, err
	}
	defer conn.Close()
	certs := conn.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return nil, fmt.Errorf("%s served no certificate for %s", addr, sni)
	}
	return certs[0].Raw, nil
}
