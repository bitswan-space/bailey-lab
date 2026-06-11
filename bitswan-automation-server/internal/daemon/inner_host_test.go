package daemon

import (
	"strings"
	"testing"
)

func TestInnerHostMapping(t *testing.T) {
	cases := []struct {
		name    string
		host    string
		isInner bool
		toInner string
		toOuter string
	}{
		{
			name:    "outer multi-label",
			host:    "my-ws-editor.acme.bswn.io",
			isInner: false,
			toInner: "my-ws-editor--inner.acme.bswn.io",
			toOuter: "my-ws-editor.acme.bswn.io",
		},
		{
			name:    "inner multi-label",
			host:    "my-ws-editor--inner.acme.bswn.io",
			isInner: true,
			toInner: "my-ws-editor--inner.acme.bswn.io",
			toOuter: "my-ws-editor.acme.bswn.io",
		},
		{
			name:    "single label",
			host:    "gitops",
			isInner: false,
			toInner: "gitops--inner",
			toOuter: "gitops",
		},
		{
			name:    "empty",
			host:    "",
			isInner: false,
			toInner: "",
			toOuter: "",
		},
		{
			name:    "bailey host",
			host:    "bailey.acme.bswn.io",
			isInner: false,
			toInner: "bailey--inner.acme.bswn.io",
			toOuter: "bailey.acme.bswn.io",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isInnerHost(tc.host); got != tc.isInner {
				t.Errorf("isInnerHost(%q) = %v, want %v", tc.host, got, tc.isInner)
			}
			if got := toInnerHost(tc.host); got != tc.toInner {
				t.Errorf("toInnerHost(%q) = %q, want %q", tc.host, got, tc.toInner)
			}
			if got := toOuterHost(tc.host); got != tc.toOuter {
				t.Errorf("toOuterHost(%q) = %q, want %q", tc.host, got, tc.toOuter)
			}
		})
	}
}

func TestInnerOuterRoundTrip(t *testing.T) {
	outer := "foo.example.com"
	if got := toOuterHost(toInnerHost(outer)); got != outer {
		t.Errorf("round trip changed hostname: %q", got)
	}
}

func TestStrictInnerCSP_NoDomainConfigured(t *testing.T) {
	// No automation server config in the test HOME → domain is empty →
	// the fallback CSP must still pin frame-ancestors to the outer host.
	csp := strictInnerCSP("app--inner.example.com")
	if csp != "frame-ancestors 'self' https://app.example.com" {
		t.Errorf("fallback CSP = %q", csp)
	}
}

func TestStrictInnerCSP_WithDomain(t *testing.T) {
	setupTestConfig(t, "https://aoc.example.com", "acme.bswn.io")
	csp := strictInnerCSP("myws-editor--inner.acme.bswn.io")
	for _, want := range []string{
		"default-src 'self' https://*.acme.bswn.io",
		// 'self' must be present so apps can nest their own iframes
		// (every ancestor in the chain is checked, including the
		// same-origin parent of a nested frame).
		"frame-ancestors 'self' https://myws-editor.acme.bswn.io",
		"connect-src 'self' https://*.acme.bswn.io wss://*.acme.bswn.io wss://myws-editor--inner.acme.bswn.io",
		"script-src 'self' https://*.acme.bswn.io 'unsafe-inline' 'unsafe-eval' blob:",
	} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP missing %q:\n%s", want, csp)
		}
	}
	if strings.Contains(csp, "https://* ") || strings.Contains(csp, "https://*;") {
		t.Errorf("CSP contains bare wildcard:\n%s", csp)
	}
}

func TestStripCSPFrameAncestors(t *testing.T) {
	in := "default-src 'self'; frame-ancestors https://x.example.com; img-src data:"
	out := stripCSPFrameAncestors(in)
	if strings.Contains(strings.ToLower(out), "frame-ancestors") {
		t.Errorf("frame-ancestors not stripped: %q", out)
	}
	for _, keep := range []string{"default-src 'self'", "img-src data:"} {
		if !strings.Contains(out, keep) {
			t.Errorf("directive %q lost: %q", keep, out)
		}
	}
}
