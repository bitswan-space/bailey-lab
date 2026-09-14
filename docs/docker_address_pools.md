# Giving Docker enough networks

A Bailey server used to run out of Docker networks long before it ran out of
anything else, and when it did, every attempt to create another one failed with:

```
Error response from daemon: all predefined address pools have been fully subnetted
```

New workspaces stopped being creatable and deploys stopped landing. Nothing was
corrupted — Docker had simply run out of address space to hand out.

## Why it happened

Docker carves each network it creates out of its **default address pools**. With
no configuration, those pools are `172.17.0.0/12` in `/16` slices and
`192.168.0.0/16` in `/20` slices: room for about **31 networks** in total.

A Bailey server uses several per workspace — `<workspace>-dev`,
`-staging`, `-production`, `<workspace>-agent`, plus the shared
`bitswan_network` and the per-project networks Compose creates. Five or six
workspaces was enough to exhaust the defaults on a stock Docker.

The waste was in the sizing. A network holding one workspace's automations for
one stage was given a whole `/16` — 65534 addresses — because a
`docker network create` with no subnet takes whatever the pool hands out.

## What Bailey does now

Bailey allocates the networks it creates from a range of its own and passes an
explicit `--subnet`. Docker only draws from `default-address-pools` when a create
arrives *without* a subnet, so these networks no longer touch the pools at all.

The default range is `10.128.0.0/12`, sliced per role:

| Role | Size | Holds |
| --- | --- | --- |
| `platform` (`bitswan_network`) | `/20` | every workspace's gitops, the ingress, the proxies |
| `stage` (`<ws>-dev`, `-staging`, `-production`) | `/22` | one stage's automations, their egress gateways and infra — and, in the dev realm, every live-dev copy (1022 addresses) |
| `agent` (`<ws>-agent`) | `/28` | the coding agent and gitops |
| `infra` (build proxy) | `/24` | the two package proxies, plus every concurrent image build |

That is 1024 stage-sized networks in the default base, against about 31 networks
of any kind before — roughly 340 workspaces at three stage networks each.

Stage networks are the generous ones on purpose. The dev realm carries not just
the dev stage but every **live-dev copy**: `BITSWAN_MAX_LIVE_DEV` instances
(default 15), each costing an egress gateway, its proxy, and a frontend that
keeps its own network namespace under the monitor gateway dev gets. That cap is
an operator knob, so the network should not be what stops someone raising it — a
`/24` would fill at about 80 instances, a `/22` leaves roughly ten times the
default cap in hand. Allocation reads the daemon's existing networks
each time rather than keeping a ledger, so removing a network by hand needs no
reconciliation, and it steers around the routes already on the host so a new
subnet does not collide with a VPN or VPC leg.

`10.128.0.0/12` is deliberately clear of the `10.0.0.0/12` the AOC writes into
`default-address-pools` when it provisions a server: both mechanisms are live
there and must not hand out the same addresses.

Override the range with `BITSWAN_NETWORK_BASE` if your network already uses it:

```bash
BITSWAN_NETWORK_BASE=172.30.0.0/15
```

Networks that already exist are never touched. Docker keeps their addresses in
its local store, so nothing renumbers on upgrade; the old `/16`s come back as
their workspaces are removed.

### Finding Bailey's networks

Everything Bailey creates is labelled, which is what makes capacity and orphans
answerable:

```bash
docker network ls --filter label=bitswan.managed=true
docker network ls --filter label=bitswan.workspace=<workspace>
```

`bitswan.role` and `bitswan.stage` are set too, where they apply.

## When the default pools still matter

Networks that **Compose** creates rather than Bailey still come from the default
pools — `protected-proxy-session`, `bitswan_external_testing`, and any
`<project>_default`. That is a handful per server rather than four per
workspace, so the defaults are no longer the binding constraint, but a server
that was already close to the edge can still meet them.

Bailey also falls back to an unqualified create if it cannot allocate — no
daemon to ask, or a `BITSWAN_NETWORK_BASE` that is full or malformed — because a
network from the default pools beats no network at all.

In either case, give Docker a bigger pool in `/etc/docker/daemon.json`:

```json
{
  "default-address-pools": [
    { "base": "10.0.0.0/12", "size": 27 }
  ]
}
```

Then restart Docker:

```bash
systemctl restart docker
```

`10.0.0.0/12` sliced into `/27`s is 32768 networks of 32 addresses each (30 of
them usable by containers) — far more networks than a server will ever ask for.

Three things worth knowing before you apply it:

- **Pick a base that doesn't collide.** `10.0.0.0/12` is a good default, but not
  if the VPC, VPN, or office network this server sits on already uses that
  range. Any private range works; what matters is that it is yours.
- **`size` trades networks against containers-per-network.** A `/27` holds 30
  containers. Unlike Bailey's own allocation, this is one size for *every*
  network on the host — if a single Compose project needs more than that, use
  `"size": 24` for 4096 networks of 254 addresses.
- **Restarting Docker restarts containers.** Everything on the server goes down
  briefly and comes back. Networks that already exist keep the addresses they
  were given — the new pool only applies to the next network Docker creates —
  so there is nothing to migrate.

## Servers we provision

Servers created through the AOC's cloud-server flow get this configuration
before Docker is installed, so the daemon comes up with the larger pool already
in place and never needs a restart. This document is for servers Bailey was
installed onto, where the Docker configuration is the operator's own.

## When it happens anyway

The daemon reports the exhaustion wherever it hits it — creating a workspace,
reconciling stage networks, or bringing a deployment up — and the error it
returns carries the JSON above and the restart command, so an operator can act
on it without finding this page first. `internal/docker/address_pools.go` holds
that text; `AddressPoolsExhaustedError` is what to match on if you need to
handle the condition somewhere new. `internal/docker/subnets.go` holds the
allocator, the per-role sizes, and the labels.
