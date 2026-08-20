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

// aocManagesDNS reports whether the AOC controls this server's domain — and
// therefore whether the ACME bridge can write a challenge for it at all. The
// bridge writes into the AOC's own hosted zone and rejects anything outside it.
//
// Nil (an AOC that never sent the field, or a server registered before it was
// recorded) means "assume it does": that is the behaviour every existing server
// already relies on, and reading it as "not managed" would take them all off the
// wildcard certificate they are currently using. Only an explicit false changes
// anything.
func aocManagesDNS() bool {
	settings, err := config.NewAutomationServerConfig().GetAutomationOperationsCenterSettings()
	if err != nil || settings == nil || settings.DNSManaged == nil {
		return true
	}
	return *settings.DNSManaged
}

// aocDNSUsable reports whether the mode's DNS-01 wildcard is actually obtainable:
// the mode has to use the AOC bridge AND the AOC has to own the zone the
// challenge is written into.
//
// The absence of this check is why a bring-your-own domain fails the way it does
// today. The AOC has published dns_managed all along — its serializer documents
// it as the flag for "DNS-01 wildcard (AOC-managed domain) versus per-host
// HTTP-01 (bring-your-own)" — and nothing on this side ever read it. So a server
// on a customer's own domain asks for the wildcard anyway, the bridge answers 502
// from a DNS endpoint on every attempt, Traefik retries an order that can never
// complete, and registration gives up eight minutes later having named none of
// the cause.
func aocDNSUsable(m TLSMode) bool {
	return m == TLSModeAOCDNS && aocManagesDNS()
}

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
	switch {
	case aocDNSUsable(mode):
		// One wildcard shared by every host under the domain.
		resolver = dnsCertResolverName
		tlsDomains = traefikapi.WildcardTLSDomains(domain)
	case mode.usesACME():
		// A CA-backed mode whose DNS-01 challenge cannot be written: the wildcard
		// is unobtainable, a per-host HTTP-01 certificate is not.
		resolver = httpCertResolverName
	}

	changed, err := traefikapi.SetWildcardCertResolver(domain, resolver, tlsDomains)
	if err != nil {
		fmt.Printf("Warning: could not reconcile existing routes onto TLS mode %s: %v\n", mode, err)
		return
	}
	if mode.usesACME() && !aocDNSUsable(mode) {
		fmt.Printf("Warning: TLS mode %s obtains its wildcard through the AOC's zone, but the AOC "+
			"does not manage DNS for %s — no DNS-01 challenge for it can succeed. These hosts fall "+
			"back to per-host HTTP-01, which needs inbound :80 from the internet. Switch to a mode "+
			"that can issue here: %s\n", mode, domain, strings.Join(alternativeTLSModes(mode), " or "))
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

// alternativeTLSModes lists the modes that could issue where the current one
// cannot, so the diagnosis carries its own remedy instead of leaving the operator
// to find one.
func alternativeTLSModes(current TLSMode) []string {
	var out []string
	for _, m := range TLSModeNames() {
		if TLSMode(m) == current || TLSMode(m) == TLSModeAOCDNS {
			continue
		}
		out = append(out, m)
	}
	return out
}
