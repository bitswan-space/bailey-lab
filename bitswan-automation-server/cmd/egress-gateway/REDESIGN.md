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

---

# Egress firewall — intercept EVERY port, not just :80/:443

## The bug

The design above only ever routed `:443`/`:80` to the proxy. Enforce mode then
ended its OUTPUT chain with `-j DROP`, so a BP dialing `smtp.gmail.com:587`
(or Postgres, IMAP, MQTT, SSH …) on staging/production was dropped **in the
kernel of the worker's namespace** — one hop before the proxy, the only
component that writes the attempts log. The connection timed out, nothing was
logged, the host never appeared under "Needs review", and approving it would
not have helped either: the DROP did not consult the allow-list at all. In
dev/live-dev (monitor mode, no DROP) the same call went out directly, also
unlogged. Net effect: the dashboard promised "any other outbound connection is
blocked and logged here", the firewall delivered that for HTTP(S) only.

## Principle (unchanged) + one addition

Enforcement stays **outside the worker's namespace**. What changes is the
interception point: instead of two port-specific DNATs, the worker's namespace
gets a **default route** whose next hop is the proxy container, so every packet
to a non-local destination — whatever the port — arrives at the proxy. Nothing
here is uid-based and the worker still has no `NET_ADMIN`, so it cannot change
the route.

## Design

```
            worker netns (NET_ADMIN dropped; owner-installed)
            ┌────────────────────────────────────────────────────┐
            │ ip route: default via <proxy>                       │  any dst, any port
            │ /etc/resolv.conf: nameserver <proxy>                │  names go past the proxy too
            │ enforce: ACCEPT lo/established/stage-subnet/proxy/  │
            │          ALL TCP (it can only leave via the proxy); │
            │          DROP everything else (no stray UDP)        │
            └───────────────────────────┬────────────────────────┘
                                        │ routed, original ip:port intact
                                        ▼
              proxy container (own netns, NET_ADMIN for ITS OWN rules)
              nat PREROUTING: tcp ! -d <self>  → REDIRECT :18000 (catch-all)
                              :53 -d <self>    → REDIRECT :18053 (DNS forwarder)
              :18000  SO_ORIGINAL_DST → (ip, port)
                        port 443 → SNI path      (as before)
                        port  80 → Host path     (as before)
                        other    → name(s) the worker resolved to ip, from the
                                   DNS forwarder's ip→name notes; IP literal if none
                      → allow-list → enforce: block / monitor: observe → attempts log
                      → dial the EXACT ip:port the worker asked for (no re-resolve)
```

* **Recovering the original destination.** A netfilter `REDIRECT` keeps the
  pre-NAT tuple in conntrack; `getsockopt(SO_ORIGINAL_DST)` on the accepted
  socket returns it. This works because the REDIRECT happens in the proxy's own
  namespace — the DNAT-across-namespaces of the earlier design could not have
  told us the original IP.
* **Recovering the destination NAME.** Only TLS and HTTP name their peer
  in-band. For everything else the proxy is also the worker's resolver: the
  owner rewrites the (shared, bind-mounted) `/etc/resolv.conf` to point at the
  proxy — Docker's `127.0.0.11` is loopback and cannot be DNATed off-host — and
  the proxy forwards each query to its own Docker embedded DNS (same stage
  network, same answers) while remembering every A/AAAA answer as ip → name.
  A catch-all connection to `142.251.127.109:587` is thus attributed to
  `smtp.gmail.com`, goes through the same `decide()` as an SNI would, and a
  block is logged as `{"host":"smtp.gmail.com","port":587,…}` — which the
  dashboard renders as an approvable row with its port.
* **Allow-list semantics.** Rules stay hostnames; an allowed host is allowed on
  every port (the reporter's need: approve `smtp.gmail.com`, and `:587` works).
  Names are matched against ALL names the worker resolved to that IP, most
  recent first; the dial goes to the exact IP the worker resolved, so no
  second resolution can redirect it. Enforce mode still refuses non-public
  destination IPs (the #131 SSRF shape) and logs the refusal.
* **Monitor mode parity.** Monitor mode must not break what worked without a
  firewall: non-TCP traffic (NTP, QUIC, ICMP) now also reaches the proxy via
  the default route; the proxy forwards + masquerades it (`ip_forward=1` from
  the compose entry) instead of filtering it. Enforce mode drops it at the
  source and additionally sets the proxy's FORWARD policy to DROP.
* **Legacy listeners.** `:18443`/`:18080` stay bound so an older owner still
  DNATing to them keeps working during a rolling image update.

## Validation

Unit: `go test ./cmd/egress-gateway/` (DNS cache attribution through CNAME
chains, TTL floor, decide-by-names). Integration
(`BITSWAN_EGRESS_INTEGRATION=1`, docker + network): the allow-listed
`smtp.gmail.com:587` answers its 220 banner from inside the worker, the
non-allow-listed `dns.google:53` is closed without an answer AND appears in the
attempts log as `dns.google` port 53, plus the pre-existing HTTPS / metadata /
IPv6 checks.
