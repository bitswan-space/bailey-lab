package backup

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeArtifact stands in for a dump that produced a file.
func writeArtifact(t *testing.T, stagingDir string) string {
	t.Helper()
	if err := os.MkdirAll(stagingDir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(stagingDir, "dump.sql")
	if err := os.WriteFile(path, []byte("-- dump\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// A configured service whose container is down is the case this third state
// exists for. Its data is not in the backup, but the run has not failed — and
// collapsing that into either green or red loses the only fact an operator
// needs: that this backup has a hole in it.

func TestADownContainerOnAConfiguredStageWarnsRatherThanPassing(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	writeServerConfig(t, "https://aoc.example.com")
	fakeRestic(t, 0, "")
	writeWorkspace(t, "ws1", true) // postgres secrets exist => the stage IS configured

	target, _ := LoadAOCTarget()
	var engine Engine

	// The dump reports "no artifact" the way a stopped container does.
	result := engine.backupServiceStages(context.Background(), NewRestic(target, "k"), "ws1", "postgres",
		func(stage, stagingDir string) (string, error) { return "", nil })

	if !result.Success {
		t.Error("a stopped container must not fail the run — a deliberately stopped " +
			"workspace would then be red every night")
	}
	if !result.Warning {
		t.Fatal("...but it must not report clean either: this stage's data is missing")
	}
	if !strings.Contains(result.Output, "NOT in this backup") {
		t.Errorf("the output should say what was lost, got %q", result.Output)
	}
}

func TestAServiceEnabledNowhereIsNotAWarning(t *testing.T) {
	// Nothing was asked for and nothing is missing — that is a clean pass, not a
	// caveat. Warning on it would train operators to ignore the state.
	t.Setenv("HOME", t.TempDir())
	writeServerConfig(t, "https://aoc.example.com")
	fakeRestic(t, 0, "")
	writeWorkspace(t, "ws1", false) // no postgres secrets on any stage

	target, _ := LoadAOCTarget()
	var engine Engine
	result := engine.backupServiceStages(context.Background(), NewRestic(target, "k"), "ws1", "postgres",
		func(stage, stagingDir string) (string, error) { return "", nil })

	if !result.Success || result.Warning {
		t.Errorf("result = %+v, want a clean pass for a service enabled nowhere", result)
	}
}

func TestOneCaveatedStageCaveatsTheWholeService(t *testing.T) {
	// The aggregate is what the console renders. Production having a hole is not
	// cancelled out by dev going fine.
	t.Setenv("HOME", t.TempDir())
	writeServerConfig(t, "https://aoc.example.com")
	fakeRestic(t, 0, "")
	writeWorkspace(t, "ws1", true) // configures production
	// ...and a second configured stage, so there is something to aggregate.
	if err := os.WriteFile(
		filepath.Join(workspaceDir("ws1"), "secrets", "postgres-staging"),
		[]byte("POSTGRES_USER=admin\nPOSTGRES_PASSWORD=pw\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	target, _ := LoadAOCTarget()
	var engine Engine
	seen := 0
	result := engine.backupServiceStages(context.Background(), NewRestic(target, "k"), "ws1", "postgres",
		func(stage, stagingDir string) (string, error) {
			seen++
			if seen == 1 {
				return "", nil // one stage down
			}
			return writeArtifact(t, stagingDir), nil // the rest fine
		})

	if seen < 2 {
		t.Fatalf("expected two configured stages to aggregate, saw %d", seen)
	}
	if !result.Success {
		t.Error("the healthy stages still succeeded")
	}
	if !result.Warning {
		t.Error("one stage's hole must survive aggregation")
	}
}
