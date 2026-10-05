package aocregistry

import "testing"

func TestOnlyBuildTagsAreConsidered(t *testing.T) {
	got := BuildTagsNewestFirst([]string{
		"latest", "staging", "warm",
		"2026-692-git-cae893b",
		"sha256_deadbeef",
		"2026-100-git-abc1234",
		"v1.2.3",
	})
	want := []string{"2026-692-git-cae893b", "2026-100-git-abc1234"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestRunNumbersAreComparedAsNumbers(t *testing.T) {
	got := BuildTagsNewestFirst([]string{
		"2026-99-git-aaa1111", "2026-1000-git-bbb2222", "2026-692-git-ccc3333",
	})
	if got[0] != "2026-1000-git-bbb2222" {
		t.Errorf("newest = %q; run numbers must not be compared as text", got[0])
	}
}

func TestTheApiSitsBesideTheRegistry(t *testing.T) {
	for host, want := range map[string]string{
		"registry.staging2.bitswan.ai":         "https://api.staging2.bitswan.ai",
		"https://registry.staging2.bitswan.ai": "https://api.staging2.bitswan.ai",
		"someregistry.example":                 "https://someregistry.example",
	} {
		if got := New(host, "k").apiBase(); got != want {
			t.Errorf("apiBase(%q) = %q, want %q", host, got, want)
		}
	}
}
