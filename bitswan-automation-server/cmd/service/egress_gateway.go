package service

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/bitswan-space/bitswan-workspaces/internal/daemon"
	"github.com/spf13/cobra"
)

// NewEgressGatewayCmd manages the per-BP egress-gateway image. Gateways are
// created dynamically by the infra-driver per firewall group, so only `status`
// (list active gateways + pinned image) and `update` (bump the pinned image) are
// exposed.
func NewEgressGatewayCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "egress-gateway",
		Short: "Manage the workspace egress-gateway image",
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}
	cmd.AddCommand(newEgressGatewayStatusCmd())
	cmd.AddCommand(newEgressGatewayUpdateCmd())
	return cmd
}

func newEgressGatewayStatusCmd() *cobra.Command {
	var workspace string
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show the pinned egress-gateway image and any active gateways",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := daemon.NewClient()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				fmt.Fprintln(os.Stderr, "Run 'bitswan automation-server-daemon init' to start it.")
				os.Exit(1)
			}
			if err := resolveServiceWorkspace(client, &workspace); err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			result, err := client.GetServiceStatus("egress-gateway", workspace, "", false)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			if result != nil && result.Data != nil {
				out, _ := json.MarshalIndent(result.Data, "", "  ")
				fmt.Println(string(out))
			}
			return nil
		},
	}
	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "Workspace name (uses active workspace if not specified)")
	return cmd
}

func newEgressGatewayUpdateCmd() *cobra.Command {
	var (
		workspace          string
		egressGatewayImage string
		staging            bool
	)
	cmd := &cobra.Command{
		Use:   "update",
		Short: "Pin a new egress-gateway image (applies to gateways on the next deploy)",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := daemon.NewClient()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				fmt.Fprintln(os.Stderr, "Run 'bitswan automation-server-daemon init' to start it.")
				os.Exit(1)
			}
			if err := resolveServiceWorkspace(client, &workspace); err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			options := map[string]interface{}{"staging": staging}
			if egressGatewayImage != "" {
				options["egress_gateway_image"] = egressGatewayImage
			}
			result, err := client.UpdateService("egress-gateway", workspace, options)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			if result != nil && result.Message != "" {
				fmt.Println(result.Message)
			}
			fmt.Println("Existing gateways pick up the new image on their next BP deploy.")
			return nil
		},
	}
	cmd.Flags().StringVar(&egressGatewayImage, "egress-gateway-image", "", "Custom egress-gateway image (else resolve the latest version)")
	cmd.Flags().BoolVar(&staging, "staging", false, "Resolve the staging image when no explicit image is given")
	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "Workspace name (uses active workspace if not specified)")
	return cmd
}

// resolveServiceWorkspace fills in the active workspace when -w is omitted.
// Shared by the infra-driver + egress-gateway service commands.
func resolveServiceWorkspace(client *daemon.Client, workspace *string) error {
	ws, err := client.ResolveWorkspace(*workspace)
	if err != nil {
		return fmt.Errorf("no active workspace configured. Use --workspace flag or run 'bitswan workspace select <workspace>'")
	}
	*workspace = ws
	return nil
}
