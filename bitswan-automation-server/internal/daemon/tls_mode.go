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

	// TLSModeCustomDNS obtains the same wildcard from the same CA over the same
	// challenge, but solves it against a DNS provider the OPERATOR runs, using
	// lego's provider for it. For a customer who keeps their own zone: the AOC
	// bridge has no zone to write to there, but the certificate story is otherwise
	// identical — real certificates, automatic renewal, and a registration
	// verification that keeps working unchanged.
	//
	// Only HOW the challenge is solved differs from aoc-dns, so the two modes use
	// the same resolver name and the same ACME storage: switching between them
	// needs no route migration and no re-issuance.
	TLSModeCustomDNS TLSMode = "custom-dns"

	// TLSModeManual serves certificates the operator installed, and asks no CA
	// for anything. For an internal CA, a corporate PKI, or a DNS provider that
	// cannot be automated. Certificates are installed per hostname (or once as a
	// wildcard) and Traefik picks them by SNI.
	TLSModeManual TLSMode = "manual"
)

// tlsModes is the set of accepted values, in a stable order for messages.
var tlsModes = map[TLSMode]string{
	TLSModeAOCDNS:    "Let's Encrypt over DNS-01, solved through the AOC's zone (default)",
	TLSModeCustomDNS: "Let's Encrypt over DNS-01, solved against your own DNS provider",
	TLSModeManual:    "certificates you install yourself; no CA is contacted",
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

// usesAOCBridge reports whether the DNS-01 challenge is solved through the AOC's
// zone. Only aoc-dns is: the ACME bridge credentials must not appear in Traefik's
// environment in any other mode, and a mode that solves the challenge elsewhere
// must not inherit the bridge's propagation-check workaround.
func (m TLSMode) usesAOCBridge() bool { return m == TLSModeAOCDNS }

// usesCustomDNSProvider reports whether the mode needs an operator-configured
// lego provider (and therefore has something to validate before it can be
// selected at all).
func (m TLSMode) usesCustomDNSProvider() bool { return m == TLSModeCustomDNS }

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

// canIssueWildcard reports whether the mode's DNS-01 backend can actually obtain
// the shared wildcard for this server.

// isPrivateServer reports whether this server declared itself reached over a
// private network. It matters to the certificate story for one reason: HTTP-01
// requires the CA to open a connection to the server, which is exactly what a
// private deployment prevents.
func isPrivateServer() bool {
	settings, err := config.NewAutomationServerConfig().GetAutomationOperationsCenterSettings()
	if err != nil || settings == nil {
		return false
	}
	return settings.Private
}

// canObtainCertificate reports whether this server can actually get a
// certificate in the given mode — as opposed to merely being configured to try.
//
// Three ways it is true: the mode asks no CA (the operator supplies the
// certificate), or its DNS-01 challenge can be written, or the server is
// publicly reachable so the per-host HTTP-01 fallback can complete. It is false
// only in the corner where all three fail at once: a CA-backed mode, on a domain
// whose challenge we cannot write, on a server the CA cannot reach. There, no
// certificate is coming and no amount of waiting changes that — which is worth
// knowing BEFORE spending eight minutes discovering it.
func canObtainCertificate(mode TLSMode) bool {
	if !mode.usesACME() {
		return true
	}
	if canIssueWildcard(mode) {
		return true
	}
	return !isPrivateServer()
}

// canIssueWildcard reports whether the mode's DNS-01 wildcard is actually
// obtainable: the challenge has to be writable in a zone the mode can reach.
//
// The two DNS-01 modes differ here, and only here. custom-dns challenges against
// a zone the OPERATOR runs, so whether the AOC manages the domain is irrelevant
// to it. aoc-dns challenges through the AOC's bridge, which writes into the AOC's
// own hosted zone and refuses anything outside it — so on a bring-your-own domain
// it cannot write the challenge at all, and the absence of that check is why such
// a domain fails the way it does today: the bridge answers 502 from a DNS
// endpoint on every attempt, Traefik retries an order that can never complete,
// and registration gives up eight minutes later having named none of the cause.
func canIssueWildcard(m TLSMode) bool {
	if m.usesCustomDNSProvider() {
		return true
	}
	return m.usesAOCBridge() && aocManagesDNS()
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
	case canIssueWildcard(mode):
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
	if mode.usesACME() && !canIssueWildcard(mode) {
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
