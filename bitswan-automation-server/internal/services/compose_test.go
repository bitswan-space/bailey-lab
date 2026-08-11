package services

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// The real message a losing `compose up` prints (issue #349) — compose echoes
// the daemon error twice, hence the dedupe.
const conflictOutput = `Container foo-coding-agent  Creating
Error response from daemon: Conflict. The container name "/foo-coding-agent" is already in use by container "b807fe29d96d0a6486d98e874d2b68f0ea658c25382e4d223c5e5b924f8699ee". You have to remove (or rename) that container to be able to reuse that name.
Error response from daemon: Conflict. The container name "/foo-coding-agent" is already in use by container "b807fe29d96d0a6486d98e874d2b68f0ea658c25382e4d223c5e5b924f8699ee". You have to remove (or rename) that container to be able to reuse that name.`

func TestConflictingContainerNames(t *testing.T) {
	got := conflictingContainerNames(conflictOutput)
	if len(got) != 1 || got[0] != "foo-coding-agent" {
		t.Errorf("conflictingContainerNames = %v, want [foo-coding-agent]", got)
	}
	if got := conflictingContainerNames("Container foo-coding-agent  Started"); len(got) != 0 {
		t.Errorf("no conflict in output, got %v", got)
	}
}

// fakeDocker installs a runDocker stub for the duration of the test. inspect
// answers come from inspect(name); the compose up answer from up().
func fakeDocker(t *testing.T, up func() ([]byte, error), inspect func(name string) ([]byte, error)) {
	t.Helper()
	old := runDocker
	runDocker = func(dir string, args ...string) ([]byte, error) {
		if len(args) > 0 && args[0] == "inspect" {
			return inspect(args[len(args)-1])
		}
		return up()
	}
	t.Cleanup(func() { runDocker = old })
}

// A name conflict caused by a concurrent bring-up of the SAME project is not a
// failure: the container the other run created is up, which is all the caller
// wanted (issue #349 — the workspace was created fine but init reported an
// error).
func TestComposeUpSidecar_ToleratesConcurrentBringUpOfSameProject(t *testing.T) {
	fakeDocker(t,
		func() ([]byte, error) { return []byte(conflictOutput), fmt.Errorf("exit status 1") },
		func(name string) ([]byte, error) { return []byte("true foo-coding-agent\n"), nil },
	)
	if err := composeUpSidecar(t.TempDir(), "docker-compose-coding-agent.yml", "foo-coding-agent"); err != nil {
		t.Errorf("composeUpSidecar = %v, want nil (the container is up)", err)
	}
}

// A name held by a container that is NOT this project's is a real collision and
// must still fail loudly — never silently report success for someone else's
// container.
func TestComposeUpSidecar_ForeignContainerStillFails(t *testing.T) {
	fakeDocker(t,
		func() ([]byte, error) { return []byte(conflictOutput), fmt.Errorf("exit status 1") },
		func(name string) ([]byte, error) { return []byte("true some-other-project\n"), nil },
	)
	err := composeUpSidecar(t.TempDir(), "docker-compose-coding-agent.yml", "foo-coding-agent")
	if err == nil {
		t.Fatal("composeUpSidecar = nil, want an error for a name held by another project")
	}
	if !strings.Contains(err.Error(), "already in use") {
		t.Errorf("error should carry docker's output, got: %v", err)
	}
}

// A conflicting container that never comes up (a stale leftover) fails after the
// bounded wait rather than being reported as a successful start.
func TestComposeUpSidecar_StaleContainerFailsAfterWait(t *testing.T) {
	old, oldPoll := conflictWaitTimeout, conflictPollInterval
	conflictWaitTimeout, conflictPollInterval = 20*time.Millisecond, 5*time.Millisecond
	t.Cleanup(func() { conflictWaitTimeout, conflictPollInterval = old, oldPoll })

	fakeDocker(t,
		func() ([]byte, error) { return []byte(conflictOutput), fmt.Errorf("exit status 1") },
		func(name string) ([]byte, error) { return []byte("false foo-coding-agent\n"), nil },
	)
	if err := composeUpSidecar(t.TempDir(), "docker-compose-coding-agent.yml", "foo-coding-agent"); err == nil {
		t.Error("composeUpSidecar = nil, want an error for a container that never runs")
	}
}

// A container created-but-still-starting is waited out, not failed.
func TestComposeUpSidecar_WaitsForContainerBeingStarted(t *testing.T) {
	old, oldPoll := conflictWaitTimeout, conflictPollInterval
	conflictWaitTimeout, conflictPollInterval = time.Second, time.Millisecond
	t.Cleanup(func() { conflictWaitTimeout, conflictPollInterval = old, oldPoll })

	var mu sync.Mutex
	inspects := 0
	fakeDocker(t,
		func() ([]byte, error) { return []byte(conflictOutput), fmt.Errorf("exit status 1") },
		func(name string) ([]byte, error) {
			mu.Lock()
			defer mu.Unlock()
			inspects++
			if inspects < 3 {
				return []byte("false foo-coding-agent\n"), nil
			}
			return []byte("true foo-coding-agent\n"), nil
		},
	)
	if err := composeUpSidecar(t.TempDir(), "docker-compose-coding-agent.yml", "foo-coding-agent"); err != nil {
		t.Errorf("composeUpSidecar = %v, want nil once the container finishes starting", err)
	}
}

// Guard 1: two bring-ups of the same project never run `compose up`
// concurrently — that overlap is what produces the conflict in the first place.
// Different projects are free to run in parallel.
func TestComposeUpSidecar_SerializesPerProject(t *testing.T) {
	var mu sync.Mutex
	inFlight, maxSameProject, maxOverall := map[string]int{}, 0, 0

	old := runDocker
	runDocker = func(dir string, args ...string) ([]byte, error) {
		project := args[4] // compose -f <file> -p <project> up -d
		mu.Lock()
		inFlight[project]++
		if inFlight[project] > maxSameProject {
			maxSameProject = inFlight[project]
		}
		total := 0
		for _, n := range inFlight {
			total += n
		}
		if total > maxOverall {
			maxOverall = total
		}
		mu.Unlock()

		time.Sleep(20 * time.Millisecond) // stand in for the image pull

		mu.Lock()
		inFlight[project]--
		mu.Unlock()
		return []byte("Started"), nil
	}
	t.Cleanup(func() { runDocker = old })

	var wg sync.WaitGroup
	for _, project := range []string{"foo-coding-agent", "foo-coding-agent", "foo-coding-agent", "bar-coding-agent"} {
		wg.Add(1)
		go func(p string) {
			defer wg.Done()
			if err := composeUpSidecar(t.TempDir(), "docker-compose-coding-agent.yml", p); err != nil {
				t.Errorf("composeUpSidecar(%s) = %v", p, err)
			}
		}(project)
	}
	wg.Wait()

	if maxSameProject != 1 {
		t.Errorf("max concurrent `compose up` for one project = %d, want 1", maxSameProject)
	}
	if maxOverall < 2 {
		t.Errorf("different projects should still run in parallel (max overall = %d)", maxOverall)
	}
}
