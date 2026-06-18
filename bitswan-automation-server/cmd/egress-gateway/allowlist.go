package main

import (
	"strings"
)

// AllowList decides whether an outbound hostname is permitted. A rule matches a
// host if it is exactly equal (case-insensitive) or the host is a subdomain of
// the rule (host ends with "."+rule). e.g. rule "sentry.io" allows "sentry.io"
// and "ingest.sentry.io"; rule "api.openai.com" allows only that exact host.
type AllowList struct {
	rules map[string]struct{}
}

func NewAllowList(hosts []string) *AllowList {
	a := &AllowList{rules: make(map[string]struct{})}
	for _, h := range hosts {
		h = normalizeHost(h)
		if h != "" {
			a.rules[h] = struct{}{}
		}
	}
	return a
}

// normalizeHost lower-cases, strips a trailing dot, any port, and surrounding
// whitespace. Returns "" for empty/invalid input.
func normalizeHost(h string) string {
	h = strings.TrimSpace(strings.ToLower(h))
	if i := strings.IndexByte(h, ':'); i >= 0 { // strip :port
		h = h[:i]
	}
	h = strings.TrimSuffix(h, ".")
	return h
}

func (a *AllowList) Allowed(host string) bool {
	host = normalizeHost(host)
	if host == "" {
		return false
	}
	if _, ok := a.rules[host]; ok {
		return true
	}
	// subdomain: walk parent domains (a.b.c → b.c → c) and match any rule.
	for i := 0; i < len(host); i++ {
		if host[i] == '.' {
			if _, ok := a.rules[host[i+1:]]; ok {
				return true
			}
		}
	}
	return false
}
