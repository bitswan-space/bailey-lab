package traefikapi

import "testing"

func TestHostCoveredByWildcard(t *testing.T) {
	tests := []struct {
		hostname string
		domain   string
		want     bool
	}{
		// The domain itself and direct children are covered.
		{"acme-prod.bswn.io", "acme-prod.bswn.io", true},
		{"myws-editor.acme-prod.bswn.io", "acme-prod.bswn.io", true},
		// DNS is case-insensitive; trailing dots are canonical-form noise.
		{"MyWS-Editor.ACME-PROD.bswn.io", "acme-prod.bswn.io", true},
		{"myws-editor.acme-prod.bswn.io.", "acme-prod.bswn.io.", true},
		// Wildcards cover exactly one level — deeper names are not covered.
		{"deep.myws-editor.acme-prod.bswn.io", "acme-prod.bswn.io", false},
		// Suffix-substring attack: evil-acme-prod.bswn.io is not under acme-prod.bswn.io.
		{"evil-acme-prod.bswn.io", "acme-prod.bswn.io", false},
		{"foo.evil-acme-prod.bswn.io", "acme-prod.bswn.io", false},
		// Different domains entirely.
		{"other-tenant.bswn.io", "acme-prod.bswn.io", false},
		{"myws-editor.acme-prod.example.com", "acme-prod.bswn.io", false},
		// Empty inputs.
		{"", "acme-prod.bswn.io", false},
		{"myws-editor.acme-prod.bswn.io", "", false},
	}

	for _, tt := range tests {
		if got := HostCoveredByWildcard(tt.hostname, tt.domain); got != tt.want {
			t.Errorf("HostCoveredByWildcard(%q, %q) = %v, want %v", tt.hostname, tt.domain, got, tt.want)
		}
	}
}

func TestWildcardTLSDomains(t *testing.T) {
	domains := WildcardTLSDomains("acme-prod.bswn.io")
	if len(domains) != 1 {
		t.Fatalf("expected 1 domain entry, got %d", len(domains))
	}
	if domains[0].Main != "acme-prod.bswn.io" {
		t.Errorf("Main = %q, want %q", domains[0].Main, "acme-prod.bswn.io")
	}
	if len(domains[0].SANs) != 1 || domains[0].SANs[0] != "*.acme-prod.bswn.io" {
		t.Errorf("SANs = %v, want [*.acme-prod.bswn.io]", domains[0].SANs)
	}
}
