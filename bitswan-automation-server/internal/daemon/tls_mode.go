package daemon

import (
	"fmt"
	"sort"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/traefikapi"
)

// How this server's public hostnames get their TLS certificates.
//
// Until now this was a two-way branch decided in two unrelated places: a route
// registered with `--mkcert`/`--certs-dir` bypassed ACME, and everything else
// asked certResolverForHostname, which picked the DNS-01 wildcard resolver for
// hosts under the AOC-assigned domain and a per-host HTTP-01 resolver for
// anything else. That was fine while there was exactly one way to obtain a
// certificate automatically. It stops being fine as soon as there is more than
// one — a DNS provider the operator runs themselves, or certificates issued by an
// internal CA — because each new backend would otherwise add its own bypass in
// its own place, and the same "which routes are on ACME" bug would be fixable in
// several places and fixed in none.
//
// So the decision becomes a single named server-level mode, resolved in one
// function, with the route-level bypasses left exactly as they are (a route with
// its own installed certificate is manual by intent, whatever the server mode
// says).
type TLSMode string

const (
	// TLSModeAOCDNS obtains a *.<domain> wildcard from Let's Encrypt over the
	// DNS-01 challenge, solved through the AOC's zone (the ACME bridge). This is
	// the default and the historical behaviour, and it is the mode that works for
	// a server with no public inbound route at all: the CA reads DNS and never
	// connects to the server.
	TLSModeAOCDNS TLSMode = "aoc-dns"

	// TLSModeManual serves certificates the operator installed, and asks no CA
	// for anything. For an internal CA, a corporate PKI, or a DNS provider that
	// cannot be automated. Certificates are installed per hostname (or once as a
	// wildcard) and Traefik picks them by SNI.
	TLSModeManual TLSMode = "manual"
)

// tlsModes is the set of accepted values, in a stable order for messages.
var tlsModes = map[TLSMode]string{
	TLSModeAOCDNS: "Let's Encrypt over DNS-01, solved through the AOC's zone (default)",
	TLSModeManual: "certificates you install yourself; no CA is contacted",
}

// DefaultTLSMode is what a server with nothing configured runs. It must stay
// aoc-dns: every existing server has no tls_mode in its config and must keep
// behaving exactly as it did.
const DefaultTLSMode = TLSModeAOCDNS

// ParseTLSMode validates an operator-supplied mode name.
func ParseTLSMode(s string) (TLSMode, error) {
	m := TLSMode(strings.ToLower(strings.TrimSpace(s)))
	if _, ok := tlsModes[m]; !ok {
		return "", fmt.Errorf("unknown TLS mode %q; known modes: %s", s, strings.Join(TLSModeNames(), ", "))
	}
	return m, nil
}

// TLSModeNames lists the accepted mode names, sorted.
func TLSModeNames() []string {
	names := make([]string, 0, len(tlsModes))
	for m := range tlsModes {
		names = append(names, string(m))
	}
	sort.Strings(names)
	return names
}

// TLSModeDescription is the one-line explanation shown by the CLI.
func TLSModeDescription(m TLSMode) string { return tlsModes[m] }

// currentTLSMode returns the configured mode, defaulting to aoc-dns. A missing
// or unreadable config is not an error: an unregistered server still runs an
// ingress, and "nothing configured" means the historical behaviour.
func currentTLSMode() TLSMode {
	cfg := config.NewAutomationServerConfig()
	raw := cfg.GetTLSMode()
	if raw == "" {
		return DefaultTLSMode
	}
	m, err := ParseTLSMode(raw)
	if err != nil {
		// A config we can't interpret must not silently downgrade TLS to
		// something the operator didn't ask for. aoc-dns is both the default and
		// the safe answer (it asks a real CA), so say so and use it.
		fmt.Printf("Warning: stored tls_mode %q is not a known mode; using %s\n", raw, DefaultTLSMode)
		return DefaultTLSMode
	}
	return m
}

// usesACME reports whether the mode obtains certificates from a CA at all.
func (m TLSMode) usesACME() bool { return m != TLSModeManual }

// reconcileTLSMode moves the LIVE route table onto the certificate backend the
// configured mode implies, and is the answer to "what happens when an operator
// switches mode on a server that is already serving traffic".
//
// Without it a switch would only affect routes registered afterwards: every
// existing router keeps whatever resolver it was created with, so a server moved
// to manual mode would go on asking Let's Encrypt for certificates it can no
// longer get (and, worse, a server moved back would serve a stale installed
// certificate for hosts whose ACME certificate had since been renewed away).
//
// Routes that carry a certificate of their own are never touched — see
// traefikapi.SetWildcardCertResolver for why that distinction is the one that
// makes this safe to re-run.
func reconcileTLSMode() {
	domain := getWildcardCertDomain()
	if domain == "" {
		return // no domain yet: nothing under a wildcard to reconcile
	}
	mode := currentTLSMode()

	resolver := ""
	var tlsDomains []traefikapi.TLSDomain
	if mode.usesACME() {
		resolver = dnsCertResolverName
		tlsDomains = traefikapi.WildcardTLSDomains(domain)
	}

	changed, err := traefikapi.SetWildcardCertResolver(domain, resolver, tlsDomains)
	if err != nil {
		fmt.Printf("Warning: could not reconcile existing routes onto TLS mode %s: %v\n", mode, err)
		return
	}
	if changed > 0 {
		if resolver == "" {
			fmt.Printf("TLS mode %s: %d route(s) under %s stopped requesting ACME certificates "+
				"and now serve the certificates installed for them\n", mode, changed, domain)
		} else {
			fmt.Printf("TLS mode %s: %d route(s) under %s switched to the %s resolver\n",
				mode, changed, domain, resolver)
		}
	}
}
