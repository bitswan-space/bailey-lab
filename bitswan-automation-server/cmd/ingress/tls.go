package ingress

import (
	"fmt"
	"os"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/daemon"
	"github.com/spf13/cobra"
)

// newTLSCmd is the certificate-mode surface: how this server's public hostnames
// get their TLS certificates, and what switching that costs.
func newTLSCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "tls",
		Short: "Show or change how the ingress obtains TLS certificates",
		Long: "Show or change how this server's public hostnames get their TLS certificates.\n\n" +
			"With no arguments, reports the current mode. With a mode name, switches to it: " +
			"Traefik's static configuration is rewritten (which recreates the container) and every " +
			"existing route under the server's domain is moved onto the new backend, so a switch " +
			"applies to the routes already serving traffic and not only to ones registered " +
			"afterwards.\n\n" +
			"Modes:\n" +
			"  aoc-dns  Let's Encrypt over the DNS-01 challenge, solved through the AOC's zone.\n" +
			"           Works on a server with no public inbound route at all: the CA reads DNS\n" +
			"           and never connects to the server. This is the default.\n" +
			"  manual   Serve certificates you install yourself; no CA is contacted. For an\n" +
			"           internal CA, a corporate PKI, or a DNS provider that cannot be automated.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := daemon.NewClient()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				fmt.Fprintln(os.Stderr, "Run 'bitswan automation-server-daemon init' to start it.")
				os.Exit(1)
			}

			var status *daemon.IngressTLSStatus
			if len(args) == 1 {
				// Validate locally so a typo is a flag error rather than a round trip
				// that recreates the ingress before failing.
				if _, err := daemon.ParseTLSMode(args[0]); err != nil {
					return err
				}
				fmt.Printf("Switching the ingress to TLS mode %q...\n", args[0])
				status, err = client.SetIngressTLSMode(args[0])
			} else {
				status, err = client.IngressTLS()
			}
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}

			printTLSStatus(status)
			return nil
		},
	}
	return cmd
}

func printTLSStatus(status *daemon.IngressTLSStatus) {
	fmt.Printf("TLS mode: %s — %s\n", status.Mode, status.Description)
	if status.Domain != "" {
		managed := "managed by the AOC"
		if !status.DNSManagedByAOC {
			managed = "NOT managed by the AOC — its DNS-01 challenges cannot be written here"
		}
		fmt.Printf("Domain:   %s (DNS %s)\n", status.Domain, managed)
	}
	if len(status.InstalledCerts) > 0 {
		fmt.Printf("Installed certificates: %s\n", strings.Join(status.InstalledCerts, ", "))
	}
	for _, warn := range status.Warnings {
		fmt.Printf("  • %s\n", warn)
	}
}
