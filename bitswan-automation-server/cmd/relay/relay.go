// Package relay wires the `bitswan relay` command tree. The relay runs on the
// AOC host and gives NAT'd (or --force-proxy) Baileys a public entrypoint via
// end-to-end-TLS passthrough — see internal/relay for the transport.
package relay

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	relaysvc "github.com/bitswan-space/bitswan-workspaces/internal/relay"
	"github.com/spf13/cobra"
)

// NewRelayCmd builds the `bitswan relay` command tree.
func NewRelayCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "relay",
		Short: "AOC-side transparent reverse-proxy relay for NAT'd Baileys",
	}
	cmd.AddCommand(newServeCmd())
	cmd.AddCommand(newFingerprintCmd())
	return cmd
}

func newServeCmd() *cobra.Command {
	var tunnelAddr, passthroughAddr, certDir, aocAPI, relaySecret string

	cmd := &cobra.Command{
		Use:          "serve",
		Short:        "Run the relay (tunnel + SNI passthrough listeners)",
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			aocAPI = strings.TrimRight(strings.TrimSpace(aocAPI), "/")
			if aocAPI == "" {
				return fmt.Errorf("--aoc-api is required: the relay validates each Bailey's token against THIS AOC and must never trust an AOC URL supplied by the connecting client")
			}
			cert, fp, err := loadOrCreateCert(certDir)
			if err != nil {
				return err
			}
			fmt.Printf("🔑 relay tunnel cert fingerprint (sha256): %s\n", fp)
			fmt.Println("   Baileys must pin this; the AOC advertises it to them.")

			tunnelTLS := &tls.Config{
				Certificates: []tls.Certificate{cert},
				MinVersion:   tls.VersionTLS12,
			}

			// Validate every registration against the relay's OWN configured AOC
			// (aocAPI), NEVER the aoc_api_url in the register frame — that value
			// is client-controlled and could point at an authority that
			// rubber-stamps any subdomain, letting an attacker hijack another
			// server's tunnel.
			validate := func(token, subdomain string) error {
				return validateTokenAgainstAOC(aocAPI, token, subdomain)
			}
			srv := relaysvc.NewServer(tunnelAddr, passthroughAddr, tunnelTLS, validate)

			// Published public endpoints (issue #220) don't carry the owning
			// server's subdomain in their SNI, so the relay resolves them against
			// its OWN configured AOC (never a client-supplied URL), presenting a
			// shared secret. No secret ⇒ public-host routing stays disabled.
			if relaySecret != "" {
				srv.ResolvePublicHost = func(host string) (string, error) {
					return resolvePublicHostViaAOC(aocAPI, relaySecret, host)
				}
			} else {
				fmt.Println("ℹ️  no --relay-secret / $BITSWAN_RELAY_SHARED_SECRET set — public-endpoint (#220) routing is disabled")
			}

			ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
			defer stop()
			return srv.Run(ctx)
		},
	}
	cmd.Flags().StringVar(&tunnelAddr, "tunnel-addr", ":8443", "Public address Baileys dial for the tunnel (TLS)")
	cmd.Flags().StringVar(&passthroughAddr, "passthrough-addr", ":9443", "Address Traefik forwards browser streams to (SNI passthrough)")
	cmd.Flags().StringVar(&certDir, "cert-dir", "/var/lib/bitswan-relay", "Where the relay's self-signed tunnel cert is stored")
	cmd.Flags().StringVar(&aocAPI, "aoc-api", "", "AOC base URL the relay validates Bailey tokens against (required; must be the real AOC, never taken from the connecting client)")
	cmd.Flags().StringVar(&relaySecret, "relay-secret", os.Getenv("BITSWAN_RELAY_SHARED_SECRET"), "Shared secret the relay presents to the AOC to resolve published public-endpoint hosts (issue #220). Defaults to $BITSWAN_RELAY_SHARED_SECRET; empty disables public-host routing.")
	return cmd
}

// resolvePublicHostViaAOC asks the relay's configured AOC which server owns a
// published public host (issue #220), returning that server's subdomain (the
// tunnel key). Empty return + nil error means "no such public host". The AOC
// url is the relay's OWN (never client-supplied); the shared secret authorises
// this relay to the AOC's resolve endpoint.
func resolvePublicHostViaAOC(aocApiURL, relaySecret, host string) (string, error) {
	aocApiURL = strings.TrimRight(strings.TrimSpace(aocApiURL), "/")
	if aocApiURL == "" {
		return "", fmt.Errorf("empty AOC url")
	}
	if strings.TrimSpace(relaySecret) == "" {
		return "", fmt.Errorf("no relay shared secret configured")
	}
	req, err := http.NewRequest(http.MethodGet,
		aocApiURL+"/api/automation_server/public-endpoint/resolve?host="+url.QueryEscape(host), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+relaySecret)
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("reach AOC: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return "", nil // not a known public host
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("AOC public-endpoint resolve returned HTTP %d", resp.StatusCode)
	}
	var out struct {
		Subdomain string `json:"subdomain"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("decode AOC resolve: %w", err)
	}
	return out.Subdomain, nil
}

func newFingerprintCmd() *cobra.Command {
	var certDir string
	cmd := &cobra.Command{
		Use:          "fingerprint",
		Short:        "Print the relay tunnel cert fingerprint (creating the cert if needed)",
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			_, fp, err := loadOrCreateCert(certDir)
			if err != nil {
				return err
			}
			fmt.Println(fp)
			return nil
		},
	}
	cmd.Flags().StringVar(&certDir, "cert-dir", "/var/lib/bitswan-relay", "Where the relay's self-signed tunnel cert is stored")
	return cmd
}

// loadOrCreateCert returns the relay's persistent self-signed tunnel cert and
// its sha256 leaf fingerprint (hex). The cert is stable across restarts so the
// pinned fingerprint the AOC advertises stays valid.
func loadOrCreateCert(dir string) (tls.Certificate, string, error) {
	certPath := filepath.Join(dir, "tunnel.crt")
	keyPath := filepath.Join(dir, "tunnel.key")

	if _, err := os.Stat(certPath); err == nil {
		cert, err := tls.LoadX509KeyPair(certPath, keyPath)
		if err != nil {
			return tls.Certificate{}, "", fmt.Errorf("load relay cert: %w", err)
		}
		return cert, fingerprintOf(cert), nil
	}

	if err := os.MkdirAll(dir, 0o700); err != nil {
		return tls.Certificate{}, "", fmt.Errorf("create cert dir: %w", err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "bitswan-relay-tunnel"},
		NotBefore:    time.Unix(0, 0),
		NotAfter:     time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC), // effectively never; identity is pinned, not time-bound
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(certPath, certPEM, 0o600); err != nil {
		return tls.Certificate{}, "", err
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		return tls.Certificate{}, "", err
	}
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	return cert, fingerprintOf(cert), nil
}

func fingerprintOf(cert tls.Certificate) string {
	sum := sha256.Sum256(cert.Certificate[0])
	return fmt.Sprintf("%x", sum)
}

// validateTokenAgainstAOC confirms a registering Bailey's AOC token is valid and
// really owns the subdomain it claims, by calling the AOC's own /info endpoint
// as that server. The relay trusts the AOC, not the Bailey's assertion.
func validateTokenAgainstAOC(aocApiURL, token, subdomain string) error {
	aocApiURL = strings.TrimRight(strings.TrimSpace(aocApiURL), "/")
	if aocApiURL == "" {
		return fmt.Errorf("empty AOC url")
	}
	req, err := http.NewRequest(http.MethodGet, aocApiURL+"/api/automation_server/info", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("reach AOC: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("AOC rejected token: HTTP %d", resp.StatusCode)
	}
	var info struct {
		Domain string `json:"domain"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return fmt.Errorf("decode AOC info: %w", err)
	}
	if !strings.EqualFold(strings.TrimSpace(info.Domain), strings.TrimSpace(subdomain)) {
		return fmt.Errorf("token's domain %q does not match claimed subdomain %q", info.Domain, subdomain)
	}
	return nil
}
