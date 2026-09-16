package daemon

import "github.com/bitswan-space/bitswan-workspaces/internal/config"

// Who terminates TLS for this server's public hostnames.
//
// Everywhere else in the product the answer is "we do": Traefik holds the
// certificate, and the daemon proves it by fetching its own public URL and
// checking the served leaf is byte-for-byte the one Traefik holds
// (verifyPublicEndpoint). That check is the only thing standing between an
// operator and a silently intercepted deployment, and it is deliberately
// universal — a directly-addressed server can be MITM'd just as a relayed one
// can. Even the relay preserves it, because the relay is an SNI passthrough and
// never sees plaintext.
//
// There is one legitimate deployment where it cannot hold. Some organisations
// will not delegate TLS: every hostname they own terminates on THEIR reverse
// proxy, which holds the certificate, rotates it on their schedule, and
// re-encrypts to the backend. `*.bitswan.example.com` resolves to that proxy,
// the proxy dials our Traefik, and what the world is served is the proxy's
// certificate — not ours, permanently, by design.
//
// The identity check then fails forever, and it fails in the two worst possible
// ways: `register` spends eight minutes rediscovering it and exits with an error
// on a server that is actually working, and the periodic self-check records
// tls_selfcheck_failed into the audit log (and any SIEM it is forwarded to)
// every six hours for a condition the operator set up on purpose. A security
// alarm that is always on is an alarm nobody reads.
//
// So the operator declares the topology, once, and the check is narrowed rather
// than switched off: reachability is still verified, and the daemon still says
// out loud — at registration and in `bitswan ingress tls` — which property it is
// no longer able to prove.
//
// # Why this is not derived from the TLS mode
//
// It looks like it could be: a server on `manual` mode, marked private, is very
// often exactly this topology. Deriving it would be wrong, and wrong in the
// direction that costs security. `manual` says where CERTIFICATES come from;
// this says who TERMINATES. A VPN-only server holding its own internal-CA
// certificates is manual AND private AND fully self-terminating — the identity
// check works there, catches a compromised VPN endpoint, and must keep running.
// Inferring the declaration from adjacent facts would disarm that check for a
// population of servers whose operators never asked for it, and they would have
// no way to know. tls_mode.go argues the same thing about certificate backends
// ("why it is one setting and not several bypasses"); this is the same argument
// about a different question.

// externalTLSTermination reports whether the operator has declared that a proxy
// they run — and we do not — terminates TLS in front of this server.
//
// Unreadable config is "no": the security check stays at full strength unless
// something we can actually read says it must not. An error here is a reason to
// keep checking, not a reason to stop.
func externalTLSTermination() bool {
	return config.NewAutomationServerConfig().GetExternalTLSTermination()
}
