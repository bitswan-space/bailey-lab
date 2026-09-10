package daemon

import (
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// The end-to-end TLS self-check reports tls_selfcheck_failed — "the public URL
// is NOT serving our certificate" — into the audit log and any configured SIEM.
// That is only a finding on a server the AOC actually publishes, which means a
// domain AND live credentials. On a config that carries a domain alone the
// hostname need not resolve here at all, so the fetch fails for reasons that
// have nothing to do with interception.
func TestEndpointTLSSelfCheckRunsOnlyForARegisteredServer(t *testing.T) {
	for _, tc := range []struct {
		name   string
		domain string
		token  string
		want   string
	}{
		{"registered with a domain: check it", "acme-prod.bswn.io", "tok", "acme-prod.bswn.io"},
		{"domain but no credentials: not a published server", "acme-prod.bswn.io", "", ""},
		{"registered but no domain: nothing public to check", "", "tok", ""},
		{"neither", "", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := endpointTLSSelfCheckDomain(&config.AutomationOperationsCenterSettings{
				Domain:      tc.domain,
				AccessToken: tc.token,
			})
			if got != tc.want {
				t.Errorf("endpointTLSSelfCheckDomain() = %q, want %q", got, tc.want)
			}
		})
	}

	if got := endpointTLSSelfCheckDomain(nil); got != "" {
		t.Errorf("endpointTLSSelfCheckDomain(nil) = %q, want empty", got)
	}
}
