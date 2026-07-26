package daemon

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// fakeSidecar is a test double for a daemon-owned service.
type fakeSidecar struct {
	enabled  bool
	running  bool
	startErr error
	starts   int
}

func (f *fakeSidecar) IsEnabled() bool          { return f.enabled }
func (f *fakeSidecar) IsContainerRunning() bool { return f.running }
func (f *fakeSidecar) StartContainer() error    { f.starts++; return f.startErr }

func TestReconcileSidecar(t *testing.T) {
	cases := []struct {
		name        string
		svc         fakeSidecar
		wantStarted bool
		wantStarts  int
	}{
		{"enabled and stopped -> start", fakeSidecar{enabled: true, running: false}, true, 1},
		{"enabled and running -> skip", fakeSidecar{enabled: true, running: true}, false, 0},
		{"disabled and stopped -> skip", fakeSidecar{enabled: false, running: false}, false, 0},
		{"disabled and running -> skip", fakeSidecar{enabled: false, running: true}, false, 0},
		{"start error is logged, still issued", fakeSidecar{enabled: true, running: false, startErr: errors.New("boom")}, true, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := tc.svc // copy
			got := reconcileSidecar("coding-agent", "ws", &svc)
			if got != tc.wantStarted {
				t.Fatalf("started=%v, want %v", got, tc.wantStarted)
			}
			if svc.starts != tc.wantStarts {
				t.Fatalf("StartContainer called %d times, want %d", svc.starts, tc.wantStarts)
			}
		})
	}
}

func TestListWorkspaceNames(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	// No workspaces dir yet -> empty, no error.
	names, err := listWorkspaceNames()
	if err != nil {
		t.Fatalf("unexpected error on missing dir: %v", err)
	}
	if len(names) != 0 {
		t.Fatalf("expected no workspaces, got %v", names)
	}

	wsDir := filepath.Join(home, ".config", "bitswan", "workspaces")
	for _, ws := range []string{"alpha", "beta"} {
		if err := os.MkdirAll(filepath.Join(wsDir, ws), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// A stray file (not a workspace dir) must be ignored.
	if err := os.WriteFile(filepath.Join(wsDir, "notes.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	names, err = listWorkspaceNames()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	sort.Strings(names)
	if len(names) != 2 || names[0] != "alpha" || names[1] != "beta" {
		t.Fatalf("got %v, want [alpha beta]", names)
	}
}

// TestReconcileEnabledServices exercises the enumerate-and-reconcile loop end to
// end against a temp HOME. The workspace exists but neither service is enabled
// (no docker-compose-*.yml), so it must complete without issuing any Docker
// start — a no-crash walk over a real workspace directory.
func TestReconcileEnabledServices(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	// Empty (no workspaces dir) — must not panic.
	reconcileEnabledServices()

	wsDir := filepath.Join(home, ".config", "bitswan", "workspaces", "horror")
	if err := os.MkdirAll(wsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Both services are "not enabled" (no compose files under deployment/), so
	// reconcileSidecar returns before touching Docker.
	reconcileEnabledServices()
}
