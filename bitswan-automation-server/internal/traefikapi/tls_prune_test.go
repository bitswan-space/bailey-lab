package traefikapi

import "testing"

// The TLS sweep must match cert entries by EXACT sanitized hostname — the old
// substring filter had a cross-workspace blast radius: removing a workspace
// named "dev" stripped the cert entry of every other workspace's -dev stage
// hostname (path contains "dev"), downgrading their hosts to Traefik's
// default self-signed cert.
func TestPruneTLSCertsExactMatch(t *testing.T) {
	entry := func(seg string) traefikTLSCert {
		return traefikTLSCert{
			CertFile: "/tls/" + seg + "/full-chain.pem",
			KeyFile:  "/tls/" + seg + "/private-key.pem",
		}
	}
	certs := []traefikTLSCert{
		entry("dev_gitops_bitswan_localhost"),            // workspace "dev" — remove
		entry("dev_dashboard_bitswan_localhost"),         // workspace "dev" — remove
		entry("pr_frontend_x_dev_bitswan_localhost"),     // OTHER ws, "-dev" stage — keep (old bug removed it)
		entry("dev_two_gitops_bitswan_localhost"),        // sibling "dev-two" — keep
		entry("*_bitswan_localhost"),                     // shared wildcard — keep unless wanted
		{CertFile: "/custom/path.pem", KeyFile: "/k"},    // unmatched shape — keep
	}
	wanted := map[string]bool{
		sanitizeHostname("dev-gitops.bitswan.localhost"):    true,
		sanitizeHostname("dev-dashboard.bitswan.localhost"): true,
	}

	keep, removed := pruneTLSCerts(certs, wanted)
	if len(removed) != 2 {
		t.Fatalf("removed = %v, want the 2 dev-workspace segments", removed)
	}
	keptSegs := map[string]bool{}
	for _, c := range keep {
		keptSegs[tlsCertHostSegment(c.CertFile)] = true
	}
	for _, want := range []string{
		"pr_frontend_x_dev_bitswan_localhost",
		"dev_two_gitops_bitswan_localhost",
		"*_bitswan_localhost",
		"", // the unmatched-shape entry
	} {
		if !keptSegs[want] {
			t.Errorf("entry %q should have been kept (kept: %v)", want, keptSegs)
		}
	}

	// Wildcard IS removed when the caller includes it (sole user of the domain).
	wanted[sanitizeHostname("*.bitswan.localhost")] = true
	_, removed = pruneTLSCerts(certs, wanted)
	found := false
	for _, seg := range removed {
		if seg == "*_bitswan_localhost" {
			found = true
		}
	}
	if !found {
		t.Error("wildcard entry should be removed when explicitly wanted")
	}
}

func TestTLSCertHostSegment(t *testing.T) {
	cases := map[string]string{
		"/tls/pr_gitops_x_io/full-chain.pem": "pr_gitops_x_io",
		"/tls/seg/deeper/file.pem":           "seg",
		"/other/path.pem":                    "",
		"/tls/no-trailing-segment":           "",
		"":                                   "",
	}
	for in, want := range cases {
		if got := tlsCertHostSegment(in); got != want {
			t.Errorf("tlsCertHostSegment(%q) = %q, want %q", in, got, want)
		}
	}
}
