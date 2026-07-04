package daemon

import "testing"

func TestIsDehydratableHost(t *testing.T) {
	cases := []struct {
		host string
		want bool
	}{
		{"wraptest-frontend-4c4b-live-dev.timssandbox2.bswn.io", true},        // live-dev
		{"wraptest-frontend-4c4b-live-dev--inner.timssandbox2.bswn.io", true}, // live-dev (inner)
		{"wraptest-frontend-02e3-dev.timssandbox2.bswn.io", true},             // dev — also ephemeral
		{"wraptest-frontend-02e3-dev--inner.timssandbox2.bswn.io", true},      // dev (inner)
		{"wraptest-frontend-02e3-staging.timssandbox2.bswn.io", false},        // staging — PROTECTED
		{"wraptest-frontend-1155-production-a.timssandbox2.bswn.io", false},   // production — PROTECTED
		{"wraptest-frontend-1155-production.timssandbox2.bswn.io", false},     // production — PROTECTED
		{"bailey.timssandbox2.bswn.io", false},                                // management host
	}
	for _, c := range cases {
		if got := isDehydratableHost(c.host); got != c.want {
			t.Errorf("isDehydratableHost(%q) = %v, want %v", c.host, got, c.want)
		}
	}
}
