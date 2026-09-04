# Giving Docker enough networks

A Bailey server runs out of Docker networks long before it runs out of anything
else, and when it does, every attempt to create another one fails with:

```
Error response from daemon: all predefined address pools have been fully subnetted
```

New workspaces stop being creatable and deploys stop landing. Nothing is
corrupted — Docker has simply run out of address space to hand out.

## Why it happens

Docker carves each network it creates out of its **default address pools**. With
no configuration, those pools are `172.17.0.0/12` in `/16` slices and
`192.168.0.0/16` in `/20` slices: room for about **31 networks** in total.

A Bailey server uses several per workspace — `<workspace>-dev`,
`-staging`, `-production`, `<workspace>-agent`, plus the shared
`bitswan_network` and the per-project networks Compose creates. Five or six
workspaces is enough to exhaust the defaults on a stock Docker.

## The fix

Give Docker a bigger pool in `/etc/docker/daemon.json`:

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
  containers, which is ample for one workspace stage. If you expect a single
  stage to run more than that, use a larger subnet — `"size": 24` gives 4096
  networks of 254 addresses.
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
handle the condition somewhere new.
