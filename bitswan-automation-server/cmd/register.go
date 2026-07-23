package cmd

import (
	"fmt"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/cmd/automationserverdaemon"
	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
	"github.com/bitswan-space/bitswan-workspaces/internal/daemon"
	"github.com/spf13/cobra"
)

// newDaemonClientWithRetry connects to the daemon, retrying briefly so a
// freshly-started daemon container has time to create its Unix socket.
func newDaemonClientWithRetry() (*daemon.Client, error) {
	var lastErr error
	for i := 0; i < 30; i++ {
		client, err := daemon.NewClient()
		if err == nil {
			return client, nil
		}
		lastErr = err
		time.Sleep(time.Second)
	}
	return nil, lastErr
}

func newRegisterCmd() *cobra.Command {
	var serverName string
	var aocUrl string
	var otp string
	var automationServerId string
	var forceProxy bool
	var relayAddr string
	var relayFingerprint string

	cmd := &cobra.Command{
		Use:          "register",
		Short:        "Register automation server with AOC using OTP",
		Long:         "Register automation server with AOC using OTP. Both the OTP and automation server ID must be obtained from the web interface.",
		Args:         cobra.NoArgs,
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if otp == "" {
				return fmt.Errorf("OTP is required. Use --otp flag to provide the OTP from the web interface")
			}

			if serverName == "" {
				return fmt.Errorf("server name is required. Use --name flag to provide a name for your automation server")
			}

			if automationServerId == "" {
				return fmt.Errorf("automation server ID is required. Use --server-id flag to provide the automation server ID from the web interface")
			}

			// Bring the daemon up first: it is the single owner of
			// ~/.config/bitswan (a named Docker volume), so register writes no
			// config on the host — it hands the freshly obtained token to the
			// daemon over the socket instead. This also lets `register` bring up
			// a fresh server from nothing.
			fmt.Println("🚀 Ensuring the automation server daemon is running...")
			if err := automationserverdaemon.EnsureDaemonRunning(); err != nil {
				return fmt.Errorf("failed to ensure daemon is running: %w", err)
			}

			client, err := newDaemonClientWithRetry()
			if err != nil {
				return fmt.Errorf("failed to create daemon client (daemon may not be running): %w", err)
			}

			// Already-registered guard — asked of the daemon, since the config now
			// lives in its volume rather than on the host.
			if status, err := client.AOCStatus(); err == nil && status.Registered {
				return fmt.Errorf(
					"this automation server is already registered to an AOC instance at %s (server ID: %s).\n"+
						"To register with a different AOC instance, first disconnect using:\n\n"+
						"  bitswan disconnect-from-aoc",
					status.AOCUrl, status.AutomationServerId,
				)
			}

			// Exchange the OTP for an access token. NewAOCClientWithOTP keeps
			// everything in memory — it talks to the AOC from the host but never
			// writes a config file.
			aocClient, err := aoc.NewAOCClientWithOTP(aocUrl, otp, automationServerId)
			if err != nil {
				return fmt.Errorf("failed to create AOC client: %w", err)
			}

			// Get automation server info to verify the connection and learn the
			// AOC-assigned domain (e.g. acme-prod.bswn.io).
			serverInfo, err := aocClient.GetAutomationServerInfo()
			if err != nil {
				return fmt.Errorf("failed to get automation server info: %w", err)
			}

			// Persist the AOC connection into the daemon's config volume. From
			// here on the daemon holds a valid token to talk to the AOC (wildcard
			// ingress, protected proxy, workspace connect).
			proxyCfg := daemon.ProxyConfig{}
			if forceProxy {
				if relayAddr == "" || relayFingerprint == "" {
					return fmt.Errorf("--force-proxy requires --relay-addr and --relay-fingerprint (the AOC relay's tunnel endpoint and pinned cert fingerprint)")
				}
				proxyCfg = daemon.ProxyConfig{
					Proxied:          true,
					RelayAddr:        relayAddr,
					RelayFingerprint: relayFingerprint,
				}
			}

			if err := client.SetAOCConfig(
				aocUrl, serverInfo.AutomationServerId, aocClient.GetAccessToken(),
				aocClient.GetExpiresAt(), serverInfo.Domain, proxyCfg,
			); err != nil {
				return fmt.Errorf("failed to save AOC configuration to the daemon: %w", err)
			}

			fmt.Printf("✅ Successfully registered automation server '%s' with ID: %s\n", serverInfo.Name, serverInfo.AutomationServerId)
			fmt.Println("AOC URL, access token, and server ID have been saved to the daemon (no config is written on the host).")

			// If the AOC assigned this server a domain, stand up the full
			// protected-ingress stack BEFORE (re)deploying workspaces, so each
			// workspace's routes register through the auth wrap rather than as
			// bare single-tier routes (see addRouteTraefik).
			if serverInfo.Domain != "" {
				// --force-proxy exercises the reverse-proxy path on a server that
				// actually has a public IP: the AOC points DNS at its relay and we
				// tunnel out to it, instead of the AOC pointing an A record straight
				// at us. (NAT'd servers take this path automatically once the AOC
				// reports them unreachable.) The tunnel + TLS-passthrough relay are
				// set up via the daemon below.
				if forceProxy {
					fmt.Println("\n🌐 --force-proxy: this server will be reached through the AOC reverse-proxy relay (end-to-end TLS passthrough).")
				}

				// Reconfigure the ingress so Traefik obtains a *.<domain>
				// wildcard certificate via the DNS-01 challenge (through the
				// AOC) instead of a separate HTTP-01 certificate per endpoint.
				fmt.Printf("\n🔐 Configuring ingress for a *.%s wildcard certificate...\n", serverInfo.Domain)
				if _, err := client.InitIngress(false); err != nil {
					fmt.Printf("Warning: Failed to reconfigure ingress for wildcard certificates: %v\n", err)
					fmt.Println("Run 'bitswan ingress init' to apply the wildcard certificate configuration.")
				} else {
					fmt.Println("Ingress configured to use a DNS-01 wildcard certificate.")
				}

				// Bring up the shared bitswan-protected-proxy (oauth2-proxy)
				// that authenticates every protected endpoint upstream of the
				// daemon's access gate.
				fmt.Println("\n🛡️  Deploying the Bitswan protected proxy...")
				if err := client.ProvisionProtectedProxy(); err != nil {
					fmt.Printf("Warning: Failed to deploy the protected proxy: %v\n", err)
					fmt.Println("Endpoints will route without the Bailey auth wrap until it is provisioned.")
				} else {
					fmt.Println("Protected proxy deployed; endpoints are now authenticated through Bailey.")
				}

				// Tell the AOC where this server's Bailey console lives (and,
				// implicitly, that this is a Bailey server rather than a legacy
				// one). Best-effort: an older AOC without this endpoint must not
				// fail registration.
				baileyURL := fmt.Sprintf("https://bailey.%s", serverInfo.Domain)
				fmt.Printf("\n📓 Reporting Bailey console URL to the AOC: %s\n", baileyURL)
				domainStatus, err := aocClient.ReportBaileyURL(baileyURL, forceProxy)
				if err != nil {
					fmt.Printf("Warning: Failed to report Bailey URL to the AOC: %v\n", err)
				} else {
					fmt.Println("Bailey console URL reported.")
				}

				// Reporting the Bailey URL makes the AOC provision this server's
				// public DNS: if the world can't reach us directly (or --force-proxy
				// was passed) it routes *.<domain> through the reverse-proxy relay
				// and reports "proxied". The daemon started before this decision, so
				// kick the tunnel now (idempotent).
				if domainStatus == "proxied" || forceProxy {
					fmt.Println("\n🌐 This server will be reached through the AOC reverse-proxy relay (no public inbound route).")
					if err := client.StartRelayTunnel(); err != nil {
						fmt.Printf("Warning: failed to start the reverse-proxy tunnel: %v\n", err)
						fmt.Println("It will start automatically the next time the daemon restarts.")
					} else {
						fmt.Println("Reverse-proxy tunnel started.")
					}
				}
			}

			// Now connect existing workspaces to AOC via daemon. With the
			// protected proxy already running, their route registrations take
			// the wrapped path automatically.
			fmt.Println("\n🔗 Connecting existing workspaces to AOC...")
			if err := client.WorkspaceConnectToAOC(aocUrl, serverInfo.AutomationServerId, aocClient.GetAccessToken()); err != nil {
				return err
			}

			// Final gate: don't tell the user their Bailey is ready until we've
			// actually fetched its own public URL and confirmed it is reachable,
			// serving a publicly-trusted certificate (no browser warning), and
			// that the certificate is OURS (not intercepted). The wildcard cert
			// is issued asynchronously (DNS-01), so poll for a few minutes.
			if serverInfo.Domain != "" {
				baileyURL := fmt.Sprintf("https://bailey.%s", serverInfo.Domain)
				fmt.Printf("\n🔎 Bringing %s online. Its TLS certificate is issued in the background\n", baileyURL)
				fmt.Println("   (Let's Encrypt, DNS-01) — this usually takes 1–2 minutes. Waiting until it's")
				fmt.Println("   reachable with a valid, un-intercepted certificate before handing it to you.")

				// No blind head-start here: the AOC already waited for the DNS
				// change to reach INSYNC (live on every Route53 nameserver) before
				// returning from the Bailey-URL report above, so our first lookup
				// resolves rather than racing propagation and caching an NXDOMAIN.

				start := time.Now()
				// Generous ceiling: Let's Encrypt issuance is usually ~2 min but
				// can occasionally run to ~4; the wait is calm progress now, so a
				// higher ceiling costs nothing and avoids false-failing a
				// slow-but-successful issuance.
				deadline := start.Add(8 * time.Minute)
				lastHeartbeat := time.Now()
				lastStage := ""
				var lastReason string
				verified := false
				fmt.Print("   waiting")
				for time.Now().Before(deadline) {
					res, err := client.VerifyEndpoint()
					switch {
					case err == nil && res.OK:
						fmt.Printf("\n\n✅ %s is live — certificate issued by %q, verified end-to-end (not intercepted).\n", baileyURL, res.Issuer)
						verified = true
					case err != nil:
						// Daemon/socket hiccup — transient; keep waiting quietly.
						lastReason = err.Error()
					case res.Pending:
						// Expected while the cert issues / DNS settles. Show the
						// human-readable stage once when it changes; otherwise just
						// tick, so it reads as steady progress, not a failure loop.
						lastReason = res.Error
						if res.Error != lastStage {
							fmt.Printf("\n   • %s", res.Error)
							lastStage = res.Error
						}
					default:
						// A hard problem (e.g. interception). Surface it clearly.
						lastReason = res.Error
						fmt.Printf("\n   ⚠️  %s", res.Error)
					}
					if verified {
						break
					}
					// Steady "still working" tick roughly every 15s, with elapsed
					// time, so a long wait never looks stalled.
					if time.Since(lastHeartbeat) >= 15*time.Second {
						fmt.Printf(" (%ds)", int(time.Since(start).Seconds()))
						lastHeartbeat = time.Now()
					}
					fmt.Print(".")
					time.Sleep(5 * time.Second)
				}
				if !verified {
					return fmt.Errorf(
						"registered, but %s did not become verifiably live within 5 minutes (last status: %s).\n"+
							"The certificate may still be issuing — re-check in a minute; if it persists, the DNS/relay path needs attention",
						baileyURL, lastReason,
					)
				}
			}

			return nil
		},
	}

	cmd.Flags().StringVar(&serverName, "name", "", "Server name (required)")
	cmd.Flags().StringVar(&aocUrl, "aoc-api", "https://api.bitswan.space", "Automation operation server URL")
	cmd.Flags().StringVar(&otp, "otp", "", "One-time password from web interface (required)")
	cmd.Flags().StringVar(&automationServerId, "server-id", "", "Automation server ID from web interface (required)")
	cmd.Flags().BoolVar(&forceProxy, "force-proxy", false, "Reach this server through the AOC reverse-proxy relay even if it has a public IP (for testing the NAT path)")
	cmd.Flags().StringVar(&relayAddr, "relay-addr", "", "Relay tunnel endpoint host:port to dial (required with --force-proxy)")
	cmd.Flags().StringVar(&relayFingerprint, "relay-fingerprint", "", "Relay tunnel-cert sha256 fingerprint to pin (required with --force-proxy)")

	cmd.MarkFlagRequired("name")
	cmd.MarkFlagRequired("otp")
	cmd.MarkFlagRequired("server-id")

	return cmd
}
