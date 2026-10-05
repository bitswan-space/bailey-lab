package dockerhub

import "testing"

func TestADevImageIsNeverAskedOfTheAOC(t *testing.T) {
	// Dev images are built locally and never published, so there is nothing in
	// any registry to resolve them to.
	if got := aocRepository("gitops-staging", "gitops", false, true); got != "" {
		t.Errorf("a dev build resolved to %q", got)
	}
	if got := aocRepository("gitops-staging", "gitops", true, true); got != "" {
		t.Errorf("a dev build on the staging track resolved to %q", got)
	}
}

func TestTheTrackPicksTheRepository(t *testing.T) {
	if got := aocRepository("gitops-staging", "gitops", true, false); got != "gitops-staging" {
		t.Errorf("staging resolved to %q", got)
	}
	if got := aocRepository("gitops-staging", "gitops", false, false); got != "gitops" {
		t.Errorf("stable resolved to %q", got)
	}
}

func TestAnEmptyRepositoryIsNeverAsked(t *testing.T) {
	if _, found := fromTheAOC(""); found {
		t.Error("an empty repository was looked up")
	}
}
