package daemon

import "testing"

func TestIsDehydratableLiveDevHost(t *testing.T) {
	cases := []struct {
		host string
		want bool
	}{
		{"wraptest-frontend-4c4b-live-dev.timssandbox2.bswn.io", true},
		{"wraptest-frontend-4c4b-live-dev--inner.timssandbox2.bswn.io", true},
		{"wraptest-frontend-02e3-dev.timssandbox2.bswn.io", false},          // dev, not live-dev
		{"wraptest-frontend-02e3-staging.timssandbox2.bswn.io", false},      // staging
		{"wraptest-frontend-1155-production-a.timssandbox2.bswn.io", false}, // production
		{"wraptest-frontend-1155-production.timssandbox2.bswn.io", false},   // production
		{"bailey.timssandbox2.bswn.io", false},                              // management host
	}
	for _, c := range cases {
		if got := isDehydratableLiveDevHost(c.host); got != c.want {
			t.Errorf("isDehydratableLiveDevHost(%q) = %v, want %v", c.host, got, c.want)
		}
	}
}
