package automationserverdaemon

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/spf13/cobra"
)

// DaemonRuntimeImage is the image the daemon container runs.
//
// Declared here, next to the code that creates and recreates that container,
// because this is the only place the name is authoritative. The backup package
// carries its own copy for the daemon-LESS path, where a recovery on a bare
// machine takes the image from the manifest instead — a different question with
// the same default answer.
const DaemonRuntimeImage = "bitswan/automation-server-runtime:latest"

func newUpdateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "update",
		Short: "Update and restart the automation server daemon container with the current binary",
		RunE:  runUpdateCmd,
	}
}

func runUpdateCmd(cmd *cobra.Command, args []string) error {
	return Recreate()
}

// Recreate pulls the runtime image, then stops and removes the daemon container
// (if present) and starts a fresh one bound to the CURRENT host binary.
//
// Every path that updates the daemon comes through here — the `update`
// subcommand, `bitswan self-update` in both directions, and the daemon's own
// automatic version check — so the pull happens once, for all of them.
//
// The pull is why this exists rather than a bare restart. The daemon runs
// `bitswan/automation-server-runtime:latest`, and `docker run` does NOT re-pull a
// tag that is already in the local store. So a server that updated only its
// binary kept an image from whenever it was first installed, and anything the
// image supplies rather than the binary silently stayed behind: the symptom that
// found this was a backup failing with `exec: "restic": executable file not
// found in $PATH`, months after restic was added to the Dockerfile.
func Recreate() error {
	pullRuntimeImage()

	// Check if container exists
	checkCmd := exec.Command("docker", "ps", "-a", "--filter", "name=bitswan-automation-server-daemon", "--format", "{{.Names}}")
	output, err := checkCmd.Output()
	if err == nil && len(output) > 0 {
		// Container exists, stop and remove it
		fmt.Println("Stopping existing daemon container...")
		stopCmd := exec.Command("docker", "stop", "bitswan-automation-server-daemon")
		if err := stopCmd.Run(); err != nil {
			return fmt.Errorf("failed to stop existing container: %w", err)
		}

		fmt.Println("Removing existing daemon container...")
		removeCmd := exec.Command("docker", "rm", "bitswan-automation-server-daemon")
		if err := removeCmd.Run(); err != nil {
			return fmt.Errorf("failed to remove existing container: %w", err)
		}
	} else {
		fmt.Println("No existing daemon container found")
	}

	return startDaemonContainer("Starting updated automation server daemon container...", "Automation server daemon updated and started successfully")
}

// SkipRuntimeImagePullEnv opts out of the pull, for the case where the image
// already on the host IS the point rather than a stale copy of the published one.
//
// e2e/bringup.sh builds bitswan/automation-server-runtime:latest from the
// checkout's own Dockerfile — so the daemon can start on a hub-less VM, and so the
// run exercises this branch's image. Pulling there would replace it with whatever
// is on Hub and silently revert the Dockerfile under test, turning a green e2e
// into proof of nothing. Same for anyone iterating on the Dockerfile locally.
const SkipRuntimeImagePullEnv = "BITSWAN_SKIP_RUNTIME_IMAGE_PULL"

// pullRuntimeImage fetches the newest runtime image before the container is
// recreated.
//
// Best-effort, and deliberately BEFORE anything is stopped: a transient network
// failure must not be able to leave a server with its daemon torn down and no
// image to start a new one from. If the pull fails we say so loudly and carry on
// with whatever is cached — a slightly stale daemon that is running beats a
// current one that is not.
func pullRuntimeImage() {
	if os.Getenv(SkipRuntimeImagePullEnv) != "" {
		fmt.Printf("Not pulling %s: %s is set, so the image already on this host is "+
			"taken to be the one under test.\n", DaemonRuntimeImage, SkipRuntimeImagePullEnv)
		return
	}

	fmt.Printf("Pulling %s...\n", DaemonRuntimeImage)
	pull := exec.Command("docker", "pull", DaemonRuntimeImage)
	pull.Stdout = os.Stdout
	pull.Stderr = os.Stderr
	if err := pull.Run(); err != nil {
		fmt.Printf("Warning: could not pull %s (%v) — recreating with the image already "+
			"on this host. If the daemon then misbehaves in a way the binary cannot "+
			"explain, an out-of-date runtime image is the first thing to suspect.\n",
			DaemonRuntimeImage, err)
	}
}
