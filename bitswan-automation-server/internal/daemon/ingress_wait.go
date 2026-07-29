package daemon

import (
	"fmt"
	"time"
)

// Waiting for our own ingress to start serving.
//
// This exists because of a race that cost a recovery its protected proxy and its
// relay tunnel. At boot the daemon fires several AOC-dependent steps —
// startRelayTunnel (synchronous, t=0), reconcileProtectedProxyConfig (t=0) and
// the backup self-enable (t=0) — while initTraefikIngress only *begins* creating
// the Traefik container at t+2s. Every one of those calls is single-shot with no
// retry (fetchRelayInfoFromAOC is one GET, and AOCClient.sendRequest is
// documented as having no retry logic), so losing the race means the step stays
// undone until the next daemon restart. The 2s/3s sleeps in Run() were the only
// sequencing that existed.
//
// Worse on a *recovered* server, where the AOC itself may be reached through the
// very ingress being restored: the calls fail with "connection refused" and the
// server comes up with no auth wrap on any endpoint.
//
// The probe is deliberately the cheapest honest one: complete a TLS handshake
// against our own Traefik for a hostname it should serve. That is already how
// verifyPublicEndpoint distinguishes "local ingress not started yet" from a real
// mismatch, so this is the same signal, factored out.

// ingressWaitDefault is generous enough for a cold Traefik container to start
// and load its dynamic config, and short enough that a genuinely broken ingress
// doesn't stall a boot for minutes.
const ingressWaitDefault = 90 * time.Second

// ingressWaitPoll is a var so tests need not wait seconds per attempt.
var ingressWaitPoll = 2 * time.Second

// ingressProbe is a var so tests need no TLS listener.
var ingressProbe = func(host string) error {
	_, err := fetchServedLeaf(relayLocalTarget(), host)
	return err
}

// waitForIngress blocks until our local Traefik completes a TLS handshake for
// host, or the timeout expires.
//
// A timeout is returned as an error but is NOT fatal to callers: an ingress that
// isn't serving yet is a reason to log and carry on (the steps downstream are
// idempotent and retried elsewhere), not a reason to abort a boot. Callers that
// genuinely cannot proceed — like a disaster recovery about to provision the
// protected proxy — surface it as a failed step instead.
func waitForIngress(host string, timeout time.Duration) error {
	if host == "" {
		return fmt.Errorf("no hostname to probe (server has no domain configured)")
	}
	if timeout <= 0 {
		timeout = ingressWaitDefault
	}

	deadline := time.Now().Add(timeout)
	var lastErr error
	for {
		if lastErr = ingressProbe(host); lastErr == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("ingress did not start serving %s within %s: %w",
				host, timeout.Round(time.Second), lastErr)
		}
		time.Sleep(ingressWaitPoll)
	}
}

// waitForOwnIngress waits on this server's Bailey hostname, the one endpoint
// every configured server has. Returns immediately when no domain is set —
// ingress is not configured at all in that case, so there is nothing to wait for
// and nothing downstream that needs it.
func (s *Server) waitForOwnIngress(timeout time.Duration) error {
	domain := protectedHostnameDomain()
	if domain == "" {
		return nil
	}
	return waitForIngress("bailey."+domain, timeout)
}
