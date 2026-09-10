package k8sdriver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

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
		{"internal/acme-frontend:sha123", "bitswan-registry:5000/internal/acme-frontend:sha123"},
		{"node:24-alpine", "node:24-alpine"},
		{"bitswan/pipeline-runtime-environment:latest", "bitswan/pipeline-runtime-environment:latest"},
	} {
		if got := resolveImage(tc.in); got != tc.want {
			t.Errorf("resolveImage(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestTheRegistryIsSpokenToSecurelyUnlessAsked(t *testing.T) {
	t.Setenv("BITSWAN_K8S_REGISTRY", "registry.example:5000")

	t.Setenv("BITSWAN_K8S_REGISTRY_INSECURE", "")
	if got := registryScheme(); got != "https://" {
		t.Errorf("scheme with nothing configured = %q, want https://", got)
	}
	if got := buildkitInsecure(); got != "" {
		t.Errorf("builder told %q with nothing configured, want nothing", got)
	}

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

func TestACachedImageIsRecognisedByItsDigest(t *testing.T) {
	const digest = "sha256:b0a1"
	var asked []string
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.Method+" "+r.URL.Path)
		if r.URL.Path == "/v2/internal/acme-backend/manifests/sha123" {
			w.Header().Set("Docker-Content-Digest", digest)
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer registry.Close()

	t.Setenv("BITSWAN_K8S_REGISTRY", strings.TrimPrefix(registry.URL, "http://"))
	t.Setenv("BITSWAN_K8S_REGISTRY_INSECURE", "true")
	d := &K8sDriver{workspace: "acme", namespace: "bitswan"}

	if got := d.manifestDigest(context.Background(), registryRef("internal/acme-backend:sha123")); got != digest {
		t.Errorf("a tag already in the registry reported %q, want %q; every build would repeat work already done", got, digest)
	}
	if got := d.manifestDigest(context.Background(), registryRef("internal/acme-backend:never-built")); got != "" {
		t.Errorf("a tag that is not there reported %q; the build would be skipped and the deploy would pull nothing", got)
	}
	for _, a := range asked {
		if !strings.HasPrefix(a, "HEAD ") {
			t.Errorf("the cache check fetched a body: %s", a)
		}
	}
}
