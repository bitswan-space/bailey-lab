package images

import (
	"os"
	"strings"
	"testing"
)

func TestTheStagingTrackIsASeparateRepository(t *testing.T) {
	if got := track(GitopsRepository, true); got != "gitops-staging" {
		t.Errorf("staging = %q", got)
	}
	if got := track(GitopsRepository, false); got != "gitops" {
		t.Errorf("stable = %q", got)
	}
}

func TestAnOverrideIsHonouredWithoutAskingAnyRegistry(t *testing.T) {
	t.Setenv("BITSWAN_GITOPS_IMAGE", "example.invalid/mine:v1")
	got, err := ResolveGitopsImage(false, false)
	if err != nil {
		t.Fatalf("an override must not need a registry: %v", err)
	}
	if got != "example.invalid/mine:v1" {
		t.Errorf("got %q", got)
	}
}

func TestADevImageIsNamedDirectly(t *testing.T) {
	os.Unsetenv("BITSWAN_GITOPS_IMAGE")
	got, err := ResolveGitopsImage(false, true)
	if err != nil {
		t.Fatalf("a dev image must not need a registry: %v", err)
	}
	if got != "bitswan/gitops-dev:latest" {
		t.Errorf("got %q", got)
	}
}

func TestWithoutAnAOCThereIsNoImageAndNoFallback(t *testing.T) {
	// The whole point: a server that cannot reach its AOC's registry is told
	// so. It must not quietly pull from somewhere its operator did not choose.
	os.Unsetenv("BITSWAN_GITOPS_IMAGE")
	t.Setenv("HOME", t.TempDir())
	clientLock.Lock()
	cachedClient = nil
	clientLock.Unlock()

	got, err := ResolveGitopsImage(false, false)
	if err == nil {
		t.Fatalf("resolved to %q with no AOC; there must be no fallback", got)
	}
	if strings.Contains(strings.ToLower(err.Error()), "docker hub") {
		t.Errorf("error mentions Docker Hub: %v", err)
	}
}
