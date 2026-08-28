package traefikapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// seedGlobalState writes a global rest-state.json in a temp HOME and returns the
// path, so the exported state-mutating helpers can be exercised end to end.
func seedGlobalState(t *testing.T, state *traefikDynConfig) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".config", "bitswan", "traefik")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "rest-state.json")
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func routerWithResolver(host, resolver string) *traefikRouter {
	return &traefikRouter{
		Rule:    "Host(`" + host + "`)",
		Service: sanitizeHostname(host),
		TLS:     &traefikRouterTLS{CertResolver: resolver},
	}
}

func readState(t *testing.T, path string) *traefikDynConfig {
	t.Helper()
	state, err := loadState(path)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

// TestSetWildcardCertResolverIsReversible is the property a server-wide TLS mode
// switch depends on. Taking routes off ACME has to be undoable, and the old
// implementation could not do it: it keyed "leave this route alone" off "has no
// resolver", which is exactly what a switch to manual mode produces — so the
// first switch away from ACME was a one-way door and switching back silently did
// nothing.
func TestSetWildcardCertResolverIsReversible(t *testing.T) {
	const domain = "acme-prod.bswn.io"
	path := seedGlobalState(t, &traefikDynConfig{
		HTTP: &traefikHTTPConfig{
			Routers: map[string]*traefikRouter{
				"bailey":       routerWithResolver("bailey."+domain, "letsencrypt-dns"),
				"bailey_inner": routerWithResolver("bailey--inner."+domain, "letsencrypt-dns"),
			},
			Services: map[string]*traefikService{},
		},
	})

	// → manual: every covered route comes off ACME.
	changed, err := SetWildcardCertResolver(domain, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if changed != 2 {
		t.Errorf("clearing changed %d routes, want 2", changed)
	}
	for id, r := range readState(t, path).HTTP.Routers {
		if r.TLS == nil {
			t.Errorf("%s lost its TLS block; the route must stay https, it just stops asking a CA", id)
			continue
		}
		if r.TLS.CertResolver != "" {
			t.Errorf("%s still has resolver %q", id, r.TLS.CertResolver)
		}
	}

	// → back to ACME: the same routes must come back. This is the assertion the
	// old code could not satisfy.
	changed, err = SetWildcardCertResolver(domain, "letsencrypt-dns", WildcardTLSDomains(domain))
	if err != nil {
		t.Fatal(err)
	}
	if changed != 2 {
		t.Fatalf("re-applying changed %d routes, want 2 — a mode switch must be reversible", changed)
	}
	for id, r := range readState(t, path).HTTP.Routers {
		if r.TLS.CertResolver != "letsencrypt-dns" {
			t.Errorf("%s resolver = %q, want letsencrypt-dns", id, r.TLS.CertResolver)
		}
		if len(r.TLS.Domains) != 1 {
			t.Errorf("%s lost its wildcard tls.domains", id)
		}
	}
}

// TestSetWildcardCertResolverLeavesInstalledCertsAlone: a route whose certificate
// somebody installed by hand (mkcert, or --certs-dir) is manual BY INTENT. Moving
// it onto ACME would ask a public CA for a name the operator may not control
// publicly, and would replace a certificate they chose deliberately.
func TestSetWildcardCertResolverLeavesInstalledCertsAlone(t *testing.T) {
	const domain = "acme-prod.bswn.io"
	const byHand = "legacy." + domain
	seedGlobalState(t, &traefikDynConfig{
		HTTP: &traefikHTTPConfig{
			Routers: map[string]*traefikRouter{
				"bailey": routerWithResolver("bailey."+domain, "letsencrypt-dns"),
				"legacy": routerWithResolver(byHand, ""),
			},
			Services: map[string]*traefikService{},
		},
		TLS: &traefikTLSConfig{Certificates: []traefikTLSCert{{
			CertFile: "/tls/" + sanitizeHostname(byHand) + "/full-chain.pem",
			KeyFile:  "/tls/" + sanitizeHostname(byHand) + "/private-key.pem",
		}}},
	})

	changed, err := SetWildcardCertResolver(domain, "letsencrypt-dns", WildcardTLSDomains(domain))
	if err != nil {
		t.Fatal(err)
	}
	if changed != 0 {
		t.Errorf("changed %d routes, want 0: bailey is already on the resolver and legacy has its own certificate", changed)
	}
	if got := InstalledCertHostnames(); len(got) != 1 || got[0] != sanitizeHostname(byHand) {
		t.Errorf("InstalledCertHostnames() = %v, want [%s]", got, sanitizeHostname(byHand))
	}
}

// Idempotence matters because this runs on every ingress init: a no-op reconcile
// must report no change, or the daemon logs a migration on every boot.
func TestSetWildcardCertResolverIsIdempotent(t *testing.T) {
	const domain = "acme-prod.bswn.io"
	seedGlobalState(t, &traefikDynConfig{
		HTTP: &traefikHTTPConfig{
			Routers:  map[string]*traefikRouter{"bailey": routerWithResolver("bailey."+domain, "letsencrypt-dns")},
			Services: map[string]*traefikService{},
		},
	})
	for i := 0; i < 2; i++ {
		changed, err := SetWildcardCertResolver(domain, "letsencrypt-dns", WildcardTLSDomains(domain))
		if err != nil {
			t.Fatal(err)
		}
		if changed != 0 {
			t.Errorf("pass %d changed %d routes, want 0", i, changed)
		}
	}
}

// Routes outside the wildcard, and plain HTTP routes, are none of this function's
// business.
func TestSetWildcardCertResolverScope(t *testing.T) {
	const domain = "acme-prod.bswn.io"
	path := seedGlobalState(t, &traefikDynConfig{
		HTTP: &traefikHTTPConfig{
			Routers: map[string]*traefikRouter{
				"other": routerWithResolver("app.other-tenant.bswn.io", "letsencrypt"),
				"deep":  routerWithResolver("deep.app."+domain, "letsencrypt"),
				"plain": {Rule: "Host(`plain." + domain + "`)", Service: "plain"},
			},
			Services: map[string]*traefikService{},
		},
	})
	changed, err := SetWildcardCertResolver(domain, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if changed != 0 {
		t.Errorf("changed %d routes, want 0", changed)
	}
	state := readState(t, path)
	if state.HTTP.Routers["other"].TLS.CertResolver != "letsencrypt" {
		t.Error("a route outside the wildcard was modified")
	}
	if state.HTTP.Routers["deep"].TLS.CertResolver != "letsencrypt" {
		t.Error("a two-label host is not covered by *.domain and must not be modified")
	}
	if state.HTTP.Routers["plain"].TLS != nil {
		t.Error("a plain HTTP route was given a TLS block")
	}
}
