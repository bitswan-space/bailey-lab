package automationserverdaemon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Recreate is the one path every daemon update takes — the `update` subcommand,
// `bitswan self-update` in both directions, and the daemon's own version check.
// It has to pull, because `docker run` will happily reuse a :latest that has been
// in the local store for months: that is how a server updated its binary, kept an
// image from before restic was added to the Dockerfile, and only found out at
// 02:00 when a backup died on `exec: "restic": executable file not found`.

// fakeDocker puts a `docker` on PATH that appends its argv to a log and succeeds.
func fakeDocker(t *testing.T) (logPath string) {
	t.Helper()
	binDir := t.TempDir()
	logPath = filepath.Join(binDir, "argv.log")
	script := "#!/bin/sh\necho \"$@\" >> " + logPath + "\nexit 0\n"
	if err := os.WriteFile(filepath.Join(binDir, "docker"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+":"+os.Getenv("PATH"))
	return logPath
}

func TestRecreatePullsBeforeTouchingTheRunningDaemon(t *testing.T) {
	logPath := fakeDocker(t)

	// startDaemonContainer does a great deal more than we are testing; the pull
	// and the teardown order both happen before it, so an error from it is fine.
	_ = Recreate()

	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("fake docker was never invoked: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")

	var pullAt, stopAt = -1, -1
	for i, l := range lines {
		switch {
		case strings.HasPrefix(l, "pull ") && pullAt == -1:
			pullAt = i
			if !strings.Contains(l, DaemonRuntimeImage) {
				t.Errorf("pulled the wrong image: %q", l)
			}
		case strings.HasPrefix(l, "stop ") && stopAt == -1:
			stopAt = i
		}
	}

	if pullAt == -1 {
		t.Fatalf("Recreate never pulled the runtime image; docker calls were:\n%s", raw)
	}
	// Order is the point, not just presence: pulling after the teardown would mean
	// a network blip could leave a server with no daemon and no image to start one.
	if stopAt != -1 && pullAt > stopAt {
		t.Errorf("pull happened at %d, after stop at %d — a failed pull would strand "+
			"the server with its daemon torn down", pullAt, stopAt)
	}
}

// The name the pull uses has to be the name the container is started with, or the
// pull freshens an image nothing runs. They drifted apart once already: the
// publish script built automation-server-daemon-runtime while every deployment
// ran automation-server-runtime.
func TestTheImagePulledIsTheImageRun(t *testing.T) {
	if DaemonRuntimeImage == "" {
		t.Fatal("DaemonRuntimeImage must name the daemon's image")
	}
	source, err := os.ReadFile("init.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(source), "daemonImage := DaemonRuntimeImage") {
		t.Error("init.go must start the daemon from DaemonRuntimeImage, not its own literal — " +
			"two copies of the name is how the publish script came to build an image " +
			"no deployment used")
	}
}

// The e2e builds this image from the checkout's own Dockerfile so the run
// exercises the branch. Pulling there would replace it with Hub's copy and
// silently revert the Dockerfile under test, so the pull has an opt-out — and the
// opt-out has to actually be honoured.
func TestTheRuntimePullCanBeOptedOut(t *testing.T) {
	logPath := fakeDocker(t)
	t.Setenv(SkipRuntimeImagePullEnv, "1")

	_ = Recreate()

	raw, _ := os.ReadFile(logPath)
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(line, "pull ") {
			t.Fatalf("%s was set but Recreate pulled anyway: %q", SkipRuntimeImagePullEnv, line)
		}
	}
	// Opting out of the pull must not opt out of the recreate itself. Assert on the
	// container check, which is the first thing Recreate does after the pull
	// decision — how far it gets AFTER that depends on the environment
	// (startDaemonContainer needs to create /var/run/bitswan, so it stops earlier
	// as a non-root CI user than it does as root), and this test is not about that.
	if !strings.Contains(string(raw), "ps -a") {
		t.Errorf("Recreate skipped the recreate as well as the pull; docker calls were:\n%s", raw)
	}
}
