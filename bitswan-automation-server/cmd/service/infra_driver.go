package service

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/bitswan-space/bitswan-workspaces/internal/daemon"
	"github.com/spf13/cobra"
)

// NewInfraDriverCmd manages the per-workspace infra-driver sidecar. It is a
// mandatory core container (not enable/disable-able), so only `status` and
// `update` (image bump) are exposed.
func NewInfraDriverCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "infra-driver",
		Short: "Manage the workspace infra-driver sidecar",
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}
	cmd.AddCommand(newInfraDriverStatusCmd())
	cmd.AddCommand(newInfraDriverUpdateCmd())
	return cmd
}

func newInfraDriverStatusCmd() *cobra.Command {
	var workspace string
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show the infra-driver sidecar status (running + image)",
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
			result, err := client.GetServiceStatus("infra-driver", workspace, "", false)
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

func newInfraDriverUpdateCmd() *cobra.Command {
	var (
		workspace        string
		infraDriverImage string
		staging          bool
	)
	cmd := &cobra.Command{
		Use:   "update",
		Short: "Bump the infra-driver image and recreate the sidecar",
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
			if infraDriverImage != "" {
				options["infra_driver_image"] = infraDriverImage
			}
			result, err := client.UpdateService("infra-driver", workspace, options)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			if result != nil && result.Message != "" {
				fmt.Println(result.Message)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&infraDriverImage, "infra-driver-image", "", "Custom infra-driver image (else resolve the latest version)")
	cmd.Flags().BoolVar(&staging, "staging", false, "Resolve the staging image when no explicit image is given")
	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "Workspace name (uses active workspace if not specified)")
	return cmd
}
