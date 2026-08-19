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
| `custom-dns` | Let's Encrypt, DNS-01 solved against your own DNS provider | automatic | a lego-supported provider and a token scoped to the zone |
| `manual` | certificates you install | **yours to do** | nothing; no CA is contacted |

`aoc-dns` is the default and is what every server registered before this setting
existed runs. It works on a server with no public inbound route at all: the CA
reads a TXT record from DNS and never connects to the server, so an A record
holding a private address is fine.

It only works on a domain **the AOC's DNS controls**, though. The ACME bridge
writes into the AOC's own hosted zone and rejects anything outside it, so on a
bring-your-own domain every DNS-01 challenge fails — and fails as a 502 from a
DNS endpoint, minutes into a registration, naming nothing about the cause. The
AOC reports whether it manages a domain (`dns_managed`), and the daemon records
that at registration:

- **managed** — the shared `*.<domain>` wildcard, as always.
- **not managed** — no wildcard is requested at all. Hosts fall back to per-host
  HTTP-01, which is what that flag is documented to select and which works on a
  publicly reachable server. Selecting `aoc-dns` on such a domain is refused
  outright, `bitswan ingress tls` says so, and `register` says so at the terminal.
- **never reported** — an older AOC, or a server registered before this was
  recorded. Treated as managed, i.e. exactly the previous behaviour: reading it
  as "not managed" would take every existing server off the wildcard it is
  already using.

If your domain is not AOC-managed and the server has no public inbound route,
HTTP-01 cannot work either — that is the case `custom-dns` and `manual` exist
for. The value is captured at registration, so a domain that later changes hands
needs a re-register or an explicit mode.

`custom-dns` is for a customer who keeps their own DNS. The AOC's bridge has no
zone to write to there, but nothing else about the certificate story changes: the
same CA, the same challenge type, automatic renewal, and a registration
verification that keeps working unchanged. Prefer it over `manual` whenever the
provider is one lego supports — which is most of them.

```
bitswan ingress tls custom-dns --dns-provider cloudflare     --dns-credential CF_DNS_API_TOKEN=…
```

The provider id is a [lego DNS provider](https://go-acme.github.io/lego/dns/) id;
the credentials are the environment variables that provider reads, and you can
repeat `--dns-credential` for each. Two deliberate differences from the AOC
bridge: lego's propagation pre-flight stays **on** (the bridge disables it only
because it already waits for the record to be live, and because a NAT'd server
often cannot reach arbitrary nameservers on port 53), and the resolver keeps the
same name and ACME storage as `aoc-dns` — so switching between the two DNS-01
modes re-uses the existing account and certificates and touches no routes.

### Where the credentials live

In the daemon's config volume, and rendered into Traefik's compose environment
(mode 0600) — because Traefik is what consumes them, and they have to survive the
daemon container being recreated. That file is part of a server backup, so a
restic snapshot of this server contains them, encrypted with a key that is never
escrowed. Scope the token to the zone it needs, as you would for any ACME client.

`bitswan ingress tls` reports the provider and the credential **names**; values
are never returned by the API, printed, or logged.

### Installing your own certificates (`manual`)

The mode and the certificate can be settled during registration, which is the
order you want: set afterwards, Traefik first comes up on the default, opens an
ACME order this server can never complete, and registration fails on a timeout
rather than on a choice you already made.

```
bitswan register --name … --otp … --server-id … \
    --tls-mode manual --certs-dir /path/to/certs
```

`--certs-dir` installs a wildcard for the domain the AOC assigns, so you do not
have to know the hostnames in advance. On an already-registered server:

```
# One wildcard covers everything this server serves:
bitswan ingress tls manual
bitswan ingress tls install-cert --domain acme.example.com --certs-dir /path/to/certs

# ...or a single hostname:
bitswan ingress tls install-cert --hostname bailey.acme.example.com --certs-dir /path

# Moving back onto a CA later — an installed certificate shadows an ACME one:
bitswan ingress tls remove-cert --hostname '*.acme.example.com'
bitswan ingress tls aoc-dns
```

Prefer `--domain`. It installs one wildcard for `*.<domain>`, which is what the
hostnames actually need: several are registered by the daemon rather than by you
(the Bailey console and its `--inner` twin, the device-trust onboarding host, the
docs host) and every workspace adds more, so installing per hostname means
chasing a set you do not control.

**The directory is read by content, not by filename.** Whatever your issuer
called the files — `fullchain.pem`/`privkey.pem`, `tls.crt`/`tls.key`,
`cert.pem`/`key.pem`, or one combined file — the chain and key are found by their
PEM blocks, and the full chain is preferred over a bare leaf.

**The certificate is checked before anything is written**: that the key belongs to
it, that it covers the name being installed, and that it is in date. Each of those
otherwise fails invisibly, at handshake time, long after the install said "ok".

Two things worth knowing:

- A wildcard does not cover the bare domain. If your certificate has no apex SAN,
  the install says so — any route on the domain itself will not be served.
- Paths are yours, not the daemon's. The CLI runs on the host and the daemon in a
  container with the host root at `/host`, so an absolute host path is resolved
  through it automatically. Relative paths are refused — they would resolve
  against the daemon, not your shell.
- **Nothing renews these.** `bitswan ingress tls` reports the expiry of every
  installed certificate, the daemon warns at boot within 30 days of expiry, and
  re-running `install-cert` with the replacement is the renewal (Traefik picks it
  up without a restart).

### Registration on a privately-trusted certificate

`bitswan register` finishes by fetching the server's own public URL and checking
three things: that it answers, that the certificate validates against the public
CA roots, and that the certificate is byte-for-byte the one local Traefik holds.
An internal CA is by definition not in the public root store, so the second check
can never pass in `manual` mode — requiring it would make registration impossible
on exactly the servers this mode exists for.

So in a mode that contacts no CA, the check falls back to the first and third
alone and reports the trust as *private*. The third property is the one that
actually detects interception, and it does not depend on who signed anything.
`register` says plainly that the certificate is not publicly trusted and that
browsers will warn until the CA is installed on each machine.

And when no certificate can be obtained at all, registration says so at once
instead of polling. If the mode asks a CA that cannot validate this server — its
DNS-01 challenge is written in a zone the AOC does not manage, *and* HTTP-01 has
no inbound route to use — the answer is already known, so the eight-minute wait
is skipped and the message names the backends that would work. A publicly
reachable server on an unmanaged domain still waits, because there the per-host
HTTP-01 fallback genuinely can succeed.

`manual` is for the case neither DNS-01 mode can cover — an internal CA, a corporate
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
