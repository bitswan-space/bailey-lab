package k8sdriver

import "testing"

func TestSplitRefTakesTheTagAfterTheLastColon(t *testing.T) {
	for _, tc := range []struct {
		ref             string
		host, repo, tag string
		ok              bool
	}{
		{"bitswan-registry:5000/bitswan/inv:abc123", "bitswan-registry:5000", "bitswan/inv", "abc123", true},
		{"registry:5000/x:1", "registry:5000", "x", "1", true},
		{"example.com/x:1", "example.com", "x", "1", true},
		{"bitswan-registry:5000/bitswan/inv", "", "", "", false},
		{"noslash:1", "", "", "", false},
	} {
		host, repo, tag, ok := splitRef(tc.ref)
		if ok != tc.ok || host != tc.host || repo != tc.repo || tag != tc.tag {
			t.Errorf("splitRef(%q) = (%q,%q,%q,%v), want (%q,%q,%q,%v)",
				tc.ref, host, repo, tag, ok, tc.host, tc.repo, tc.tag, tc.ok)
		}
	}
}

func TestABuiltBaseImageIsNamedInTheRegistry(t *testing.T) {
	t.Setenv("BITSWAN_K8S_REGISTRY", "bitswan-registry:5000")
	for _, tc := range []struct{ in, want string }{
		// A source bake often builds FROM something this driver built earlier.
		// Handed to the builder as a bare tag it goes to Docker Hub and comes
		// back "pull access denied" for a repository that exists only here.
		{"internal/acme-frontend:sha123", "bitswan-registry:5000/internal/acme-frontend:sha123"},
		// A published base is already resolvable and must be left alone.
		{"node:24-alpine", "node:24-alpine"},
		{"bitswan/pipeline-runtime-environment:latest", "bitswan/pipeline-runtime-environment:latest"},
	} {
		if got := resolveImage(tc.in); got != tc.want {
			t.Errorf("resolveImage(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
