# How the ingress gets its TLS certificates

Every public hostname this server serves needs a certificate. Which mechanism
supplies it is a single server-level setting — the *TLS mode* — resolved in one
place (`internal/daemon/tls_mode.go`) and applied to every route the daemon
registers.

```
bitswan ingress tls              # what mode is this server on, and is anything wrong
bitswan ingress tls manual       # switch mode, and move existing routes onto it
```

## The modes

| Mode | Certificates from | Renewal | Needs |
| --- | --- | --- | --- |
| `aoc-dns` (default) | Let's Encrypt, DNS-01 solved through the AOC's zone | automatic | the server's hostnames to live in a zone the AOC controls |
| `manual` | certificates you install | **yours to do** | nothing; no CA is contacted |

`aoc-dns` is the default and is what every server registered before this setting
existed runs. It works on a server with no public inbound route at all: the CA
reads a TXT record from DNS and never connects to the server, so an A record
holding a private address is fine.

`manual` is for the case `aoc-dns` cannot cover — an internal CA, a corporate
PKI, or DNS the operator keeps in-house on a provider that cannot be automated.
In this mode Traefik's static configuration contains **no** ACME resolvers at
all, not even the HTTP-01 one, so nothing on the server can start a certificate
order that could never complete.

## Why it is one setting and not several bypasses

Before this, "how do we get a certificate" was decided in two unrelated places:
a route registered with `--mkcert` or `--certs-dir` skipped ACME, and everything
else asked `certResolverForHostname`, which chose between a DNS-01 wildcard and a
per-host HTTP-01 certificate. That is fine with exactly one automatic mechanism.
With more than one, each new backend would add its own bypass in its own place,
and "which routes are actually on ACME" would become a question with several
answers.

The route-level bypasses stay exactly as they were: a route with a certificate
installed for its own hostname is manual **by intent**, and no mode switch moves
it. That distinction is what makes the switch safe to re-run — see
`traefikapi.SetWildcardCertResolver`.

## Switching mode on a server that is already serving traffic

A switch does two things, and both are needed or the server is left half-changed:

1. **Traefik's static config is rewritten** — which resolvers exist at all — and
   the container is recreated. This is the same drift-detection path the daemon
   uses on every boot.
2. **The live route table is reconciled.** Every route under the server's domain
   is moved onto the new backend. Without this a switch would apply only to
   routes registered afterwards, and the routes already serving traffic would
   keep asking for certificates the new mode cannot supply.

The reconcile also runs on every ingress init, so a route added while the server
was on a different mode is corrected rather than left behind.

### What a switch does not do

- **Switching away from a CA does not revoke or delete anything.** Certificates
  already in Traefik's ACME store keep being served until they expire; they just
  stop being renewed. That expiry window is the time you have to install your
  own.
- **Switching back to a CA does not remove installed certificates.** Traefik
  serves a matching certificate from its file store in preference to an ACME one,
  so a hostname with an installed certificate keeps being served that certificate
  even in an ACME mode. `bitswan ingress tls` reports installed certificates
  precisely so this is visible rather than mysterious.
- **Published public endpoints need a CA.** A published public host lives in the
  AOC's own `*.public.<aoc-id>` namespace and can only be certified through the
  AOC's zone, so publishing is refused — with that reason — in a mode that
  contacts no CA.
