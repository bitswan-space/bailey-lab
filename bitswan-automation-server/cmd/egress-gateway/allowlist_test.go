package main

import "testing"

func TestAllowList(t *testing.T) {
	a := NewAllowList([]string{"sentry.io", "api.openai.com", "  Hooks.Slack.com ", ""})
	cases := []struct {
		host string
		want bool
	}{
		{"sentry.io", true},            // exact
		{"ingest.sentry.io", true},     // subdomain
		{"a.b.sentry.io", true},        // deep subdomain
		{"SENTRY.IO", true},            // case-insensitive
		{"sentry.io:443", true},        // port stripped
		{"sentry.io.", true},           // trailing dot
		{"notsentry.io", false},        // not a subdomain (no dot boundary)
		{"evil.com", false},            // unlisted
		{"openai.com", false},          // parent of a rule is NOT allowed
		{"api.openai.com", true},       // exact rule
		{"v1.api.openai.com", true},    // subdomain of exact rule
		{"hooks.slack.com", true},      // trimmed + lowercased rule
		{"", false},                    // empty
	}
	for _, c := range cases {
		if got := a.Allowed(c.host); got != c.want {
			t.Errorf("Allowed(%q) = %v, want %v", c.host, got, c.want)
		}
	}
}

func TestAllowListEmpty(t *testing.T) {
	a := NewAllowList(nil)
	if a.Allowed("anything.com") {
		t.Error("empty allow-list should deny everything")
	}
}
