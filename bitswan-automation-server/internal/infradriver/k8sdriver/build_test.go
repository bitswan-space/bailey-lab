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

// TestTheRegistryIsSpokenToSecurelyUnlessAsked is the one that matters if this
// ever ships: a registry reached over http carries every image a Bailey builds,
// and the credentials baked into some of them, in the clear. Plaintext has to
// be a thing an install chose, not a thing it got.
func TestTheRegistryIsSpokenToSecurelyUnlessAsked(t *testing.T) {
	t.Setenv("BITSWAN_K8S_REGISTRY", "registry.example:5000")

	t.Setenv("BITSWAN_K8S_REGISTRY_INSECURE", "")
	if got := registryScheme(); got != "https://" {
		t.Errorf("scheme with nothing configured = %q, want https://", got)
	}
	if got := buildkitInsecure(); got != "" {
		t.Errorf("builder told %q with nothing configured, want nothing", got)
	}

	// Anything that is not an explicit yes is a no, including the values a
	// half-written template leaves behind.
	for _, off := range []string{"false", "0", "no", "FALSE", " ", "maybe"} {
		t.Setenv("BITSWAN_K8S_REGISTRY_INSECURE", off)
		if registryInsecure() {
			t.Errorf("%q was read as permission to use plaintext", off)
		}
	}

	for _, on := range []string{"true", "1", "yes", "TRUE"} {
		t.Setenv("BITSWAN_K8S_REGISTRY_INSECURE", on)
		if !registryInsecure() {
			t.Errorf("%q did not turn plaintext on", on)
		}
	}
	if got := registryScheme(); got != "http://" {
		t.Errorf("scheme when asked = %q, want http://", got)
	}
	if got := buildkitInsecure(); got != ",registry.insecure=true" {
		t.Errorf("builder option when asked = %q", got)
	}
}
