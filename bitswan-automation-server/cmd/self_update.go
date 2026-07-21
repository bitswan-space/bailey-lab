package cmd

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/cmd/automationserverdaemon"
	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/spf13/cobra"
)

// newSelfUpdateCmd creates the top-level `bitswan self-update` command.
//
// The daemon runs from a read-only bind-mount of the host binary and cannot
// replace its own running process, so updating the server is host-side and
// CLI-only (the Bailey admin Updates view shows this command rather than a
// button). The new binary is fetched from the AOC this server is registered
// with — the same endpoint the install one-liner uses — so the AOC stays the
// single source of the "official" binary. `--rollback` restores the binary saved
// before the last self-update; both directions recreate the daemon container so
// it picks up the swapped binary.
func newSelfUpdateCmd() *cobra.Command {
	var rollback bool
	cmd := &cobra.Command{
		Use:          "self-update",
		Short:        "Update the bitswan server binary from the AOC and restart the daemon",
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if rollback {
				return runSelfRollback()
			}
			return runSelfUpdate()
		},
	}
	cmd.Flags().BoolVar(&rollback, "rollback", false, "Restore the binary saved before the last self-update (CLI-only)")
	return cmd
}

// selfBinaryPath resolves the actual on-disk path of the running binary,
// following /proc/self/exe (Linux) then any symlinks.
func selfBinaryPath() (string, error) {
	var p string
	var err error
	if runtime.GOOS == "linux" {
		if p, err = os.Readlink("/proc/self/exe"); err != nil {
			if p, err = os.Executable(); err != nil {
				return "", fmt.Errorf("failed to get executable path: %w", err)
			}
		}
	} else if p, err = os.Executable(); err != nil {
		return "", fmt.Errorf("failed to get executable path: %w", err)
	}
	if p, err = filepath.EvalSymlinks(p); err != nil {
		return "", fmt.Errorf("failed to resolve symlinks: %w", err)
	}
	return filepath.Abs(p)
}

// binaryArch maps the Go runtime arch to the values the AOC binary endpoint
// serves (amd64 / arm64), matching the install one-liner's `uname -m` mapping.
func binaryArch() (string, error) {
	switch runtime.GOARCH {
	case "amd64":
		return "amd64", nil
	case "arm64":
		return "arm64", nil
	default:
		return "", fmt.Errorf("unsupported architecture: %s", runtime.GOARCH)
	}
}

func runSelfUpdate() error {
	binPath, err := selfBinaryPath()
	if err != nil {
		return err
	}

	cfg := config.NewAutomationServerConfig()
	settings, err := cfg.GetAutomationOperationsCenterSettings()
	if err != nil {
		return fmt.Errorf("failed to read AOC settings: %w", err)
	}
	if settings.AOCUrl == "" {
		return fmt.Errorf("this server is not registered with an AOC, so there is nowhere to download the official binary from — run `bitswan register` first, or replace the binary manually")
	}

	arch, err := binaryArch()
	if err != nil {
		return err
	}

	url := strings.TrimRight(settings.AOCUrl, "/") + "/api/automation_server/bitswan?arch=" + arch
	fmt.Printf("Downloading the latest bitswan binary from %s ...\n", url)

	resp, err := http.Get(url)
	if err != nil {
		return fmt.Errorf("failed to download binary: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("failed to download binary: AOC returned status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	// Write to a temp file in the SAME directory so the final rename is atomic
	// (same filesystem). A running Linux binary cannot be truncated in place
	// (ETXTBSY), but renaming over it unlinks the old inode while this process
	// keeps running from it — the swap only takes effect on daemon recreate.
	dir := filepath.Dir(binPath)
	tmp, err := os.CreateTemp(dir, ".bitswan-update-*")
	if err != nil {
		return fmt.Errorf("failed to create temp file (need write access to %s): %w", dir, err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op once renamed away

	if _, err := io.Copy(tmp, resp.Body); err != nil {
		tmp.Close()
		return fmt.Errorf("failed to write downloaded binary: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("failed to finalize downloaded binary: %w", err)
	}
	if err := os.Chmod(tmpPath, 0755); err != nil {
		return fmt.Errorf("failed to chmod downloaded binary: %w", err)
	}

	// Keep the current binary as the rollback point, then swap the new one in.
	backupPath := binPath + ".bak"
	if err := os.Rename(binPath, backupPath); err != nil {
		return fmt.Errorf("failed to back up current binary: %w", err)
	}
	if err := os.Rename(tmpPath, binPath); err != nil {
		// Best-effort restore so we never leave the host without a binary.
		_ = os.Rename(backupPath, binPath)
		return fmt.Errorf("failed to install new binary: %w", err)
	}
	fmt.Printf("Installed new binary at %s (previous saved to %s)\n", binPath, backupPath)

	fmt.Println("Recreating the daemon container with the new binary...")
	if err := automationserverdaemon.Recreate(); err != nil {
		return fmt.Errorf("binary swapped, but recreating the daemon failed: %w — run `bitswan automation-server-daemon update` to retry", err)
	}
	fmt.Println("Server updated. Run `bitswan version` to confirm.")
	return nil
}

func runSelfRollback() error {
	binPath, err := selfBinaryPath()
	if err != nil {
		return err
	}
	backupPath := binPath + ".bak"

	if _, err := os.Stat(backupPath); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("no rollback binary at %s — nothing to roll back to (one is saved on the next `bitswan self-update`)", backupPath)
		}
		return fmt.Errorf("failed to stat rollback binary: %w", err)
	}

	// Reversible swap: current <-> .bak, so a second `self-update --rollback`
	// returns to the version you rolled away from.
	dir := filepath.Dir(binPath)
	tmp, err := os.CreateTemp(dir, ".bitswan-rollback-*")
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	tmpPath := tmp.Name()
	tmp.Close()
	defer os.Remove(tmpPath)

	if err := os.Rename(binPath, tmpPath); err != nil {
		return fmt.Errorf("failed to move current binary aside: %w", err)
	}
	if err := os.Rename(backupPath, binPath); err != nil {
		_ = os.Rename(tmpPath, binPath)
		return fmt.Errorf("failed to restore rollback binary: %w", err)
	}
	if err := os.Rename(tmpPath, backupPath); err != nil {
		return fmt.Errorf("restored rollback binary, but failed to keep the previous one as .bak: %w", err)
	}
	fmt.Printf("Restored binary from %s\n", backupPath)

	fmt.Println("Recreating the daemon container with the restored binary...")
	if err := automationserverdaemon.Recreate(); err != nil {
		return fmt.Errorf("binary restored, but recreating the daemon failed: %w — run `bitswan automation-server-daemon update` to retry", err)
	}
	fmt.Println("Rollback complete. Run `bitswan version` to confirm.")
	return nil
}
