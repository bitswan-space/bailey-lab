# Bitswan Bailey — Security Assessment

**Scope:** the `bailey-lab` monorepo on `feat/infra-driver` — automation-server daemon (Go), gitops API (Python/FastAPI), the per-workspace infra-driver (Go), workspace-dashboard (Fastify + React), egress firewall gateway.
**Date:** 2026-06-24.
**Method:** source review across four domains — the infra-driver trust boundary, the gitops API / identity-role / secrets, daemon host-isolation, and the egress firewall + network isolation.

## Threat model

The **control plane is the Trusted Computing Base (TCB)**: the automation-server **daemon**, the per-workspace **infra-driver**, **gitops**, and the **dashboard** legitimately hold host/Docker privilege to do their jobs. Defending the host against one of *them* being compromised is out of scope.

The **untrusted attacker** is **code running inside a deployed automation** — an authenticated workspace member's container, co-resident on the internal network. The security goals are:

1. **Containment** — untrusted automation code cannot reach the control plane, escape the egress firewall, or cross to other tenants.
2. **Tenant isolation** — one workspace cannot reach another's containers/data/network.
3. **RBAC** — a non-admin member cannot perform admin-only / production-impacting actions.

## Executive summary

Cryptographic and data-handling fundamentals are strong: AES-256-GCM secret storage with per-encrypt nonces and `0o600` files, constant-time token comparison in the driver, careful path-traversal confinement, and safe root-side archive extraction/chown in the driver.

The driver boundary is sound on the axes that matter: its workspace scoping is request-independent and cannot be overridden; it is token-authenticated (and refuses to serve without a token), not exposed to the host, and unreachable by automation containers; it compiles a constrained compose (a deployment record cannot inject host bind-mounts, host networking, or extra container networks); production secrets are gated to admin/auditor via the daemon's authoritative role store; and per-(workspace, realm) plus cross-workspace network isolation holds.

**The one CRITICAL finding is the egress firewall: an untrusted worker can bypass it entirely.** Below that are a tenant-granularity isolation gap and two low-severity hardening items.

## Findings

### CRITICAL

#### CRIT-1 — The egress firewall is bypassable by the worker it contains
**`[CODE]`** · gateway `cmd/egress-gateway/entrypoint.sh:23,34,65`; worker emission `internal/infradriver/dockerdriver/entry.go:291-300`; the automation runtime image has no `USER`.

The automation worker shares the egress gateway's network namespace (`network_mode: service:<gateway>`), and the gateway exempts the proxy's uid 8765 from interception (`-m owner --uid-owner 8765 -j RETURN/ACCEPT`) in **both** monitor and enforce mode. The worker has `NET_ADMIN`/`NET_RAW` dropped — so it cannot edit the rules — but it runs as **root** with setuid binaries available, so it `setuid(8765)` and its egress then matches the exemption. This is a **complete bypass of the SNI/Host allow-list and the GDPR attempt-logging**, performed by the very code the firewall exists to contain. Root/suid cannot be prevented inside an untrusted worker image, so the exemption must not live in the worker's namespace.

Secondary egress weaknesses in the same component:
- **DNS tunnelling:** enforce mode unconditionally `ACCEPT`s `:53` (`entrypoint.sh:35-36`), allowing data exfiltration / C2 over DNS to any resolver.
- **SNI domain-fronting:** the proxy dials the SNI host and cannot see the (encrypted) inner Host (`sni.go`, `main.go:140-159`), so an allow-listed CDN domain can front to an arbitrary same-CDN origin.
- **Blanket RFC1918 ACCEPT** in enforce mode (`entrypoint.sh:38-40`) leaves intra-network lateral movement unconstrained.

**Fix:** enforce the firewall **outside** the worker's network namespace — a separate proxy container with the worker's egress DNAT'd to it, so no uid in the worker's namespace is exempt and the worker (no `NET_ADMIN`) cannot reach or reconfigure the rules. Force DNS through the embedded resolver and drop direct `:53`; narrow the RFC1918 accept to the worker's own stage subnet; for high-assurance realms pin allow-listed hosts to expected IP ranges. *(In progress — see the egress redesign PR.)*

### MEDIUM

#### MED-1 — Tenant isolation is per-(workspace, realm), not per-BP
**`[CODE]`** · `dockerdriver/compile.go:42-44`, `entry.go:344-351`.

All automations of all business processes mapped to the same realm share one `<ws>-<realm>` bridge network, and enforce-mode egress blanket-`ACCEPT`s RFC1918 — so different BPs within a workspace are not isolated from each other or from shared infra (Postgres/MinIO). Cross-workspace isolation and automation→control-plane isolation both hold; the gap is strictly between BPs inside one workspace. **Fix (if per-BP isolation is intended):** key networks on (workspace, realm, BP); otherwise document that the trust boundary is the realm and BPs in a workspace are mutually trusted.

### LOW

- **LOW-1 — Non-constant-time secret comparisons.** gitops `verify_token`/`verify_agent_token` use `!=` (`dependencies.py:8-15`; `agent.py:94-99`) and the git-http auth uses `in` set membership (`git_http.py:36-73`). Network-local, high-entropy secret → marginal, but fix with `hmac.compare_digest` and reject empty/unset secrets.
- **LOW-2 — `decrypt_secrets` fails silently.** It returns `{}` on any error including a GCM tag mismatch (`bp_secrets.py:72-84`), so a tampered or wrong-key blob deploys with *no* secrets rather than failing loudly. Distinguish "absent" from "undecryptable" and raise on tag failure.

## Controls assessed as adequate

- **Driver request-scoping** — authoritative workspace from the `serve` flag / bare-repo git config, never the request; `/v1` primitives discard any client `ctx`; `ContainerList` forces its own workspace filter; cross-workspace `exec` refusal is unit-tested. (`cmd/infradriver/*`, `dockerdriver/dockerdriver.go:45-95`)
- **Driver transport** — a dedicated token (distinct from the gitops API secret) guards the whole mux including git receive-pack (constant-time compare); the driver refuses to serve if no token is configured; `:9090` is not host-published and the driver is on `bitswan_network` only; the token is not present in automation-container env. (`internal/infradriver/{githttp,server}.go`, `cmd/infradriver/infradriver.go`, `dockercompose.go`)
- **No compose passthrough** — the compiler emits only compiler-constructed compose; `volumes`/`network_mode`/`networks`/`ports`/`devices`/`container_name` are not fields of the deployment record, so a pushed `bitswan.yaml` cannot inject host bind-mounts or extra networks. (`dockerdriver/entry.go`, `model.go`)
- **Production-secret RBAC** — `read_bp_secrets` redacts the production realm unless the caller resolves to admin/auditor in the daemon's authoritative role store; the role is never client-asserted and lookup failure fails closed. (`automation_service.py`, `routes/automations.py`, dashboard `lib/user.ts`)
- **Identity** — the dashboard derives identity from the gate-verified `X-Forwarded-Email` and resolves the role server-side via the daemon. (`dashboard server/src/lib/user.ts:26-74`)
- **Network isolation** — automations attach only to `<ws>-<realm>` bridges; nothing attaches them to `bitswan_network`, so they cannot reach the driver/daemon/gitops/dashboard at L3; workspace networks are namespaced per workspace. (`dockerdriver/{compile,entry}.go`)
- **Ingress admin APIs not host-published** — neither ingress proxy publishes its admin/API port to the host. Traefik's `api.insecure` API/dashboard (:8080) leaks the full routing topology and serves the dashboard; Caddy's admin API (:2019) allows full reconfiguration. Both are reachable only in-network (`traefik:8080` / `<ws>__traefik:8080` / `caddy:2019` on `bitswan_network`, which automations can't join), so the proxies publish only `:80`/`:443`. (`dockercompose.go`)
- **Root-side extraction/chown** in the driver's apply uses `git archive | tar` (no `..`/absolute paths) and `filepath.Walk` + `Lchown` (no symlink following). (`cmd/infradriver/apply.go:113-193`)
- **Secrets at rest** — AES-256-GCM, 32-byte random key, fresh 12-byte nonce per encrypt, `0o600` key + derived env files. (`bp_secrets.py`)

## Residual / lower-priority notes

- gitops `_require_fw_role` (firewall/promote/rollback) still reads `role` from the request body; today the only token-holder is the trusted dashboard, which injects the daemon-resolved role, so this is defense-in-depth — resolve the role inside gitops to remove the residual trust.
- `BITSWAN_DEPLOY_REMOTE` embeds the driver token in the URL (process argv / possible git error output); prefer a credential helper / header.
- `/services/*` `docker cp` (minio/snapshot tarball streaming) is served by the driver's workspace-scoped archive primitive (`/v1/containers/copy-out|copy-in`, TAR-streamed), so gitops needs no Docker access for it — same trust boundary as `exec`/`stop`.
