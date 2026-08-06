package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/services"
)

// serviceReconcileInterval is how often — after the initial boot reconcile — the
// daemon re-checks that enabled sidecars are still up. This is a low-frequency
// *resync* (drift correction), not readiness polling: the daemon has no
// container-event stream of its own (those flow infra-driver→gitops), so a
// periodic reconcile is how it notices a sidecar that went away while it kept
// running (e.g. a manual `compose down`, or a crash Docker's restart policy
// couldn't recover). Boot reconcile handles the common restart-interrupted case
// immediately; this catches the rest so a user opening the Coding Agent tab
// finds it running rather than "unavailable".
const serviceReconcileInterval = 60 * time.Second

// sidecarService is the slice of a daemon-owned workspace service the reconciler
// needs. Both CodingAgentService and DashboardService satisfy it.
type sidecarService interface {
	IsEnabled() bool
	IsContainerRunning() bool
	StartContainer() error
}

// startServiceReconciler heals daemon-owned sidecars once at startup and then
// resyncs on an interval. Blocks (run it in its own goroutine).
func startServiceReconciler() {
	reconcileEnabledServices()
	t := time.NewTicker(serviceReconcileInterval)
	defer t.Stop()
	for range t.C {
		reconcileEnabledServices()
	}
}

// reconcileEnabledServices brings each workspace's daemon-owned sidecar services
// (coding-agent, dashboard) back up when they're enabled but their container
// isn't running.
//
// These services are the daemon's responsibility: the dashboard delegates the
// agent lifecycle to us entirely (its ensureAgent is a no-op — "provisioned and
// started by the automation-server"). Docker's `restart: always` only revives a
// container that was successfully created, so a start interrupted *before*
// creation leaves nothing for Docker to restart. That is exactly what happens
// when the server self-update's `docker restart <daemon>` lands in the middle of
// a `compose up` — the old container is already stopped, the new one never
// finishes coming up, and without a boot-time re-check the service silently
// stays down until someone starts it by hand. Reconciling closes that gap.
func reconcileEnabledServices() {
	workspaces, err := listWorkspaceNames()
	if err != nil {
		fmt.Printf("service reconcile: could not list workspaces: %v\n", err)
		return
	}
	for _, ws := range workspaces {
		// A recovery replaces the workspace directory. Starting a sidecar in
		// that window binds it to a stale or missing mount (the drill's
		// "coding-agent SSH asks for a password" symptom), so stand aside.
		if workspaceUnderRecovery(ws) {
			continue
		}
		if svc, err := services.NewCodingAgentService(ws); err == nil {
			reconcileSidecar("coding-agent", ws, svc)
		}
		if svc, err := services.NewDashboardService(ws); err == nil {
			reconcileSidecar("dashboard", ws, svc)
		}
	}
}

// reconcileSidecar starts svc iff it is enabled but its container isn't running.
// Returns true when a start was issued. Docker's state is only queried for an
// enabled service, so an unmanaged one triggers no Docker calls. A start failure
// is logged, not fatal: one broken workspace must not stop the others from
// healing. StartContainer is `compose up -d`, idempotent for anything already up.
func reconcileSidecar(kind, workspace string, svc sidecarService) bool {
	if !svc.IsEnabled() || svc.IsContainerRunning() {
		return false
	}
	fmt.Printf("service reconcile: %s for '%s' is enabled but not running; starting it\n", kind, workspace)
	if err := svc.StartContainer(); err != nil {
		fmt.Printf("service reconcile: failed to start %s for '%s': %v\n", kind, workspace, err)
	}
	return true
}

// listWorkspaceNames returns the names of every provisioned workspace (the
// directories under ~/.config/bitswan/workspaces). Missing dir → no workspaces
// yet, not an error.
func listWorkspaceNames() ([]string, error) {
	dir := filepath.Join(os.Getenv("HOME"), ".config", "bitswan", "workspaces")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	return names, nil
}
