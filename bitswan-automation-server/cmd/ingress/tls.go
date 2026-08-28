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
	cmd.AddCommand(newTLSInstallCertCmd())
	cmd.AddCommand(newTLSRemoveCertCmd())

	return cmd
}

func newTLSInstallCertCmd() *cobra.Command {
	var domain, hostname, certsDir string

	cmd := &cobra.Command{
		Use:   "install-cert",
		Short: "Install a TLS certificate you obtained yourself",
		Long: "Install a certificate and its private key into the ingress, for a server that " +
			"does not get them from a CA (mode manual).\n\n" +
			"Prefer --domain: it installs ONE wildcard covering *.<domain>, which is what the " +
			"hostnames this server serves actually need. Several of them are registered by the " +
			"daemon rather than by you — the Bailey console and its inner twin, the device-trust " +
			"onboarding host, the docs host — and every workspace adds more, so installing per " +
			"hostname means chasing a set you do not control.\n\n" +
			"The directory is read by CONTENT, not by filename: whatever your issuer called the " +
			"files (fullchain.pem/privkey.pem, tls.crt/tls.key, cert.pem/key.pem, or one combined " +
			"file), the certificate chain and key are found and installed. The certificate is " +
			"checked before anything is written — that the key belongs to it, that it covers the " +
			"name, and that it is in date — because each of those otherwise fails invisibly at " +
			"handshake time.\n\n" +
			"Nothing renews an installed certificate. Re-run this command with the replacement; " +
			"Traefik picks it up without a restart.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if certsDir == "" {
				return fmt.Errorf("--certs-dir is required")
			}
			if (domain == "") == (hostname == "") {
				return fmt.Errorf("pass exactly one of --domain (installs a wildcard) or --hostname")
			}

			client, err := daemon.NewClient()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				fmt.Fprintln(os.Stderr, "Run 'bitswan automation-server-daemon init' to start it.")
				os.Exit(1)
			}

			status, err := client.InstallIngressTLSCert(domain, hostname, certsDir)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			fmt.Println("Certificate installed.")
			printTLSStatus(status)
			return nil
		},
	}

	cmd.Flags().StringVar(&domain, "domain", "",
		"install one wildcard certificate covering *.<domain> (recommended)")
	cmd.Flags().StringVar(&hostname, "hostname", "",
		"install for exactly this hostname (or an explicit \"*.x\" wildcard)")
	cmd.Flags().StringVar(&certsDir, "certs-dir", "",
		"directory holding the certificate and its private key, in any file naming")
	return cmd
}

func newTLSRemoveCertCmd() *cobra.Command {
	var hostname string

	cmd := &cobra.Command{
		Use:   "remove-cert",
		Short: "Remove an installed TLS certificate",
		Long: "Remove an installed certificate from the ingress and delete its files.\n\n" +
			"This is what you need when moving a server BACK onto a CA-issued certificate: " +
			"Traefik serves a matching certificate from its file store in preference to an ACME " +
			"one, so an installed certificate keeps being served — and keeps expiring — even " +
			"after the mode changes.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if hostname == "" {
				return fmt.Errorf("--hostname is required (as installed, e.g. \"*.acme.example.com\")")
			}

			client, err := daemon.NewClient()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			status, err := client.RemoveIngressTLSCert(hostname)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			fmt.Printf("Removed the installed certificate for %s.\n", hostname)
			printTLSStatus(status)
			return nil
		},
	}

	cmd.Flags().StringVar(&hostname, "hostname", "",
		"the name the certificate was installed for")
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
	if len(status.Certificates) > 0 {
		fmt.Println("Installed certificates:")
		for _, cert := range status.Certificates {
			if cert.Problem != "" {
				fmt.Printf("  %-40s %s\n", cert.Hostname, cert.Problem)
				continue
			}
			fmt.Printf("  %-40s expires %s (%d days) — issuer %q\n",
				cert.Hostname, cert.NotAfter, cert.DaysLeft, cert.Issuer)
		}
	} else if len(status.InstalledCerts) > 0 {
		fmt.Printf("Installed certificates: %s\n", strings.Join(status.InstalledCerts, ", "))
	}
	for _, warn := range status.Warnings {
		fmt.Printf("  • %s\n", warn)
	}
}
