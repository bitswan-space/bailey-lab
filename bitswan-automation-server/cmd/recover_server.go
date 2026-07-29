package cmd

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
	"github.com/bitswan-space/bitswan-workspaces/internal/daemon"
	"github.com/bitswan-space/bitswan-workspaces/internal/daemon/backup"
	"github.com/bitswan-space/bitswan-workspaces/internal/docker"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

// `bitswan recover server` — rebuild a whole automation server from its backup.
//
// The disaster-recovery counterpart to `register`: one command on a machine that
// has nothing but docker, ending with a server serving its own hostnames with
// every workspace back. AOC's "Disaster recovery" action prints exactly this
// command, and recover.sh execs it.
//
// The order below is not stylistic. A destroy-and-recover drill established it,
// and two of the steps exist only because that drill found them missing:
//
//   - Server state must be restored BEFORE the daemon starts. The daemon renders
//     Traefik's dynamic config from rest-state.json at boot, so a daemon that
//     boots first writes an EMPTY route table over the routes being restored.
//   - Nothing on the daemon's boot path ever CREATES the protected proxy, so a
//     recovered server serves every protected hostname as a 502 until it is
//     provisioned explicitly.
//   - The AOC-dependent steps have to wait for our own ingress, or they fire
//     against a Traefik that is still starting and quietly do nothing.
//
// Phases: preflight (nothing changes) → restore state → deploy the daemon →
// credentials + ingress → workspaces → verify.

const (
	recoverServerIngressWait = 3 * time.Minute
	recoverServerVerifyWait  = 8 * time.Minute
	recoverServerRestoreWait = 30 * time.Minute
)

type recoverServerOpts struct {
	aocAPI    string
	serverID  string
	otp       string
	keyFile   string
	snapshot  string
	network   string
	image     string
	only      []string
	skipWS    bool
	skipBuild bool
	dryRun    bool
	yes       bool
}

func newRecoverCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "recover",
		Short: "Disaster recovery: rebuild a lost automation server",
	}
	cmd.AddCommand(newRecoverServerCmd())
	return cmd
}

func newRecoverServerCmd() *cobra.Command {
	var o recoverServerOpts

	cmd := &cobra.Command{
		Use:   "server",
		Short: "Rebuild this machine into a lost automation server, from its backup",
		Long: "Rebuild a whole automation server onto replacement hardware: restore its own " +
			"state (identity, route table, TLS material, Bailey database), deploy the daemon, " +
			"bring the ingress and protected proxy back up, then recover every workspace with " +
			"its files, secrets, databases and object storage.\n\n" +
			"Docker is the only prerequisite. Take the command from the \"Disaster recovery\" " +
			"action on the server's AOC card: the one-time password it carries exchanges for a " +
			"token on the ORIGINAL server record, which is what makes the recovery read the " +
			"right backup repository.\n\n" +
			"You must supply the backup encryption key. It is never escrowed — not in the AOC, " +
			"not in object storage — so your own copy is the only one that exists. Without it " +
			"the backup cannot be read and no recovery is possible.\n\n" +
			"Business-process images are rebuilt from source, because they only ever existed in " +
			"the lost machine's local image store. That reproduces the exact image a deployment " +
			"pins as long as its source is unchanged; where the source has moved on since a " +
			"promotion, the run reports which deployments need a re-promote.",
		Args:         cobra.NoArgs,
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRecoverServer(cmd.Context(), o)
		},
	}

	f := cmd.Flags()
	f.StringVar(&o.aocAPI, "aoc-api", "", "AOC base URL (required)")
	f.StringVar(&o.serverID, "server-id", "", "the automation server's id (required)")
	f.StringVar(&o.otp, "otp", "", "the recovery one-time password from the AOC card")
	f.StringVar(&o.keyFile, "key-file", "", "file holding the backup encryption key (prompted for if omitted)")
	f.StringVar(&o.snapshot, "snapshot", "", "server-state snapshot to restore (default: the newest)")
	f.StringVar(&o.network, "docker-network", "", "docker network to reach the AOC on, when it is not publicly resolvable")
	f.StringVar(&o.image, "runtime-image", "", "image providing restic (default: the one recorded in the backup)")
	f.StringSliceVar(&o.only, "workspace", nil, "only recover this workspace (repeatable)")
	f.BoolVar(&o.skipWS, "skip-workspaces", false, "restore the server and its ingress, then stop")
	f.BoolVar(&o.skipBuild, "skip-image-rebuild", false,
		"do not rebuild business-process images (their containers will not start until you do)")
	f.BoolVar(&o.dryRun, "dry-run", false, "show what would be recovered and exit")
	f.BoolVar(&o.yes, "yes", false, "skip the confirmation prompt")
	return cmd
}

// Seams: the external effects go through vars so the guards and the resume
// decision — the logic most likely to be wrong in a way that only shows up during
// a real disaster — can be tested without docker, an AOC or a daemon.
var (
	recoverServerDockerAvailable = docker.IsDockerAvailable
	recoverServerVolumeExists    = backup.ConfigVolumeExists
	recoverServerReadServerID    = backup.ReadRestoredServerID
	recoverServerReadToken       = backup.ReadRestoredAccessToken
	recoverServerReadManifest    = readManifestWithoutDaemon

	// recoverServerExchangeOTP burns the one-time password for a fresh token.
	recoverServerExchangeOTP = func(aocAPI, otp, serverID string) (token, expires string, err error) {
		client, err := aoc.NewAOCClientWithOTP(aocAPI, otp, serverID)
		if err != nil {
			return "", "", err
		}
		return client.GetAccessToken(), client.GetExpiresAt(), nil
	}

	// recoverServerTokenWorks asks the AOC whether a stored token still
	// authenticates — the resume check, which must not spend an OTP.
	recoverServerTokenWorks = func(aocAPI, serverID, token string) bool {
		client, err := aoc.NewAOCClientWithToken(aocAPI, serverID, token)
		if err != nil {
			return false
		}
		_, err = client.GetAutomationServerInfo()
		return err == nil
	}

	// recoverServerRecoverOneWorkspace drives one workspace's recovery through
	// the daemon.
	recoverServerRecoverOneWorkspace = func(client *daemon.Client, req daemon.RecoverRequest) error {
		return client.BackupRecoverWorkspace(req)
	}
)

// recoverServerState is what the phases hand each other.
type recoverServerState struct {
	opts     recoverServerOpts
	key      string
	token    string
	expires  string
	manifest backup.ServerManifest
	client   *daemon.Client
	report   *daemon.RecoverReport
	// resumed means a working token was already in place, so no OTP was spent.
	resumed bool
	// todo collects "you must still do this" items for the closing summary —
	// things no command can do for the operator.
	todo []string
}

func runRecoverServer(ctx context.Context, o recoverServerOpts) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if o.aocAPI == "" || o.serverID == "" {
		return fmt.Errorf("--aoc-api and --server-id are required (take the command from the " +
			"\"Disaster recovery\" action on the server's AOC card)")
	}

	st := &recoverServerState{
		opts: o,
		report: &daemon.RecoverReport{
			Workspace: "(server) " + o.serverID,
			StartedAt: time.Now().UTC(),
			DryRun:    o.dryRun,
		},
	}
	step := newStepPrinter(st.report)

	if err := recoverServerPreflight(ctx, st, step); err != nil {
		return err
	}
	if o.dryRun {
		fmt.Println("\nDry run: nothing was changed.")
		return nil
	}

	if err := recoverServerRestoreState(ctx, st, step); err != nil {
		return err
	}
	if err := recoverServerDeployDaemon(ctx, st, step); err != nil {
		return err
	}

	// From here the daemon exists, so hold the recovery marker: it keeps the AOC
	// workspace-list sync from reporting a half-restored server (the AOC deletes
	// what it isn't told about, Keycloak clients included) and suppresses the
	// catch-up backup that would otherwise snapshot this half-built state.
	if err := st.client.SetServerRecovery(true); err != nil {
		fmt.Printf("Warning: could not mark a server recovery in progress: %v\n", err)
	} else {
		defer func() {
			if err := st.client.SetServerRecovery(false); err != nil {
				fmt.Printf("Warning: could not clear the server-recovery marker: %v\n", err)
			}
		}()
	}

	if err := recoverServerBringUpIngress(ctx, st, step); err != nil {
		return err
	}
	if err := recoverServerWorkspaces(ctx, st, step); err != nil {
		return err
	}
	recoverServerVerify(ctx, st, step)

	st.report.OK = true
	finishServerReport(st.report)
	printRecoverServerSummary(st)
	return nil
}

// --- phase 0: preflight ------------------------------------------------------

func recoverServerPreflight(ctx context.Context, st *recoverServerState, step stepFunc) error {
	o := st.opts

	if !step("docker", func() (string, error) {
		if !recoverServerDockerAvailable() {
			return "", fmt.Errorf("docker is not available; install it and re-run")
		}
		return "available", nil
	}) {
		return failedPhase(st.report, "docker is required")
	}

	// Guard against rebuilding the wrong machine. A volume already holding a
	// DIFFERENT server's identity means this host is somebody else's server, and
	// the restore would overwrite it.
	if !step("target", func() (string, error) {
		if !recoverServerVolumeExists(ctx) {
			return "a fresh machine", nil
		}
		existing, err := recoverServerReadServerID(ctx, o.image)
		if err != nil {
			return "", err
		}
		switch existing {
		case "":
			return "an empty config volume", nil
		case o.serverID:
			return "state for this server is already present (resuming)", nil
		default:
			return "", fmt.Errorf("this machine already holds automation server %s, "+
				"but you asked to recover %s. Refusing: recovering here would overwrite "+
				"a different server", existing, o.serverID)
		}
	}) {
		return failedPhase(st.report, "refusing to recover onto this machine")
	}

	// Credentials. A stored token that still works means a previous run got this
	// far, so resume rather than demanding another OTP — they are single-use and
	// expire in ten minutes, and needing a new one mid-incident is a bad trade.
	if !step("credentials", func() (string, error) {
		if token := existingWorkingToken(ctx, o); token != "" {
			st.token, st.resumed = token, true
			return "the stored token still authenticates — resuming without an OTP", nil
		}
		if o.otp == "" {
			return "", fmt.Errorf("--otp is required (no usable token is stored on this " +
				"machine). Take a fresh one from the \"Disaster recovery\" action on the AOC card")
		}
		if err := confirmRecovery(o); err != nil {
			return "", err
		}
		token, expires, err := recoverServerExchangeOTP(o.aocAPI, o.otp, o.serverID)
		if err != nil {
			return "", fmt.Errorf("could not exchange the recovery OTP: %w", err)
		}
		st.token, st.expires = token, expires
		if st.token == "" {
			return "", fmt.Errorf("the AOC returned no access token for this server")
		}
		return "recovery OTP exchanged for an access token", nil
	}) {
		return failedPhase(st.report, "could not authenticate to the AOC")
	}

	if !step("key", func() (string, error) {
		key, source, err := readRecoveryKey(o.keyFile)
		if err != nil {
			return "", err
		}
		st.key = key
		return source, nil
	}) {
		return failedPhase(st.report, "the backup encryption key is required")
	}

	// One call proves the key, the repo and the server all line up — and yields
	// everything else the recovery needs to know about the server it is rebuilding.
	if !step("manifest", func() (string, error) {
		manifest, warning, err := recoverServerReadManifest(
			ctx, o.aocAPI, o.serverID, st.token, st.key, o.snapshot, o.image, o.network)
		if err != nil {
			return "", err
		}
		st.manifest = manifest
		if warning != "" {
			st.report.Warnings = append(st.report.Warnings, warning)
			fmt.Printf("Warning: %s\n", warning)
		}
		return fmt.Sprintf("%s, captured %s, %d workspace(s)",
			orDash(manifest.Domain), manifest.CapturedAt.Local().Format(time.RFC1123),
			len(manifest.Workspaces)), nil
	}) {
		return failedPhase(st.report, "could not read the backup")
	}

	printRecoveryPlan(st)
	return nil
}

// existingWorkingToken returns a stored access token that still authenticates for
// this server, or "" — the resume signal.
func existingWorkingToken(ctx context.Context, o recoverServerOpts) string {
	if !recoverServerVolumeExists(ctx) {
		return ""
	}
	token, err := recoverServerReadToken(ctx, o.image)
	if err != nil || token == "" {
		return ""
	}
	if id, err := recoverServerReadServerID(ctx, o.image); err != nil || id != o.serverID {
		return ""
	}
	// Cheap liveness check: the AOC accepts it or it is worthless to us.
	if !recoverServerTokenWorks(o.aocAPI, o.serverID, token) {
		return ""
	}
	return token
}

// readRecoveryKey loads the encryption key from a file, or prompts for it.
//
// A --key-file that was given but cannot be read is an error rather than a
// fallback to prompting: in an unattended run that would silently hang, and a
// typo'd path deserves to be reported as one.
func readRecoveryKey(keyFile string) (key, source string, err error) {
	if keyFile != "" {
		k, err := readKeyFile(keyFile)
		if err != nil {
			return "", "", err
		}
		return k, "read from " + keyFile, nil
	}

	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return "", "", fmt.Errorf("no backup encryption key supplied and no terminal to " +
			"prompt on — pass --key-file <path>")
	}

	fmt.Println("\nThe backup is encrypted with a key that exists only in your own copy of it —")
	fmt.Println("it is never stored in the AOC or in object storage.")
	fmt.Print("Paste the backup encryption key: ")
	raw, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	if err != nil {
		return "", "", fmt.Errorf("could not read the key: %w", err)
	}
	k := strings.TrimSpace(string(raw))
	if k == "" {
		return "", "", fmt.Errorf("no key entered")
	}
	return k, "entered at the prompt", nil
}

func confirmRecovery(o recoverServerOpts) error {
	if o.yes {
		return nil
	}
	fmt.Printf("\nThis rebuilds this machine into automation server %s.\n", o.serverID)
	fmt.Println("Redeeming the recovery one-time password REPLACES that server's AOC access token,")
	fmt.Println("so if the original server is still running it loses its AOC access — including its")
	fmt.Println("own backups — until it registers again.")
	fmt.Print("Type 'recover' to continue: ")

	answer, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	if strings.TrimSpace(answer) != "recover" {
		return fmt.Errorf("aborted")
	}
	return nil
}

func printRecoveryPlan(st *recoverServerState) {
	m := st.manifest
	fmt.Printf("\nRecovering automation server %s\n", orDash(m.ServerID))
	fmt.Printf("  domain:        %s\n", orDash(m.Domain))
	fmt.Printf("  backup from:   %s (made by bitswan %s)\n",
		m.CapturedAt.Local().Format(time.RFC1123), orDash(m.BitswanVersion))
	names := recoverServerWorkspaceNames(st)
	if st.opts.skipWS {
		fmt.Printf("  workspaces:    skipped (--skip-workspaces)\n")
	} else if len(names) == 0 {
		fmt.Printf("  workspaces:    none recorded\n")
	} else {
		fmt.Printf("  workspaces:    %s\n", strings.Join(names, ", "))
	}
	if len(m.ImagePins) > 0 {
		fmt.Printf("  image pins:    %d to re-apply\n", len(m.ImagePins))
	}
	fmt.Println()
}

// recoverServerWorkspaceNames is the manifest's workspace list, narrowed by
// --workspace when given.
func recoverServerWorkspaceNames(st *recoverServerState) []string {
	wanted := map[string]bool{}
	for _, name := range st.opts.only {
		wanted[name] = true
	}
	var names []string
	for _, ws := range st.manifest.Workspaces {
		if len(wanted) == 0 || wanted[ws.Name] {
			names = append(names, ws.Name)
		}
	}
	sort.Strings(names)
	return names
}
