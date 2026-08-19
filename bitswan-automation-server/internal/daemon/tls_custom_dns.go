package daemon

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// A lego DNS provider id: lowercase, digits, dash, underscore. Matching lego's
// own naming ("cloudflare", "route53", "azuredns", "gcloud", "digitalocean").
var legoProviderRE = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)

// The environment variable names lego providers read. Uppercase with digits and
// underscores, which is also what can be safely rendered into a compose
// environment list.
var credentialNameRE = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)

// validateCustomDNS checks that a custom DNS-01 configuration can actually be
// rendered and used.
//
// This is a real gate rather than a formality: the provider id and every
// credential name go into Traefik's static config and compose environment
// verbatim, so a value carrying a newline or an "=" would either corrupt the
// YAML or silently define a different variable. And an empty provider would
// render a resolver with no challenge solver at all, which fails at certificate
// time with an error that points nowhere near the cause.
func validateCustomDNS(dns config.TLSDNSSettings) error {
	provider := strings.TrimSpace(dns.Provider)
	if provider == "" {
		return fmt.Errorf("no DNS provider is configured (set one with " +
			"'bitswan ingress tls custom-dns --dns-provider <lego-provider>')")
	}
	if !legoProviderRE.MatchString(provider) {
		return fmt.Errorf("DNS provider %q is not a valid lego provider id "+
			"(lowercase letters, digits, dash, underscore — e.g. cloudflare, route53, azuredns)",
			provider)
	}
	if len(dns.Credentials) == 0 {
		return fmt.Errorf("provider %q has no credentials configured; lego reads them from the "+
			"environment (e.g. --dns-credential CF_DNS_API_TOKEN=…)", provider)
	}
	for name, value := range dns.Credentials {
		if !credentialNameRE.MatchString(name) {
			return fmt.Errorf("credential name %q is not an environment variable name "+
				"(uppercase letters, digits, underscore)", name)
		}
		if value == "" {
			return fmt.Errorf("credential %s has an empty value", name)
		}
		if strings.ContainsAny(value, "\n\r") {
			return fmt.Errorf("credential %s contains a newline", name)
		}
	}
	return nil
}

// credentialNames lists the configured credential names, sorted. Names only —
// values are secrets and must never reach a status payload, a log line or a
// terminal.
func credentialNames(dns config.TLSDNSSettings) []string {
	names := make([]string, 0, len(dns.Credentials))
	for name := range dns.Credentials {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// ParseCredentialFlag splits a NAME=value pair from the CLI. Exported because the
// CLI parses the flag before it reaches the daemon, so a malformed pair is a usage
// error rather than a round trip.
func ParseCredentialFlag(pair string) (string, string, error) {
	name, value, ok := strings.Cut(pair, "=")
	if !ok {
		return "", "", fmt.Errorf("credential %q must be NAME=value", pair)
	}
	name = strings.TrimSpace(name)
	if name == "" || value == "" {
		return "", "", fmt.Errorf("credential %q must be NAME=value with both parts non-empty", pair)
	}
	return name, value, nil
}
