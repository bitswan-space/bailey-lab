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
	var dnsProvider string
	var dnsCredentials []string

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
			"  custom-dns\n" +
			"           The same CA over the same challenge, solved against a DNS provider you\n" +
			"           run, using lego's provider for it. For a customer who keeps their own\n" +
			"           zone: the AOC's bridge has no zone to write to there, but certificates\n" +
			"           and renewal work exactly as they do on aoc-dns. Needs --dns-provider\n" +
			"           and the provider's credentials.\n" +
			"  manual   Serve certificates you install yourself; no CA is contacted. For an\n" +
			"           internal CA, a corporate PKI, or a DNS provider that cannot be automated.\n\n" +
			"Example:\n" +
			"  bitswan ingress tls custom-dns --dns-provider cloudflare \\\n" +
			"      --dns-credential CF_DNS_API_TOKEN=…\n\n" +
			"Credentials are stored in the daemon's config volume and rendered into Traefik's\n" +
			"environment. That file is part of a server backup, so scope the token to the zone\n" +
			"it needs, as you would for any ACME client.",
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
				credentials, err := parseCredentials(dnsCredentials)
				if err != nil {
					return err
				}
				fmt.Printf("Switching the ingress to TLS mode %q...\n", args[0])
				status, err = client.SetIngressTLSModeWithDNS(args[0], dnsProvider, credentials)
				if err != nil {
					fmt.Fprintf(os.Stderr, "Error: %v\n", err)
					os.Exit(1)
				}
			} else {
				if dnsProvider != "" || len(dnsCredentials) > 0 {
					return fmt.Errorf("--dns-provider/--dns-credential only apply when selecting a mode, " +
						"e.g. 'bitswan ingress tls custom-dns --dns-provider cloudflare'")
				}
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

	cmd.Flags().StringVar(&dnsProvider, "dns-provider", "",
		"lego DNS provider id for custom-dns mode (e.g. cloudflare, route53, azuredns)")
	cmd.Flags().StringArrayVar(&dnsCredentials, "dns-credential", nil,
		"NAME=value environment variable the DNS provider reads; repeat for each one. "+
			"Stating any replaces the stored set.")

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

// parseCredentials turns repeated NAME=value flags into the map the daemon stores.
func parseCredentials(pairs []string) (map[string]string, error) {
	if len(pairs) == 0 {
		return nil, nil
	}
	out := make(map[string]string, len(pairs))
	for _, pair := range pairs {
		name, value, err := daemon.ParseCredentialFlag(pair)
		if err != nil {
			return nil, err
		}
		out[name] = value
	}
	return out, nil
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
	if status.DNSProvider != "" {
		fmt.Printf("DNS provider: %s (credentials: %s)\n",
			status.DNSProvider, strings.Join(status.DNSCredentialNames, ", "))
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
