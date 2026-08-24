package daemon

import (
	"fmt"
	"sort"
)

// reconcileProtectedRedirectURIs re-asserts the OAuth URI pair of every
// protected hostname this server knows about.
//
// Registration used to be write-once: a hostname's URIs were sent to the
// AOC at the moment its route was created and never again. Anything that
// lost an entry afterwards — a Keycloak client rewritten by an older
// provisioning path, a workspace migration, a hand-repair that restored
// the callback list but not the post-logout list, a registration whose
// second write failed — left that endpoint permanently half-registered,
// and the only symptom is a user pressing Logout and landing on
// Keycloak's "Invalid redirect uri" page. Nothing converged it back.
//
// So the daemon reconciles instead: on every boot it walks its own
// record of protected hosts and states the pair for each. The daemon is
// the only party that knows an endpoint exists at all — the AOC can
// backfill a missing post-logout twin from a callback it already has,
// but it can't invent a host whose callback was dropped entirely.
//
// Semantics, deliberately narrow:
//   - ADDITIVE ONLY. It states which URIs must be present and never asks
//     for a removal. The bitswan-protected client is shared with other
//     products' endpoints; pruning is a separate, explicit operation
//     (workspace deletion, AOC-side).
//   - IDEMPOTENT. A converged server writes nothing: the AOC skips the
//     Keycloak write when both URIs are already registered.
//   - BEST-EFFORT PER HOST. One unreachable or rejected host does not
//     stop the sweep; every failure is logged and counted, and the
//     summary line is the operator's evidence that it ran.
func reconcileProtectedRedirectURIs() {
	if protectedHostnameDomain() == "" {
		return
	}
	hosts, err := knownProtectedHosts()
	if err != nil {
		fmt.Printf("Warning: could not list protected hosts for redirect-URI reconcile: %v\n", err)
		return
	}
	if len(hosts) == 0 {
		return
	}
	// One client for the whole sweep: a server with a protected domain but
	// no AOC credentials should say so once, not 160 times.
	aocClient, err := newAOCOAuthClient()
	if err != nil {
		fmt.Printf("Skipping redirect-URI reconcile for %d protected host(s): AOC not configured: %v\n", len(hosts), err)
		return
	}
	fmt.Printf("Reconciling OAuth redirect + post-logout URIs for %d protected host(s)\n", len(hosts))
	var failed int
	for _, h := range hosts {
		if err := registerProtectedRedirectURIWith(aocClient, h); err != nil {
			failed++
			fmt.Printf("Warning: AOC didn't accept protected-client URIs for %s: %v\n", h, err)
		}
	}
	fmt.Printf("Redirect-URI reconcile done: %d host(s), %d failed\n", len(hosts), failed)
}

// knownProtectedHosts is every hostname this daemon has put behind the
// protected proxy, as outer hostnames, deduplicated and sorted.
//
// Two tables, because neither alone is the whole truth: protected_routes
// holds site services (dashboard, gitops, editor) that are routed but
// not owned, and endpoints holds ACL rows — a hostname can appear in
// either. The --inner twin is not listed separately; it is derived from
// the outer host by protectedClientURIsForHost.
func knownProtectedHosts() ([]string, error) {
	seen := map[string]bool{}
	routes, err := listProtectedRoutes()
	if err != nil {
		return nil, fmt.Errorf("list protected routes: %w", err)
	}
	for _, r := range routes {
		if outer := toOuterHost(r.Hostname); outer != "" {
			seen[outer] = true
		}
	}
	endpoints, err := listAllEndpoints()
	if err != nil {
		return nil, fmt.Errorf("list endpoints: %w", err)
	}
	for _, e := range endpoints {
		if outer := toOuterHost(e.Hostname); outer != "" {
			seen[outer] = true
		}
	}
	out := make([]string, 0, len(seen))
	for h := range seen {
		out = append(out, h)
	}
	sort.Strings(out)
	return out, nil
}
