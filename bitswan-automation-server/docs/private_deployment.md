# Running Bailey on a private network (VPN / ZTNA / LAN)

A *private* automation server is one that is reached over a network its operator
controls — an OpenVPN or WireGuard overlay, a ZTNA product, or a plain on-prem
LAN — instead of over the public internet. This document is the deployment
runbook for that topology and the reasoning behind each step.

## Why this needs an explicit mode

Two defaults in the platform actively work against a private deployment, and
neither is a bug:

1. **The AOC points a server's wildcard record at its reverse-proxy relay by
   default.** It cannot reliably probe whether a server has a working public
   inbound route (incoming requests are port-published into the AOC's container
   network by Docker, which rewrites the source address), so the relay is the
   uniform, safe choice for NAT'd *and* public servers. On a private server it is
   the wrong choice in a specific and severe way: the relay republishes the
   server on the public internet.
2. **Docker publishes container ports on every interface, and its DNAT rules are
   installed ahead of the host INPUT chain.** A `ufw` or `nftables` rule cannot
   close a published port, and DNS pointing somewhere else is not access control
   — anyone who scans the public address with the right SNI reaches the ingress.

`register --private` addresses both. It is a hard local pin, not a hint: the
daemon refuses to dial the relay while it is set, whatever the AOC reports, so a
daemon restart cannot re-expose the server even if the AOC's record for it is
wrong or gets changed later.

## Registering

```
bitswan register \
  --name acme-prod --server-id <id> --otp <otp> \
  --private --private-address 10.8.0.7
```

- `--private-address` is the address clients reach this server on. The AOC
  publishes it in DNS instead of pointing the record at the relay. It is
  required: the AOC has no way to discover it.
- The ingress is bound to that address automatically — `:80`/`:443` are published
  on it and nowhere else. Pass `--bind-address 0.0.0.0` to opt out (for example
  when the VM has no public interface at all and you would rather not couple
  Traefik's startup to the tunnel), or `--bind-address <other>` when clients
  arrive on a different address than the one DNS advertises.

An already-registered server can be narrowed after the fact:

```
bitswan ingress init --bind-address 10.8.0.7
```

This persists the address and recreates Traefik with the new publish.

## Before you register

**Pin Docker's address pools.** Set `default-address-pools` in
`/etc/docker/daemon.json` *before* the first deploy. Bailey allocates
`bitswan_network`, the per-stage bridges and the workspace networks from Docker's
default 172.17–172.31 pools, and the sub-Traefik ingress ACL is derived from
`bitswan_network`'s actual subnet. If the VPN pushes routes that overlap those
ranges you get containers with no route out and an ACL matching the wrong subnet
— cheap to prevent, expensive to diagnose later.

**Check egress, don't assume it.** Outbound is still required: the AOC API,
**Let's Encrypt directly** (Traefik/lego talks to `acme-v02.api.letsencrypt.org`
itself), image registries, and git remotes. If the client config uses
`redirect-gateway def1`, all of that leaves through the concentrator — confirm
that path exists and is not HTTP-proxy-only. The DNS-01 challenge itself is
in-cluster (Traefik → the daemon's bridge → the AOC), so it needs no inbound.

**Fix the MTU.** A tun device at 1500 with fragmentation disabled stalls large
TLS records and websocket frames, and the dashboard's coding-agent terminal and
the live-dev HMR sockets both ride websockets over this path. Set
`tun-mtu`/`mssfix` on the VPN, or clamp MSS on the VM. The symptom if you skip
it: pages load, then hang on anything large.

**Make the name resolve on the server too, not just on clients.** Registration
finishes by fetching this server's own public Bailey URL and checking the
certificate it is served is byte-for-byte the one local Traefik holds. That dial
happens *from the server*, so the box itself has to resolve
`bailey.<domain>` to the private address and reach it.

## Certificates

Private and "no certificate" are unrelated problems. With DNS-01, Let's Encrypt
never connects to the server: Traefik asks the daemon's bridge, the daemon asks
the AOC, the AOC writes the challenge TXT into its zone, and the CA reads DNS. A
server with no public inbound route — whose A record holds an RFC1918 address —
still gets a real, publicly-trusted, auto-renewing wildcard certificate.

That holds as long as the AOC controls the zone the server's hostnames live in
(a `bswn.io` subdomain, or a customer subdomain delegated to it). If the
customer keeps DNS in-house, the DNS-01 bridge has no zone to write to and this
path does not work; see the configurable-certificates work that follows this
change.

## Operational notes

- **Binding to a VPN address fails closed.** Docker cannot create the container
  until the address exists, so if the tunnel is down at boot Traefik will not
  start. Its restart policy retries, so a server whose tunnel comes up late
  recovers on its own. The daemon logs an explicit diagnosis when the configured
  address is not present on any interface, rather than leaving you with Docker's
  "cannot assign requested address".
- **Disaster recovery keeps the position but not the address.** The restored
  config still says the server is private; the address belonged to the machine
  that was lost. Pass `--private-address` to `bitswan recover server` so the
  replacement re-points both the ingress publish and the AOC's DNS record.
  Without it the recovery stays private, does not republish the dead address, and
  tells you DNS still needs pointing.
- **A resolver in front of the AOC's zone may strip the answer.** Some corporate
  resolvers apply DNS-rebinding protection and drop RFC1918 addresses returned
  from public zones. Route53 serves it happily; test the customer's resolver
  early rather than during the deployment.
- **Published public endpoints do not work on a private server.** The
  `*.public.<aoc-id>` namespace resolves only through the relay, so a URL
  published for an outside audience will not resolve. This is tracked separately;
  today the affordance is simply unavailable in practice.
