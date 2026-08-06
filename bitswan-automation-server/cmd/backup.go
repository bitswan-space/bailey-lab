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
	cmd.AddCommand(newBackupManifestCmd())
	cmd.AddCommand(newBackupRestoreCmd())
	cmd.AddCommand(newBackupRecoverCmd())
	return cmd
}

// newBackupRecoverCmd: full workspace recovery in one operation — the
// automated form of docs/backup_restore_runbook.md.
func newBackupRecoverCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "recover",
		Short: "Recover a whole workspace (files, containers and data) from the backup",
	}

	var req daemon.RecoverRequest
	var yes bool

	sub := &cobra.Command{
		Use:   "workspace <workspace-name>",
		Short: "Restore a workspace's tree, rebuild its containers and reload its data",
		Long: "Recover a workspace end to end: restore its file tree (secrets included), " +
			"recreate every container that mounts it, re-apply its deployments so the driver " +
			"rebuilds the infra services and business-process containers, then reload the " +
			"databases and object storage for each enabled stage.\n\n" +
			"By default the whole workspace's current state is replaced, so an existing " +
			"workspace requires --force.",
		Args:         cobra.ExactArgs(1),
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			req.Workspace = args[0]

			if !yes && !req.DryRun {
				fmt.Printf("This replaces workspace %q — its containers are recreated and its "+
					"tree and databases are restored from the backup.\nType the workspace name to continue: ",
					req.Workspace)
				var answer string
				_, _ = fmt.Scanln(&answer)
				if answer != req.Workspace {
					return fmt.Errorf("aborted")
				}
			}
			return backupClient().BackupRecoverWorkspace(req)
		},
		ValidArgsFunction: validWorkspaceArgs,
	}

	f := sub.Flags()
	f.StringVar(&req.SnapshotID, "snapshot", "", "files snapshot to anchor the recovery (default: latest)")
	f.BoolVar(&req.Force, "force", false, "replace an existing workspace directory")
	f.StringSliceVar(&req.Stages, "stage", nil, "only this stage (repeatable; default: every enabled stage)")
	f.BoolVar(&req.SkipFiles, "skip-files", false, "keep the current tree; only rebuild containers and reload data")
	f.BoolVar(&req.SkipContainers, "skip-containers", false, "only restore files (requires --skip-files off)")
	f.BoolVar(&req.SkipPostgres, "skip-postgres", false, "do not restore Postgres")
	f.BoolVar(&req.SkipCouchDB, "skip-couchdb", false, "do not restore CouchDB")
	f.BoolVar(&req.SkipGarage, "skip-garage", false, "do not restore Garage object storage")
	f.BoolVar(&req.SkipBPSnapshots, "skip-bp-snapshots", false,
		"exclude per-process snapshots from the file restore (faster; they can be fetched back on demand)")
	f.BoolVar(&req.GarageMirror, "garage-mirror", false,
		"mirror Garage buckets instead of copying — DELETES objects absent from the backup")
	f.BoolVar(&req.DiscardBackup, "discard-previous", false,
		"delete the quarantined pre-recovery tree on success (kept by default)")
	f.BoolVar(&req.DryRun, "dry-run", false, "print what would be recovered and exit")
	f.BoolVar(&yes, "yes", false, "skip the confirmation prompt")

	cmd.AddCommand(sub)
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
		var mirror bool
		sub := &cobra.Command{
			Use:          restoreType,
			Short:        short,
			Args:         cobra.NoArgs,
			SilenceUsage: true,
			RunE: func(cmd *cobra.Command, args []string) error {
				if workspace == "" {
					return fmt.Errorf("--workspace is required")
				}
				return backupClient().BackupRestore(restoreType, workspace, stage, snapshot, mirror)
			},
		}
		sub.Flags().StringVar(&workspace, "workspace", "", "workspace to restore (required)")
		sub.Flags().StringVar(&snapshot, "snapshot", "", "restic snapshot id (default: latest)")
		if needsStage {
			sub.Flags().StringVar(&stage, "stage", "production", "stage to restore into")
		}
		if restoreType == "garage" {
			sub.Flags().BoolVar(&mirror, "mirror", false,
				"mirror instead of copy — DELETES objects absent from the backup")
		}
		return sub
	}

	cmd.AddCommand(makeSub("files",
		"Restore the workspace file tree into a staging dir (never onto the live tree)", false))
	cmd.AddCommand(makeSub("postgres",
		"Restore the Postgres dump into the stage's running container (REPLACES data)", true))
	cmd.AddCommand(makeSub("couchdb",
		"Restore the CouchDB export into the stage's running container", true))
	cmd.AddCommand(makeSub("garage",
		"Restore the stage's Garage buckets (run after the workspace is applied)", true))
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
			if status.HasKey {
				if status.KeyAcknowledged {
					fmt.Printf(" (saved off-server \u2014 acknowledged)")
				} else {
					fmt.Printf(" (NOT SAVED)")
				}
			}
			fmt.Println()
			if status.KeyWarning != "" {
				fmt.Printf("\n!! %s\n\n", status.KeyWarning)
			}
			fmt.Printf("Retention:      %d daily, %d monthly\n", status.Retention.Daily, status.Retention.Monthly)
			if status.Running {
				fmt.Println("A backup run is in progress.")
			}
			if status.ServerRecoveryUntil != nil {
				fmt.Printf("Server recovery: in progress — the AOC workspace sync and the "+
					"catch-up backup stand aside until it finishes (or until %s)\n",
					status.ServerRecoveryUntil.Local().Format(time.RFC1123))
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
	var acknowledge bool
	showCmd := &cobra.Command{
		Use:   "show",
		Short: "Print the encryption key (store it somewhere safe, OFF this server)",
		Long: "Print the backup encryption key.\n\n" +
			"This key is stored NOWHERE except this server — there is no escrow. If the server " +
			"is lost and you have no copy, every backup is permanently unreadable. Once you have " +
			"stored it somewhere safe, re-run with --acknowledge to silence the warnings.",
		Args:         cobra.NoArgs,
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			client := backupClient()
			key, err := client.BackupKey()
			if err != nil {
				return err
			}
			fmt.Println(key)
			if acknowledge {
				if err := client.BackupKeyAcknowledge(); err != nil {
					return err
				}
				fmt.Fprintln(os.Stderr, "Recorded that this key has been saved off-server.")
			}
			return nil
		},
	}
	showCmd.Flags().BoolVar(&acknowledge, "acknowledge", false,
		"record that you have stored this key safely off this server")
	cmd.AddCommand(showCmd)
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
