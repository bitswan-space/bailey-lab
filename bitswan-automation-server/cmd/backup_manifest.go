package cmd

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/daemon/backup"
	"github.com/spf13/cobra"
)

// `bitswan backup manifest` — what a backup says the server WAS.
//
// Two modes, deliberately the same command:
//
//   * on a live server, no flags: the daemon reads it (restic lives in the
//     daemon's container).
//   * on a machine being rebuilt, with --aoc-api/--server-id/--token/--key-file:
//     there is no daemon and no config file, so everything comes from the
//     disaster-recovery command AOC hands out, and restic runs in a throwaway
//     container from the runtime image.
//
// The second mode is the bootstrap `bitswan recover server` is built on. Being
// able to run it on its own matters: an operator can confirm a backup is
// readable — right key, right repo, right server — from any machine with
// docker, BEFORE committing to a rebuild.

func newBackupManifestCmd() *cobra.Command {
	var aocAPI, serverID, token, keyFile, snapshot, image string

	cmd := &cobra.Command{
		Use:   "manifest",
		Short: "Print what a backup says the server was (workspaces, image pins, versions)",
		Long: "Read the server manifest recorded inside a backup snapshot: which workspaces " +
			"existed and their AOC ids, the image pins that live nowhere but the daemon's " +
			"environment, the ingress hostnames, and the versions that made the backup.\n\n" +
			"With no flags this asks the local daemon. On a machine with no daemon — a " +
			"replacement server mid-recovery — pass --aoc-api, --server-id, --token and " +
			"--key-file instead; restic then runs in a throwaway container, since it ships in " +
			"the runtime image rather than in this binary. Docker is the only prerequisite.\n\n" +
			"The token is what the disaster-recovery command's one-time password exchanges " +
			"for. There is no way to supply the encryption key other than --key-file: it is " +
			"never escrowed, so only your own copy can read the backup.",
		Args:         cobra.NoArgs,
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			daemonless := aocAPI != "" || serverID != "" || token != "" || keyFile != ""
			if !daemonless {
				manifest, warning, err := backupClient().BackupManifest(snapshot)
				if err != nil {
					return err
				}
				printServerManifest(manifest, warning)
				return nil
			}

			missing := []string{}
			for flag, value := range map[string]string{
				"--aoc-api":   aocAPI,
				"--server-id": serverID,
				"--token":     token,
				"--key-file":  keyFile,
			} {
				if value == "" {
					missing = append(missing, flag)
				}
			}
			if len(missing) > 0 {
				sort.Strings(missing)
				return fmt.Errorf("reading a backup without a daemon needs all of "+
					"--aoc-api, --server-id, --token and --key-file; missing %s",
					strings.Join(missing, ", "))
			}

			key, err := readKeyFile(keyFile)
			if err != nil {
				return err
			}

			manifest, warning, err := readManifestWithoutDaemon(
				cmd.Context(), aocAPI, serverID, token, key, snapshot, image)
			if err != nil {
				return err
			}
			printServerManifest(manifest, warning)
			return nil
		},
	}

	f := cmd.Flags()
	f.StringVar(&snapshot, "snapshot", "", "snapshot to read (default: the latest server-state snapshot)")
	f.StringVar(&aocAPI, "aoc-api", "", "AOC base URL (daemon-less mode)")
	f.StringVar(&serverID, "server-id", "", "automation server id (daemon-less mode)")
	f.StringVar(&token, "token", "", "AOC access token, from exchanging the recovery OTP (daemon-less mode)")
	f.StringVar(&keyFile, "key-file", "", "file holding the backup encryption key (daemon-less mode)")
	f.StringVar(&image, "runtime-image", "",
		"image providing restic (default: the pin recorded in the backup, else "+backup.DefaultRuntimeImage+")")
	return cmd
}

// readKeyFile loads the encryption key an operator saved off-server. This is
// the only way in: the key is never escrowed in AOC or object storage, so a
// backup with no surviving copy of its key is unreadable by anyone.
func readKeyFile(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("could not read the backup encryption key: %w", err)
	}
	key := strings.TrimSpace(string(raw))
	if key == "" {
		return "", fmt.Errorf("the backup encryption key file %s is empty", path)
	}
	return key, nil
}

// newDaemonlessRestic builds a restic runner for a machine with no daemon and no
// restic binary: credentials come from the command line rather than a config file,
// and restic itself runs in a throwaway container from the runtime image.
//
// `cred` is whatever authenticates to the AOC's restic proxy. Normally that is the
// server's access token; during a recovery's read-only preflight it is the recovery
// OTP instead, which works unchanged because the proxy takes either as the REST
// password (see backup.NewAOCTarget).
func newDaemonlessRestic(aocAPI, serverID, cred, key, image string) *backup.Restic {
	target := backup.NewAOCTarget(aocAPI, serverID, cred)
	exec := backup.NewContainerExec(image)
	// A .localhost AOC is only reachable over the docker network — the same dev
	// rewrite AOCClient.GetAOCEnvironmentVariables applies for workspace
	// containers. Automatic and dev-only: a real AOC is resolved by DNS like
	// anything else.
	if target.InDockerNetwork() {
		exec.OnBitswanNetwork()
	}
	restic := backup.NewRestic(target, key)
	restic.Container = exec
	return restic
}

// readManifestWithoutDaemon is the bare-machine bootstrap: build the AOC target
// from supplied values and read the manifest with restic in a container.
func readManifestWithoutDaemon(
	ctx context.Context, aocAPI, serverID, token, key, snapshot, image string,
) (backup.ServerManifest, string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	restic := newDaemonlessRestic(aocAPI, serverID, token, key, image)

	manifest, err := backup.ReadServerManifest(ctx, restic, snapshot)
	if err != nil {
		return manifest, "", err
	}
	// The recovery runs on THIS binary, so compare against it rather than
	// against whatever version the manifest happens to name.
	return manifest, backup.CheckVersionSkew(manifest, rootCmdVersion()), nil
}

func printServerManifest(m backup.ServerManifest, versionWarning string) {
	if versionWarning != "" {
		fmt.Fprintf(os.Stderr, "Warning: %s\n\n", versionWarning)
	}

	fmt.Printf("Server:        %s\n", orDash(m.ServerID))
	fmt.Printf("Captured:      %s\n", m.CapturedAt.Local().Format(time.RFC1123))
	fmt.Printf("Made by:       bitswan %s\n", orDash(m.BitswanVersion))
	fmt.Printf("Daemon image:  %s\n", orDash(m.DaemonImage))
	fmt.Printf("AOC:           %s\n", orDash(m.AOCUrl))
	if m.Domain != "" {
		fmt.Printf("Domain:        %s", m.Domain)
		if m.Proxied {
			fmt.Print(" (through the AOC relay)")
		}
		fmt.Println()
	}
	if m.ProtectedDomain != "" {
		fmt.Printf("Protected:     %s\n", m.ProtectedDomain)
	}

	fmt.Printf("\nWorkspaces (%d):\n", len(m.Workspaces))
	for _, ws := range m.Workspaces {
		fmt.Printf("  %s\n", ws.Name)
		if ws.Domain != "" {
			fmt.Printf("      domain:   %s\n", ws.Domain)
		}
		if ws.WorkspaceID != "" {
			fmt.Printf("      aoc id:   %s\n", ws.WorkspaceID)
		}
		for _, service := range sortedKeys(ws.Enabled) {
			fmt.Printf("      %-9s %s\n", service+":", strings.Join(ws.Enabled[service], ", "))
		}
	}
	if len(m.Workspaces) == 0 {
		fmt.Println("  (none)")
	}

	if len(m.ImagePins) > 0 {
		// Worth printing prominently: these live only in the daemon
		// container's environment, so a rebuilt server silently reverts to
		// defaults unless they are put back.
		fmt.Println("\nImage pins (not stored on disk anywhere):")
		for _, name := range sortedKeys(m.ImagePins) {
			fmt.Printf("  %s=%s\n", name, m.ImagePins[name])
		}
	}
	if len(m.Routes) > 0 {
		fmt.Printf("\nIngress hostnames (%d):\n", len(m.Routes))
		for _, route := range m.Routes {
			fmt.Printf("  %s\n", route)
		}
	}
	if len(m.DeliberatelyExcluded) > 0 {
		fmt.Println("\nDeliberately NOT in the backup:")
		for _, item := range m.DeliberatelyExcluded {
			fmt.Printf("  %s\n", item)
		}
	}
	if m.MkcertCAFingerprint != "" {
		fmt.Printf("\nmkcert CA fingerprint: %s\n", m.MkcertCAFingerprint)
	}
}

func orDash(value string) string {
	if strings.TrimSpace(value) == "" {
		return "—"
	}
	return value
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
