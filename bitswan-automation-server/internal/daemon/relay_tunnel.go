package daemon

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"os"
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
// on the relay path (Proxied=true in config). It is a no-op otherwise, so it is
// always safe to call at daemon startup. Once the tunnel is up it runs the
// paranoid end-to-end-TLS self-check in the background.
func (s *Server) startRelayTunnel() {
	cfg := config.NewAutomationServerConfig()
	settings, err := cfg.GetAutomationOperationsCenterSettings()
	if err != nil || settings == nil || !settings.Proxied {
		return // not registered, or not on the relay path
	}
	if settings.Domain == "" || settings.RelayAddr == "" || settings.RelayFingerprint == "" {
		fmt.Printf("relay: Proxied is set but domain/relay_addr/relay_fingerprint are incomplete; not starting tunnel\n")
		return
	}

	client := relay.NewClient(relay.ClientConfig{
		RelayAddr:        settings.RelayAddr,
		RelayFingerprint: settings.RelayFingerprint,
		AOCApiURL:        settings.AOCUrl,
		Token:            settings.AccessToken,
		Subdomain:        settings.Domain,
		LocalTarget:      relayLocalTarget(),
	})

	fmt.Printf("relay: server is on the reverse-proxy path; dialing relay %s for %s\n",
		settings.RelayAddr, settings.Domain)

	ctx := context.Background()
	go func() {
		if err := client.Run(ctx); err != nil && ctx.Err() == nil {
			fmt.Printf("relay: tunnel client exited: %v\n", err)
		}
	}()
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
