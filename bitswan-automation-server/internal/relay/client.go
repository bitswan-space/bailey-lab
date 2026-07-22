package relay

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"strings"
	"time"
)

// ClientConfig configures the Bailey-side tunnel dialer.
type ClientConfig struct {
	// RelayAddr is the relay's public tunnel address (host:port).
	RelayAddr string
	// RelayFingerprint is the SHA-256 of the relay's TLS leaf certificate
	// (hex, lowercase, no colons), advertised by the AOC. We pin it so the AOC
	// token in our register handshake can't be intercepted.
	RelayFingerprint string
	// AOCApiURL is the AOC base URL; the relay validates our token against it.
	AOCApiURL string
	// Token is this server's AOC access token.
	Token string
	// Subdomain is this server's *.bswn.io domain (e.g. acme-prod.bswn.io).
	Subdomain string
	// LocalTarget is where the Bailey's own Traefik terminates TLS (host:port).
	// The tunnel splices browser streams here; Traefik serves them with the
	// Bailey's real certificate.
	LocalTarget string
}

// Client maintains the outbound tunnel to the relay and dials a fresh local
// connection for every browser stream the relay hands us.
type Client struct {
	cfg ClientConfig
}

func NewClient(cfg ClientConfig) *Client { return &Client{cfg: cfg} }

// tlsConfig pins the relay's self-signed leaf by fingerprint. We skip the
// hostname/CA chain (the relay cert is self-signed on purpose) but REQUIRE the
// exact leaf we were told to expect — a stricter guarantee than CA validation.
func (c *Client) tlsConfig() (*tls.Config, error) {
	want := normalizeFingerprint(c.cfg.RelayFingerprint)
	if want == "" {
		return nil, fmt.Errorf("relay: empty relay fingerprint; refusing to dial unpinned")
	}
	return &tls.Config{
		InsecureSkipVerify: true, // we verify by pinned fingerprint below, not CA
		VerifyPeerCertificate: func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			if len(rawCerts) == 0 {
				return fmt.Errorf("relay presented no certificate")
			}
			got := fmt.Sprintf("%x", sha256.Sum256(rawCerts[0]))
			if got != want {
				return fmt.Errorf("relay certificate fingerprint mismatch: got %s want %s", got, want)
			}
			return nil
		},
	}, nil
}

// Run keeps the control channel connected, reconnecting on drop, until ctx is
// cancelled. Each successful (re)connect is announced; failures are logged and
// retried with a capped backoff so a flapping relay can't hot-loop us.
func (c *Client) Run(ctx context.Context) error {
	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		err := c.runOnce(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		log.Printf("relay: control channel down (%v); reconnecting in %s", err, backoff)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

// runOnce establishes one control channel and services "open" frames until it
// drops. Returns the error that ended it.
func (c *Client) runOnce(ctx context.Context) error {
	tlsCfg, err := c.tlsConfig()
	if err != nil {
		return err
	}
	conn, err := tls.Dial("tcp", c.cfg.RelayAddr, tlsCfg)
	if err != nil {
		return fmt.Errorf("dial relay: %w", err)
	}
	defer conn.Close()

	if err := writeFrame(conn, frame{
		Type:      frameRegister,
		Token:     c.cfg.Token,
		AOCApiURL: c.cfg.AOCApiURL,
		Subdomain: c.cfg.Subdomain,
	}); err != nil {
		return fmt.Errorf("send register: %w", err)
	}

	br := bufio.NewReader(conn)
	ack, err := readFrame(br)
	if err != nil {
		return fmt.Errorf("read ack: %w", err)
	}
	if ack.Type != frameAck {
		return fmt.Errorf("relay rejected registration: %s", ack.Message)
	}
	log.Printf("relay: tunnel established for %s via %s", c.cfg.Subdomain, c.cfg.RelayAddr)

	for {
		f, err := readFrame(br)
		if err != nil {
			return fmt.Errorf("control read: %w", err)
		}
		switch f.Type {
		case frameOpen:
			go c.dialBack(f.ConnID)
		case frameError:
			return fmt.Errorf("relay error: %s", f.Message)
		default:
			// Ignore unknown frames for forward-compat.
		}
	}
}

// dialBack opens a fresh data connection to the relay, claims the pending
// browser stream by conn_id, then splices it to local Traefik.
func (c *Client) dialBack(connID string) {
	tlsCfg, err := c.tlsConfig()
	if err != nil {
		log.Printf("relay: dialBack tls config: %v", err)
		return
	}
	up, err := tls.Dial("tcp", c.cfg.RelayAddr, tlsCfg)
	if err != nil {
		log.Printf("relay: dialBack dial relay: %v", err)
		return
	}
	if err := writeFrame(up, frame{Type: frameData, ConnID: connID}); err != nil {
		log.Printf("relay: dialBack send data frame: %v", err)
		up.Close()
		return
	}

	local, err := net.DialTimeout("tcp", c.cfg.LocalTarget, 10*time.Second)
	if err != nil {
		log.Printf("relay: dialBack local %s: %v", c.cfg.LocalTarget, err)
		up.Close()
		return
	}
	splice(up, local)
}

// VerifyEndToEndTLS is the paranoid self-check the user mandated: after the
// tunnel is up, the Bailey fetches its OWN public URL through the relay and
// confirms the TLS certificate the world sees is byte-for-byte its own local
// leaf. If a relay (or anything between) terminated/re-signed TLS, the
// fingerprints differ and we fail loudly. localLeaf is the DER of the cert
// Traefik serves locally.
//
// publicHost is the SNI/host to connect to (e.g. bailey.<domain>); dialAddr is
// where to actually open the socket for it — pass the relay's passthrough entry
// (the public :443) so the check exercises the REAL path a browser takes, not a
// localhost shortcut.
func VerifyEndToEndTLS(ctx context.Context, publicHost, dialAddr string, localLeaf []byte) error {
	if len(localLeaf) == 0 {
		return fmt.Errorf("relay self-check: no local leaf certificate to compare against")
	}
	d := &net.Dialer{Timeout: 15 * time.Second}
	raw, err := d.DialContext(ctx, "tcp", dialAddr)
	if err != nil {
		return fmt.Errorf("relay self-check: dial %s: %w", dialAddr, err)
	}
	defer raw.Close()

	// Verify manually against our own leaf — the public chain may be a real CA
	// cert we don't need to trust-root here; identity is what matters.
	conn := tls.Client(raw, &tls.Config{
		ServerName:         publicHost,
		InsecureSkipVerify: true,
	})
	if err := conn.HandshakeContext(ctx); err != nil {
		return fmt.Errorf("relay self-check: TLS handshake to %s (%s): %w", publicHost, dialAddr, err)
	}
	defer conn.Close()

	served := conn.ConnectionState().PeerCertificates
	if len(served) == 0 {
		return fmt.Errorf("relay self-check: %s served no certificate", publicHost)
	}
	gotFP := sha256.Sum256(served[0].Raw)
	wantFP := sha256.Sum256(localLeaf)
	if gotFP != wantFP {
		return fmt.Errorf(
			"relay self-check FAILED for %s: served leaf %s != our leaf %s — TLS is being terminated in the middle (MITM/interception); refusing to proxy",
			publicHost, hex.EncodeToString(gotFP[:]), hex.EncodeToString(wantFP[:]),
		)
	}
	return nil
}

func normalizeFingerprint(fp string) string {
	fp = strings.ToLower(strings.TrimSpace(fp))
	fp = strings.ReplaceAll(fp, ":", "")
	fp = strings.ReplaceAll(fp, " ", "")
	return fp
}
