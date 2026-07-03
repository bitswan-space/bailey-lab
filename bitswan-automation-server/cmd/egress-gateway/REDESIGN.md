# Egress firewall — move enforcement OUTSIDE the worker's namespace

## The bug (from the PR #40 security audit, CRIT-1)

Today the egress gateway and the BP worker **share one network namespace**
(`network_mode: service:<gateway>`). The gateway, as root, installs iptables in
that shared netns that REDIRECT `:443/:80` to a local SNI/Host proxy, exempting
the proxy's own uid (`-m owner --uid-owner 8765 -j RETURN/ACCEPT`), then drops
to uid 8765 and runs the proxy **in the same netns**.

The worker has `NET_ADMIN`/`NET_RAW` dropped, so it cannot edit the rules — but
it runs as **root** and the runtime image ships setuid binaries, so it can
`setuid(8765)` and its egress then matches the `--uid-owner 8765` exemption →
**complete bypass of the allow-list, in both monitor and enforce mode**, by the
very code the firewall exists to contain.

We cannot prevent root/suid inside the worker (untrusted code, arbitrary
images). So the exemption must not be **forgeable from the worker's namespace**.

## Principle

The firewall must be enforced **outside the worker's network namespace**, as a
separate network hop the worker cannot impersonate or reconfigure — which is how
it was specified originally. Nothing the worker can do (root, suid, any uid)
should match an exemption, because the proxy is simply **not in its namespace**.

## Design

Split the single shared-netns gateway into two roles:

1. **netns owner + rule installer (privileged, transient).** A small init that
   holds/sets up the worker's netns: it has `NET_ADMIN`, installs the egress
   rules, and then holds the namespace (the worker joins it via
   `network_mode: service:<owner>`, as today). It runs **no proxy**, so there is
   **no uid-8765 process in the worker's netns** to impersonate.

2. **SNI/Host proxy (separate container, separate netns).** Runs on the stage
   network with external connectivity. Unchanged filtering logic (reads SNI,
   checks the allow-list, dials the SNI host) — it already forwards by SNI, so it
   does not need `SO_ORIGINAL_DST`.

Rules in the worker's netns change from *REDIRECT-to-local + uid-exempt* to
**DNAT `:443/:80` → `<proxy-container-ip>:18443/18080`**, with **no uid
exemption**. Because the proxy lives in a different container/netns, there is no
local uid the worker can assume to dodge the DNAT; and with `NET_ADMIN` dropped
the worker cannot alter the rules. Enforce mode keeps default-deny (DNS via the
embedded resolver only — see below — established, the DNAT'd ports), so other
ports/protocols are dropped.

```
            worker netns (NET_ADMIN dropped; root is fine now)
            ┌───────────────────────────────────────────────┐
            │ iptables (installed by the privileged owner):  │
            │   DNAT :443/:80 -> PROXY_IP:18443/18080        │   no uid exemption
            │   enforce: default-deny (DNS/established/...)   │
            └───────────────┬───────────────────────────────┘
                            │ DNAT'd TLS/HTTP
                            ▼
              proxy container (separate netns, stage network)
              SNI/Host allow-list  ──►  allowed origin
```

## Also fold in (same audit, CRIT-1 secondary)

- **DNS tunnelling:** stop blanket-`ACCEPT`ing `:53`. Force DNS through Docker's
  embedded resolver (already DNAT'd) and DROP direct `:53` to arbitrary
  resolvers.
- **RFC1918 blanket ACCEPT:** narrow enforce-mode's RFC1918 allow to the
  worker's own stage subnet rather than all private space (limits lateral
  movement).
- **SNI domain-fronting** is an inherent limit of SNI filtering — document it;
  for high-assurance realms, pin allow-listed hosts to expected IP ranges.

## Implementation steps

1. `internal/infradriver/dockerdriver/entry.go` (`emitGateways` + the worker
   `network_mode`/`cap_drop` block): emit the **owner** (rule installer) and a
   **separate proxy** service; point the worker's netns at the owner; pass the
   proxy IP/alias to the owner so its DNAT target resolves.
2. `cmd/egress-gateway/entrypoint.sh`: DNAT to the proxy instead of REDIRECT;
   drop the uid-8765 exemption; tighten `:53` + RFC1918; the rule-installer path
   no longer `exec`s the proxy.
3. Proxy `main.go`: unchanged filtering; ensure it binds on the stage network
   and forwards by SNI.
4. Golden tests (`testdata/*.golden.yaml`) + the firewall e2e chapter.

## Validation

`go test ./internal/infradriver/...`; bring the stack up and confirm (a) an
allow-listed host is reachable, (b) a non-allow-listed host is blocked, and
(c) **a root worker that `setuid(8765)` is still blocked** (the regression that
motivated this). Then the `bp-lifecycle-e2e` firewall chapter.
