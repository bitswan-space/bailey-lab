package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/daemon"
	"github.com/spf13/cobra"
)

// newBackupCmd creates the `bitswan backup` command group: server-level
// backups (whole workspace trees incl. secrets + DB dumps + server state →
// one restic repo per server via AOC), owned by the daemon. Key access is
// host-admin only — the key decrypts backups that contain secrets.
func newBackupCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "backup",
		Short: "Server-level backups (all workspaces + server state)",
	}
	cmd.AddCommand(newBackupStatusCmd())
	cmd.AddCommand(newBackupRunCmd())
	cmd.AddCommand(newBackupRetentionCmd())
	cmd.AddCommand(newBackupKeyCmd())
	cmd.AddCommand(newBackupSnapshotsCmd())
	cmd.AddCommand(newBackupRestoreCmd())
	return cmd
}

// newBackupRestoreCmd: targeted restores (docs/backup_restore_runbook.md has
// the full-server bootstrap procedure composed of these).
func newBackupRestoreCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "restore",
		Short: "Restore a workspace's files or databases from the server backup",
	}

	makeSub := func(restoreType, short string, needsStage bool) *cobra.Command {
		var workspace, stage, snapshot string
		sub := &cobra.Command{
			Use:          restoreType,
			Short:        short,
			Args:         cobra.NoArgs,
			SilenceUsage: true,
			RunE: func(cmd *cobra.Command, args []string) error {
				if workspace == "" {
					return fmt.Errorf("--workspace is required")
				}
				return backupClient().BackupRestore(restoreType, workspace, stage, snapshot)
			},
		}
		sub.Flags().StringVar(&workspace, "workspace", "", "workspace to restore (required)")
		sub.Flags().StringVar(&snapshot, "snapshot", "", "restic snapshot id (default: latest)")
		if needsStage {
			sub.Flags().StringVar(&stage, "stage", "production", "stage to restore into")
		}
		return sub
	}

	cmd.AddCommand(makeSub("files",
		"Restore the workspace file tree into a staging dir (never onto the live tree)", false))
	cmd.AddCommand(makeSub("postgres",
		"Restore the Postgres dump into the stage's running container (REPLACES data)", true))
	cmd.AddCommand(makeSub("couchdb",
		"Restore the CouchDB export into the stage's running container", true))
	return cmd
}

func backupClient() *daemon.Client {
	client, err := daemon.NewClient()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		fmt.Fprintln(os.Stderr, "Run 'bitswan automation-server-daemon init' to start it.")
		os.Exit(1)
	}
	return client
}

func newBackupStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:          "status",
		Short:        "Show backup configuration and the last run's outcome",
		Args:         cobra.NoArgs,
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			status, err := backupClient().BackupStatus()
			if err != nil {
				return err
			}

			onOff := func(b bool) string {
				if b {
					return "yes"
				}
				return "no"
			}
			fmt.Printf("AOC connected:  %s\n", onOff(status.AOCConnected))
			fmt.Printf("Enabled:        %s\n", onOff(status.Enabled))
			fmt.Printf("Encryption key: %s", onOff(status.HasKey))
			if status.KeyMirrored != nil {
				if *status.KeyMirrored {
					fmt.Printf(" (escrowed at AOC)")
				} else {
					fmt.Printf(" (LOCAL ONLY — download it: `bitswan backup key show`)")
				}
			}
			fmt.Println()
			fmt.Printf("Retention:      %d daily, %d monthly\n", status.Retention.Daily, status.Retention.Monthly)
			if status.Running {
				fmt.Println("A backup run is in progress.")
			}
			if status.Reason != "" {
				fmt.Printf("Inactive:       %s\n", status.Reason)
			}

			if status.LastRun == nil {
				fmt.Println("Last run:       never")
				return nil
			}
			last := status.LastRun
			outcome := "ok"
			if !last.OK {
				outcome = "FINISHED WITH ERRORS"
			}
			fmt.Printf("Last run:       %s (%s)\n", last.FinishedAt.Format(time.RFC3339), outcome)

			var workspaces []string
			for ws := range last.Workspaces {
				workspaces = append(workspaces, ws)
			}
			sort.Strings(workspaces)
			for _, ws := range workspaces {
				report := last.Workspaces[ws]
				var steps []string
				for step := range report {
					steps = append(steps, step)
				}
				sort.Strings(steps)
				for _, step := range steps {
					result := report[step]
					mark := "ok"
					if !result.Success {
						mark = "FAILED: " + result.Output
					}
					fmt.Printf("  %-20s %-10s %s\n", ws, step, mark)
				}
			}
			serverMark := "ok"
			if !last.ServerState.Success {
				serverMark = "FAILED: " + last.ServerState.Output
			}
			fmt.Printf("  %-20s %-10s %s\n", "(server)", "state", serverMark)
			return nil
		},
	}
}

func newBackupRunCmd() *cobra.Command {
	var wait bool
	cmd := &cobra.Command{
		Use:          "run",
		Short:        "Start a backup run now",
		Args:         cobra.NoArgs,
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			return backupClient().BackupRun(wait)
		},
	}
	cmd.Flags().BoolVar(&wait, "wait", false, "stream the run's progress and wait for completion")
	return cmd
}

func newBackupRetentionCmd() *cobra.Command {
	var daily, monthly int
	cmd := &cobra.Command{
		Use:          "retention",
		Short:        "Set the retention policy (per workspace × service × stage series)",
		Args:         cobra.NoArgs,
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			var dailyPtr, monthlyPtr *int
			if cmd.Flags().Changed("daily") {
				dailyPtr = &daily
			}
			if cmd.Flags().Changed("monthly") {
				monthlyPtr = &monthly
			}
			if dailyPtr == nil && monthlyPtr == nil {
				return fmt.Errorf("nothing to change: pass --daily and/or --monthly")
			}
			if err := backupClient().BackupSetConfig(nil, dailyPtr, monthlyPtr); err != nil {
				return err
			}
			fmt.Println("Retention policy saved.")
			return nil
		},
	}
	cmd.Flags().IntVar(&daily, "daily", 30, "nightly backups to keep")
	cmd.Flags().IntVar(&monthly, "monthly", 12, "monthly backups to keep")
	return cmd
}

func newBackupKeyCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "key",
		Short: "Manage the backup encryption key (host admin only)",
	}
	cmd.AddCommand(&cobra.Command{
		Use:          "show",
		Short:        "Print the encryption key (store it somewhere safe, OFF this server)",
		Args:         cobra.NoArgs,
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			key, err := backupClient().BackupKey()
			if err != nil {
				return err
			}
			fmt.Println(key)
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:          "mirror",
		Short:        "Escrow the key at AOC (recovers a rebuilt server)",
		Args:         cobra.NoArgs,
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := backupClient().BackupKeyMirror(); err != nil {
				return err
			}
			fmt.Println("Key escrowed at AOC.")
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:          "mirror-status",
		Short:        "Report whether the key is escrowed at AOC",
		Args:         cobra.NoArgs,
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			mirrored, err := backupClient().BackupKeyMirrorStatus()
			if err != nil {
				return err
			}
			if mirrored {
				fmt.Println("Key is escrowed at AOC.")
			} else {
				fmt.Println("Key is LOCAL ONLY — if this server is lost, backups are unrecoverable without a downloaded copy.")
			}
			return nil
		},
	})
	return cmd
}

func newBackupSnapshotsCmd() *cobra.Command {
	var workspace, tag string
	cmd := &cobra.Command{
		Use:          "snapshots",
		Short:        "List backup snapshots (restic JSON)",
		Args:         cobra.NoArgs,
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			raw, err := backupClient().BackupSnapshots(workspace, tag)
			if err != nil {
				return err
			}

			var snapshots []struct {
				ShortID string    `json:"short_id"`
				Time    time.Time `json:"time"`
				Tags    []string  `json:"tags"`
				Paths   []string  `json:"paths"`
			}
			if err := json.Unmarshal(raw, &snapshots); err != nil {
				// Unexpected shape — dump it raw rather than hiding it.
				fmt.Println(string(raw))
				return nil
			}
			if len(snapshots) == 0 {
				fmt.Println("No snapshots.")
				return nil
			}
			for _, snapshot := range snapshots {
				path := ""
				if len(snapshot.Paths) > 0 {
					path = snapshot.Paths[0]
				}
				fmt.Printf("%s  %s  %-40v %s\n",
					snapshot.ShortID,
					snapshot.Time.Format("2006-01-02 15:04:05"),
					snapshot.Tags,
					path,
				)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&workspace, "workspace", "", "only this workspace's snapshots")
	cmd.Flags().StringVar(&tag, "tag", "", "extra restic tag filter (e.g. postgres)")
	return cmd
}
