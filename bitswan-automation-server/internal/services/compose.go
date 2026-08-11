package services

import (
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Sidecar bring-up races, and how they are contained.
//
// A workspace's daemon-owned sidecars (coding-agent, dashboard) are started from
// more than one place: workspace init starts each one right after enabling it,
// while the daemon's service reconciler independently starts anything that is
// enabled but not running (internal/daemon/service_reconcile.go, every 60s).
// Both run `docker compose up -d` on the same project, and compose decides what
// to create BEFORE it pulls — so on a cold image cache (minutes of pulling) the
// slower run reaches "Creating" long after the other one created the container
// and dies on:
//
//	Error response from daemon: Conflict. The container name
//	"/foo-coding-agent" is already in use by container "b807fe29…"
//
// The workspace is fine — it is up and the agent works — but creation reports a
// hard failure (issue #349). Two guards, in order:
//
//  1. Serialize per compose project inside this process, where both callers
//     live. The second run then simply finds the container present and no-ops.
//  2. Tolerate the conflict when it is one of these races rather than a real
//     collision: every container named in the error must belong to THIS compose
//     project and be running. That covers the cross-process case (the host CLI's
//     `bitswan workspace init` against the daemon's reconciler), which no
//     in-process lock can. A name taken by something else — a leftover from
//     another project, a container that never starts — still fails loudly.

var (
	composeLocksMu sync.Mutex
	composeLocks   = map[string]*sync.Mutex{}
)

// composeProjectLock returns the process-wide lock for a compose project.
func composeProjectLock(project string) *sync.Mutex {
	composeLocksMu.Lock()
	defer composeLocksMu.Unlock()
	mu, ok := composeLocks[project]
	if !ok {
		mu = &sync.Mutex{}
		composeLocks[project] = mu
	}
	return mu
}

// runDocker executes `docker <args...>` in dir. A variable so tests can observe
// and fake the docker calls.
var runDocker = func(dir string, args ...string) ([]byte, error) {
	cmd := exec.Command("docker", args...)
	cmd.Dir = dir
	return cmd.CombinedOutput()
}

// conflictWaitTimeout bounds how long a name conflict waits for the container
// the other bring-up is creating to actually come up. Creation and start are
// separate steps, so the loser of the race can observe the container mid-start.
var conflictWaitTimeout = 30 * time.Second

// conflictPollInterval is how often that wait re-checks.
var conflictPollInterval = time.Second

// containerNameConflictRe extracts the container names docker reports as taken.
var containerNameConflictRe = regexp.MustCompile(`container name "/?([^"]+)" is already in use`)

// composeUpSidecar runs `docker compose -f composeFile -p project up -d
// extraArgs...` in dir, serialized per project and tolerant of the
// container-name conflict a concurrent bring-up of the SAME project produces.
func composeUpSidecar(dir, composeFile, project string, extraArgs ...string) error {
	mu := composeProjectLock(project)
	mu.Lock()
	defer mu.Unlock()

	args := append([]string{"compose", "-f", composeFile, "-p", project, "up", "-d"}, extraArgs...)
	output, err := runDocker(dir, args...)
	if err == nil {
		return nil
	}

	if names := conflictingContainerNames(string(output)); len(names) > 0 {
		if waitProjectContainersRunning(names, project) {
			fmt.Printf("Container(s) %s were already brought up concurrently for project %q — continuing\n",
				strings.Join(names, ", "), project)
			return nil
		}
	}

	return fmt.Errorf("command failed: %w\nOutput: %s", err, string(output))
}

// conflictingContainerNames lists the container names a compose run reported as
// already in use, deduplicated (compose echoes the daemon error twice).
func conflictingContainerNames(output string) []string {
	var names []string
	seen := map[string]bool{}
	for _, m := range containerNameConflictRe.FindAllStringSubmatch(output, -1) {
		if name := m[1]; !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	return names
}

// waitProjectContainersRunning reports whether every named container belongs to
// the given compose project and is running, waiting up to conflictWaitTimeout
// for a container the other bring-up is still starting.
func waitProjectContainersRunning(names []string, project string) bool {
	deadline := time.Now().Add(conflictWaitTimeout)
	for {
		allRunning := true
		for _, name := range names {
			running, sameProject := containerState(name, project)
			if !sameProject {
				// The name is held by something that is not this project's
				// container — a real collision, not our race.
				return false
			}
			if !running {
				allRunning = false
			}
		}
		if allRunning {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(conflictPollInterval)
	}
}

// containerState reports whether the container is running and whether it is
// part of the given compose project. A container that can't be inspected (it
// disappeared between the conflict and this check) counts as neither.
func containerState(name, project string) (running, sameProject bool) {
	output, err := runDocker("", "inspect", "-f",
		`{{.State.Running}} {{index .Config.Labels "com.docker.compose.project"}}`, name)
	if err != nil {
		return false, false
	}
	fields := strings.Fields(string(output))
	if len(fields) != 2 {
		return false, false
	}
	return fields[0] == "true", fields[1] == project
}
