package cmd

import (
	"fmt"

	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/daemon"
	"github.com/spf13/cobra"
)



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

			// Now connect existing workspaces to AOC via daemon
			fmt.Println("\n🔗 Connecting existing workspaces to AOC...")
			client, err := daemon.NewClient()
			if err != nil {
				return fmt.Errorf("failed to create daemon client (daemon may not be running): %w", err)
			}

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

			// If the AOC assigned this server a domain, reconfigure the
			// ingress so Traefik obtains a *.<domain> wildcard certificate
			// via the DNS-01 challenge (through the AOC) instead of issuing
			// a separate HTTP-01 certificate per endpoint.
			if serverInfo.Domain != "" {
				fmt.Printf("\n🔐 Configuring ingress for a *.%s wildcard certificate...\n", serverInfo.Domain)
				if _, err := client.InitIngress(false); err != nil {
					fmt.Printf("Warning: Failed to reconfigure ingress for wildcard certificates: %v\n", err)
					fmt.Println("Run 'bitswan ingress init' to apply the wildcard certificate configuration.")
				} else {
					fmt.Println("Ingress configured to use a DNS-01 wildcard certificate.")
				}
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


