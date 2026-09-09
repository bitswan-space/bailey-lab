package infradriver

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestApplyLockPathIsPerWorkspaceAndFilesystemSafe(t *testing.T) {
	got := ApplyLockPath("/git/deploy-repos/.apply-locks", "web/site name")
	want := filepath.Join("/git/deploy-repos/.apply-locks", "web-site-name.lock")
	if got != want {
		t.Fatalf("ApplyLockPath = %q, want %q", got, want)
	}
	if ApplyLockPath("/locks", "a") == ApplyLockPath("/locks", "b") {
		t.Fatal("two workspaces share one lock file; applies in unrelated workspaces would serialise")
	}
}

func TestApplyLockDirForSitsBesideTheDeployRepo(t *testing.T) {
	got := ApplyLockDirFor("/git/deploy-repos/bitswan-ai.deploy.git")
	want := filepath.Join("/git/deploy-repos", ApplyLockDirName)
	if got != want {
		t.Fatalf("ApplyLockDirFor = %q, want %q", got, want)
	}
}

func TestSecondApplyWaitsForTheFirstToRelease(t *testing.T) {
	dir := t.TempDir()
	first, err := LockWorkspaceApply(context.Background(), dir, "website", time.Minute, nil)
	if err != nil {
		t.Fatalf("first apply could not take the lock: %v", err)
	}

	took := make(chan struct{})
	go func() {
		second, err := LockWorkspaceApply(context.Background(), dir, "website", time.Minute, nil)
		if err != nil {
			t.Errorf("second apply never took the lock: %v", err)
			close(took)
			return
		}
		second()
		close(took)
	}()

	select {
	case <-took:
		t.Fatal("second apply took the lock while the first still held it")
	case <-time.After(300 * time.Millisecond):
	}

	first()
	select {
	case <-took:
	case <-time.After(10 * time.Second):
		t.Fatal("second apply did not take the lock after the first released it")
	}
}

func TestApplyLockDoesNotSerialiseDifferentWorkspaces(t *testing.T) {
	dir := t.TempDir()
	held, err := LockWorkspaceApply(context.Background(), dir, "website", time.Minute, nil)
	if err != nil {
		t.Fatalf("could not take the website lock: %v", err)
	}
	defer held()

	other, err := LockWorkspaceApply(context.Background(), dir, "fakturacniproces", 2*time.Second, nil)
	if err != nil {
		t.Fatalf("an apply in another workspace was blocked: %v", err)
	}
	other()
}

func TestApplyLockGivesUpWithAnActionableErrorAndReportsWaiting(t *testing.T) {
	dir := t.TempDir()
	held, err := LockWorkspaceApply(context.Background(), dir, "website", time.Minute, nil)
	if err != nil {
		t.Fatalf("could not take the lock: %v", err)
	}
	defer held()

	waits := 0
	_, err = LockWorkspaceApply(context.Background(), dir, "website", 50*time.Millisecond, func(time.Duration) { waits++ })
	if err == nil {
		t.Fatal("a blocked apply reported success instead of timing out")
	}
	for _, want := range []string{"website", "concurrently"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("timeout error %q does not mention %q", err, want)
		}
	}
	if waits == 0 {
		t.Fatal("a waiting apply reported no progress, so its deploy log would go dark")
	}
}

func TestApplyLockHonoursCancellation(t *testing.T) {
	dir := t.TempDir()
	held, err := LockWorkspaceApply(context.Background(), dir, "website", time.Minute, nil)
	if err != nil {
		t.Fatalf("could not take the lock: %v", err)
	}
	defer held()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := LockWorkspaceApply(ctx, dir, "website", time.Minute, nil); err != context.Canceled {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestApplyLockTimeoutFallsBackToTheDefault(t *testing.T) {
	t.Setenv("BITSWAN_APPLY_LOCK_TIMEOUT", "")
	if got := ApplyLockTimeout(); got != DefaultApplyLockTimeout {
		t.Fatalf("ApplyLockTimeout = %s, want %s", got, DefaultApplyLockTimeout)
	}
	t.Setenv("BITSWAN_APPLY_LOCK_TIMEOUT", "90s")
	if got := ApplyLockTimeout(); got != 90*time.Second {
		t.Fatalf("ApplyLockTimeout = %s, want 90s", got)
	}
	t.Setenv("BITSWAN_APPLY_LOCK_TIMEOUT", "not-a-duration")
	if got := ApplyLockTimeout(); got != DefaultApplyLockTimeout {
		t.Fatalf("ApplyLockTimeout = %s, want the default for an unparseable value", got)
	}
}
