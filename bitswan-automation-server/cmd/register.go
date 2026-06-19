package cmd

import (
	"fmt"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/cmd/automationserverdaemon"
	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
	"github.com/bitswan-space/bitswan-workspaces/internal/config"
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

			// Check if already registered to an AOC instance
			cfg := config.NewAutomationServerConfig()
			if settings, err := cfg.GetAutomationOperationsCenterSettings(); err == nil && settings.AccessToken != "" {
				return fmt.Errorf(
					"this automation server is already registered to an AOC instance at %s (server ID: %s).\n"+
						"To register with a different AOC instance, first disconnect using:\n\n"+
						"  bitswan disconnect-from-aoc",
					settings.AOCUrl, settings.AutomationServerId,
				)
			}

			// Create AOC client with OTP
			aocClient, err := aoc.NewAOCClientWithOTP(aocUrl, otp, automationServerId)
			if err != nil {
				return fmt.Errorf("failed to create AOC client: %w", err)
			}

			// Get automation server info to verify connection
			serverInfo, err := aocClient.GetAutomationServerInfo()
			if err != nil {
				return fmt.Errorf("failed to get automation server info: %w", err)
			}

			// Persist the AOC-assigned domain (e.g. acme-prod.bswn.io) so the
			// daemon can configure wildcard certificates for it.
			aocClient.SetDomain(serverInfo.Domain)

			// Save the configuration
			if err := aocClient.SaveConfig(); err != nil {
				return fmt.Errorf("failed to save configuration: %w", err)
			}

			fmt.Printf("✅ Successfully registered automation server '%s' with ID: %s\n", serverInfo.Name, serverInfo.AutomationServerId)
			fmt.Println("Access token, AOC URL, and Automation server ID have been saved to ~/.config/bitswan/automation_server_config.toml.")

			// Make sure the daemon is up before we talk to it over the socket.
			// This lets `register` bring up a fresh server from nothing.
			fmt.Println("\n🚀 Ensuring the automation server daemon is running...")
			if err := automationserverdaemon.EnsureDaemonRunning(); err != nil {
				return fmt.Errorf("failed to ensure daemon is running: %w", err)
			}

			client, err := newDaemonClientWithRetry()
			if err != nil {
				return fmt.Errorf("failed to create daemon client (daemon may not be running): %w", err)
			}

			// If the AOC assigned this server a domain, stand up the full
			// protected-ingress stack BEFORE (re)deploying workspaces, so each
			// workspace's routes register through the auth wrap rather than as
			// bare single-tier routes (see addRouteTraefik).
			if serverInfo.Domain != "" {
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
			}

			// Now connect existing workspaces to AOC via daemon. With the
			// protected proxy already running, their route registrations take
			// the wrapped path automatically.
			fmt.Println("\n🔗 Connecting existing workspaces to AOC...")
			if err := client.WorkspaceConnectToAOC(aocUrl, serverInfo.AutomationServerId, aocClient.GetAccessToken()); err != nil {
				return err
			}

			// Reinitialize MQTT connection so the daemon picks up the new AOC credentials
			fmt.Println("\n📡 Initializing MQTT connection...")
			if err := client.ReconnectMQTT(); err != nil {
				fmt.Printf("Warning: Failed to initialize MQTT connection: %v\n", err)
				fmt.Println("You may need to restart the daemon to connect to MQTT.")
			} else {
				fmt.Println("MQTT connection established successfully.")
			}

			return nil
		},
	}

	cmd.Flags().StringVar(&serverName, "name", "", "Server name (required)")
	cmd.Flags().StringVar(&aocUrl, "aoc-api", "https://api.bitswan.space", "Automation operation server URL")
	cmd.Flags().StringVar(&otp, "otp", "", "One-time password from web interface (required)")
	cmd.Flags().StringVar(&automationServerId, "server-id", "", "Automation server ID from web interface (required)")

	cmd.MarkFlagRequired("name")
	cmd.MarkFlagRequired("otp")
	cmd.MarkFlagRequired("server-id")

	return cmd
}
