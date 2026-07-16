package service

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/bitswan-space/bitswan-workspaces/internal/daemon"
	"github.com/spf13/cobra"
)

// NewGarageCmd creates the Garage (object storage) service command
func NewGarageCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "garage",
		Short: "Manage Garage service",
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}

	cmd.AddCommand(newGarageEnableCmd())
	cmd.AddCommand(newGarageDisableCmd())
	cmd.AddCommand(newGarageStatusCmd())
	cmd.AddCommand(newGarageStartCmd())
	cmd.AddCommand(newGarageStopCmd())
	cmd.AddCommand(newGarageUpdateCmd())
	cmd.AddCommand(newGarageBackupCmd())
	cmd.AddCommand(newGarageRestoreCmd())

	return cmd
}

func newGarageEnableCmd() *cobra.Command {
	var workspace string
	var stage string

	cmd := &cobra.Command{
		Use:   "enable",
		Short: "Enable Garage service for the workspace",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := daemon.NewClient()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				fmt.Fprintln(os.Stderr, "Run 'bitswan automation-server-daemon init' to start it.")
				os.Exit(1)
			}

			workspace, err = client.ResolveWorkspace(workspace)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: no active workspace configured. Use --workspace flag or run 'bitswan workspace select <workspace>'\n")
				os.Exit(1)
			}

			options := make(map[string]interface{})
			if stage != "" {
				options["stage"] = stage
			}

			result, err := client.EnableService("garage", workspace, options)
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

	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "Workspace name (uses active workspace if not specified)")
	cmd.Flags().StringVar(&stage, "stage", "production", "Service realm stage (dev, staging, production)")

	return cmd
}

func newGarageDisableCmd() *cobra.Command {
	var workspace string
	var stage string

	cmd := &cobra.Command{
		Use:   "disable",
		Short: "Disable Garage service for the workspace",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := daemon.NewClient()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				fmt.Fprintln(os.Stderr, "Run 'bitswan automation-server-daemon init' to start it.")
				os.Exit(1)
			}

			workspace, err = client.ResolveWorkspace(workspace)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: no active workspace configured. Use --workspace flag or run 'bitswan workspace select <workspace>'\n")
				os.Exit(1)
			}

			result, err := client.DisableService("garage", workspace, stage)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}

			fmt.Println(result.Message)
			return nil
		},
	}

	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "Workspace name (uses active workspace if not specified)")
	cmd.Flags().StringVar(&stage, "stage", "production", "Service realm stage (dev, staging, production)")

	return cmd
}

func newGarageStatusCmd() *cobra.Command {
	var showPasswords bool
	var workspace string
	var stage string

	cmd := &cobra.Command{
		Use:   "status",
		Short: "Check Garage service status for the workspace",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := daemon.NewClient()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				fmt.Fprintln(os.Stderr, "Run 'bitswan automation-server-daemon init' to start it.")
				os.Exit(1)
			}

			workspace, err = client.ResolveWorkspace(workspace)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: no active workspace configured. Use --workspace flag or run 'bitswan workspace select <workspace>'\n")
				os.Exit(1)
			}

			result, err := client.GetServiceStatus("garage", workspace, stage, showPasswords)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}

			if statusData, ok := result.Data.(map[string]interface{}); ok {
				if enabled, ok := statusData["enabled"].(bool); ok {
					if enabled {
						fmt.Printf("Garage service is ENABLED for workspace '%s'\n", workspace)
						if running, ok := statusData["running"].(bool); ok {
							if running {
								fmt.Println("Container status: RUNNING")
							} else {
								fmt.Println("Container status: STOPPED")
							}
						}
					} else {
						fmt.Printf("Garage service is DISABLED for workspace '%s'\n", workspace)
					}
				}
			}

			return nil
		},
	}

	cmd.Flags().BoolVar(&showPasswords, "passwords", false, "Show Garage credentials")
	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "Workspace name (uses active workspace if not specified)")
	cmd.Flags().StringVar(&stage, "stage", "production", "Service realm stage (dev, staging, production)")

	return cmd
}

func newGarageStartCmd() *cobra.Command {
	var workspace string
	var stage string

	cmd := &cobra.Command{
		Use:   "start",
		Short: "Start Garage container for the workspace",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := daemon.NewClient()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				fmt.Fprintln(os.Stderr, "Run 'bitswan automation-server-daemon init' to start it.")
				os.Exit(1)
			}

			workspace, err = client.ResolveWorkspace(workspace)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: no active workspace configured. Use --workspace flag or run 'bitswan workspace select <workspace>'\n")
				os.Exit(1)
			}

			result, err := client.StartService("garage", workspace, stage)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}

			fmt.Println(result.Message)
			return nil
		},
	}

	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "Workspace name (uses active workspace if not specified)")
	cmd.Flags().StringVar(&stage, "stage", "production", "Service realm stage (dev, staging, production)")

	return cmd
}

func newGarageStopCmd() *cobra.Command {
	var workspace string
	var stage string

	cmd := &cobra.Command{
		Use:   "stop",
		Short: "Stop Garage container for the workspace",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := daemon.NewClient()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				fmt.Fprintln(os.Stderr, "Run 'bitswan automation-server-daemon init' to start it.")
				os.Exit(1)
			}

			workspace, err = client.ResolveWorkspace(workspace)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: no active workspace configured. Use --workspace flag or run 'bitswan workspace select <workspace>'\n")
				os.Exit(1)
			}

			result, err := client.StopService("garage", workspace, stage)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}

			fmt.Println(result.Message)
			return nil
		},
	}

	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "Workspace name (uses active workspace if not specified)")
	cmd.Flags().StringVar(&stage, "stage", "production", "Service realm stage (dev, staging, production)")

	return cmd
}

func newGarageUpdateCmd() *cobra.Command {
	var garageImage string
	var workspace string
	var stage string

	cmd := &cobra.Command{
		Use:   "update",
		Short: "Update Garage service with new image",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := daemon.NewClient()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				fmt.Fprintln(os.Stderr, "Run 'bitswan automation-server-daemon init' to start it.")
				os.Exit(1)
			}

			workspace, err = client.ResolveWorkspace(workspace)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: no active workspace configured. Use --workspace flag or run 'bitswan workspace select <workspace>'\n")
				os.Exit(1)
			}

			options := make(map[string]interface{})
			if stage != "" {
				options["stage"] = stage
			}
			if garageImage != "" {
				options["garage_image"] = garageImage
			}

			result, err := client.UpdateService("garage", workspace, options)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}

			fmt.Println(result.Message)
			return nil
		},
	}

	cmd.Flags().StringVar(&garageImage, "garage-image", "", "Custom image for Garage")
	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "Workspace name (uses active workspace if not specified)")
	cmd.Flags().StringVar(&stage, "stage", "production", "Service realm stage (dev, staging, production)")

	return cmd
}

func newGarageBackupCmd() *cobra.Command {
	var backupPath string
	var workspace string
	var stage string

	cmd := &cobra.Command{
		Use:   "backup",
		Short: "Create a backup of all Garage buckets",
		Long:  "Creates a backup of all buckets in Garage. The backup will be saved as a tarball with automatic date/time naming (format: garage-backup-YYYYMMDD-HHMMSS.tar) in the specified directory.",
		RunE: func(cmd *cobra.Command, args []string) error {
			if backupPath == "" {
				fmt.Fprintf(os.Stderr, "Error: backup path is required. Use --path to specify the backup location\n")
				os.Exit(1)
			}

			absBackupPath, err := filepath.Abs(backupPath)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: failed to resolve backup path: %v\n", err)
				os.Exit(1)
			}

			client, err := daemon.NewClient()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				fmt.Fprintln(os.Stderr, "Run 'bitswan automation-server-daemon init' to start it.")
				os.Exit(1)
			}

			workspace, err = client.ResolveWorkspace(workspace)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: no active workspace configured. Use --workspace flag or run 'bitswan workspace select <workspace>'\n")
				os.Exit(1)
			}

			result, err := client.BackupGarage(workspace, stage, absBackupPath)
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

	cmd.Flags().StringVar(&backupPath, "path", "", "Directory where the backup tarball will be saved (required)")
	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "Workspace name (uses active workspace if not specified)")
	cmd.Flags().StringVar(&stage, "stage", "production", "Service realm stage (dev, staging, production)")
	cmd.MarkFlagRequired("path")

	return cmd
}

func newGarageRestoreCmd() *cobra.Command {
	var backupPath string
	var workspace string
	var stage string

	cmd := &cobra.Command{
		Use:   "restore",
		Short: "Restore Garage buckets from a backup",
		Long:  "Restores Garage buckets from a backup tarball (.tar.gz) or directory. Buckets will be created if they don't exist.",
		RunE: func(cmd *cobra.Command, args []string) error {
			if backupPath == "" {
				fmt.Fprintf(os.Stderr, "Error: backup path is required. Use --path to specify the backup location\n")
				os.Exit(1)
			}

			absBackupPath, err := filepath.Abs(backupPath)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: failed to resolve backup path: %v\n", err)
				os.Exit(1)
			}

			client, err := daemon.NewClient()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				fmt.Fprintln(os.Stderr, "Run 'bitswan automation-server-daemon init' to start it.")
				os.Exit(1)
			}

			workspace, err = client.ResolveWorkspace(workspace)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: no active workspace configured. Use --workspace flag or run 'bitswan workspace select <workspace>'\n")
				os.Exit(1)
			}

			err = client.RestoreGarageInteractive(workspace, stage, absBackupPath)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}

			return nil
		},
	}

	cmd.Flags().StringVar(&backupPath, "path", "", "Path to the backup tarball (.tar.gz) or directory (required)")
	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "Workspace name (uses active workspace if not specified)")
	cmd.Flags().StringVar(&stage, "stage", "production", "Service realm stage (dev, staging, production)")
	cmd.MarkFlagRequired("path")

	return cmd
}
