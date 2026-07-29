package backup

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// Rebuilding the server's own state on a machine where nothing exists yet.
//
// Everything here runs BEFORE any daemon: no config file to read, no restic on
// the host, and the target is a docker volume rather than a path this process
// can see. So each operation is a throwaway container with the `bitswan` volume
// mounted at the path the snapshot recorded — the same shape
// `seedMkcertVolumeFromHost` uses to seed the mkcert CA.
//
// The ordering constraint this exists to serve: all of it must finish before the
// daemon starts. A daemon booting on an empty volume re-renders dynamic.yml from
// a missing rest-state.json and writes an EMPTY route table over the routes
// being restored (internal/traefikapi/traefikapi.go).

// serverStateTag is the snapshot series holding the server's own state.
const serverStateTag = "server-config"

// configVolumePath is where the `bitswan` volume is mounted inside the helper
// containers — $HOME/.config/bitswan for the runtime image's root user, which
// is the prefix every path in the snapshot carries.
const configVolumePath = "/root/.config/bitswan"

// RestoreServerState reconstructs the server's own state into the `bitswan`
// volume from the newest (or given) server-config snapshot.
//
// `--target /` works because the capture records REAL absolute paths: with the
// volume mounted where those paths point, restic writes straight into it. The
// restic here must come from a ContainerExec with WithConfigVolume() set.
func RestoreServerState(ctx context.Context, restic *Restic, snapshotID string) (string, error) {
	if restic.Container == nil {
		return "", fmt.Errorf("server-state restore needs a containerised restic " +
			"(the machine being rebuilt has no restic binary)")
	}

	args := []string{"restore", "--target", "/"}
	args = append(args, seriesArgs(snapshotID, []string{serverStateTag})...)
	args = append(args, resolveSnapshot(snapshotID))

	stdout, stderr, err := restic.Run(ctx, args...)
	if err != nil {
		return "", err
	}
	summary := strings.TrimSpace(stdout)
	if summary == "" {
		summary = strings.TrimSpace(stderr)
	}
	// restic's last line is the "Summary: Restored N files/dirs" line.
	if lines := strings.Split(summary, "\n"); len(lines) > 0 {
		summary = strings.TrimSpace(lines[len(lines)-1])
	}
	return summary, nil
}

// CheckRestoredServerState verifies the restore produced a server we can
// actually boot, and distinguishes the one legacy case that looks like success.
//
// Snapshots taken before the capture moved to real absolute paths hold a nested
// staging tree instead, so `--target /` lays down something structurally
// unusable. Better to say so than to start a daemon on it.
func CheckRestoredServerState(ctx context.Context, image string) error {
	out, err := volumeExec(ctx, image, nil,
		"ls -A "+configVolumePath+" 2>/dev/null || true")
	if err != nil {
		return err
	}
	entries := strings.Fields(out)
	if len(entries) == 0 {
		return fmt.Errorf("the restore left %s empty — nothing was recovered", configVolumePath)
	}

	have := map[string]bool{}
	for _, e := range entries {
		have[e] = true
	}
	if !have["automation_server_config.toml"] {
		if have["staging"] || have["backup"] && !have["traefik"] {
			return fmt.Errorf("this snapshot predates real-path server backups: it holds a " +
				"nested staging tree rather than the server's own paths. Restore it manually " +
				"and un-nest it, or recover from a newer snapshot")
		}
		return fmt.Errorf("the restored state has no automation_server_config.toml "+
			"(found: %s) — this does not look like a server-config snapshot",
			strings.Join(entries, ", "))
	}
	return nil
}

// PromoteBaileyDatabase renames the vacuumed copy to the live database name.
//
// The capture writes bailey.db.snapshot (a VACUUM INTO copy — torn-write safe,
// unlike copying a file the daemon has open) and never the live bailey.db, so a
// restore always lands the copy and this rename is what makes it the database.
func PromoteBaileyDatabase(ctx context.Context, image string) (string, error) {
	snapshot := configVolumePath + "/bailey.db.snapshot"
	live := configVolumePath + "/bailey.db"
	out, err := volumeExec(ctx, image, nil, fmt.Sprintf(
		`if [ -f %[1]s ]; then mv -f %[1]s %[2]s && echo promoted; `+
			`elif [ -f %[2]s ]; then echo "already promoted"; `+
			`else echo missing; fi`, snapshot, live))
	if err != nil {
		return "", err
	}
	switch strings.TrimSpace(out) {
	case "missing":
		return "", fmt.Errorf("neither bailey.db.snapshot nor bailey.db is present in the " +
			"restored state — the server has no users, devices or access grants to come back to")
	case "already promoted":
		return "bailey.db already in place", nil
	default:
		return "bailey.db.snapshot promoted to bailey.db", nil
	}
}

// InstallResticKey writes the operator's key into the volume at 0600.
//
// The key arrives on stdin, never as an argument and never through a host file:
// when the operator pastes it at the prompt it must not land on the disk of a
// machine that, moments ago, was untrusted bare metal. (backup.SaveKey writes
// via $HOME, which on the host is the wrong side of the volume boundary, and
// there is no daemon yet to POST it to.)
func InstallResticKey(ctx context.Context, image, key string) (string, error) {
	dir := configVolumePath + "/backup"
	path := dir + "/restic-key"
	out, err := volumeExec(ctx, image, strings.NewReader(key+"\n"), fmt.Sprintf(
		`mkdir -p %[1]s && chmod 700 %[1]s && `+
			`cat > %[2]s && chmod 600 %[2]s && echo installed`, dir, path))
	if err != nil {
		return "", fmt.Errorf("could not install the backup encryption key: %w", err)
	}
	if !strings.Contains(out, "installed") {
		return "", fmt.Errorf("could not install the backup encryption key: %s", strings.TrimSpace(out))
	}
	return "key installed at backup/restic-key (0600)", nil
}

// ReadRestoredServerID returns the automation_server_id recorded in the restored
// (or pre-existing) config, or "" when there is no config at all.
//
// Used by the wrong-server guard: a volume already holding a DIFFERENT server's
// identity means the operator is about to overwrite the wrong machine.
func ReadRestoredServerID(ctx context.Context, image string) (string, error) {
	out, err := volumeExec(ctx, image, nil,
		`grep -E '^[[:space:]]*automation_server_id' `+
			configVolumePath+`/automation_server_config.toml 2>/dev/null | `+
			`head -1 | cut -d'"' -f2 || true`)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// ReadRestoredAccessToken returns the AOC access token recorded in the restored
// (or pre-existing) config, or "".
//
// Used to resume a half-finished recovery: a token that still authenticates means
// a previous run already exchanged an OTP, and OTPs are single-use.
func ReadRestoredAccessToken(ctx context.Context, image string) (string, error) {
	out, err := volumeExec(ctx, image, nil,
		`grep -E '^[[:space:]]*access_token' `+
			configVolumePath+`/automation_server_config.toml 2>/dev/null | `+
			`head -1 | cut -d'"' -f2 || true`)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// ConfigVolumeExists reports whether the `bitswan` volume is already present.
func ConfigVolumeExists(ctx context.Context) bool {
	cmd := exec.CommandContext(ctx, dockerBinary, "volume", "inspect", BitswanConfigVolume)
	return cmd.Run() == nil
}

// volumeExec runs a shell snippet in a throwaway container with the config
// volume mounted, optionally feeding it stdin. Returns combined stdout.
//
// Deliberately the runtime image rather than something like alpine: recovery
// must not depend on pulling an extra image, and this one is already being
// pulled for restic.
func volumeExec(ctx context.Context, image string, stdin *strings.Reader, script string) (string, error) {
	if image == "" {
		image = DefaultRuntimeImage
	}
	args := []string{"run", "--rm"}
	if stdin != nil {
		args = append(args, "-i")
	}
	args = append(args,
		"-v", BitswanConfigVolume+":"+configVolumePath,
		"--entrypoint", "sh", image, "-c", script)

	cmd := exec.CommandContext(ctx, dockerBinary, args...)
	if stdin != nil {
		cmd.Stdin = stdin
	}
	var out, errBuf bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%w: %s", err, strings.TrimSpace(errBuf.String()))
	}
	return out.String(), nil
}
