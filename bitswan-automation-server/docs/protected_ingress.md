# Bailey protected ingress

Bailey turns every workspace endpoint into *protected ingress*: public
traffic is authenticated by a shared oauth2-proxy (`bitswan-protected-proxy`,
backed by Keycloak via the AOC), passes the daemon's access gate, and only
then reaches the workspace service. Each endpoint is fronted by a thin
"Protected by Bitswan Bailey" chrome wrap with a sharing button, and access
is controlled by a per-endpoint ACL with Google-Docs-style sharing.

This document describes the architecture and the staged delivery plan.
**Stage 1 (this document's main subject) is implemented; later stages are
planned.**

## The two-subdomain model

Every protected endpoint exists at two hostnames:

- **outer** — `foo.<domain>`. What the user types into the address bar. The
  daemon serves *only* the chrome-wrap HTML here: a full-viewport iframe plus
  a footer bar ("Protected by Bitswan Bailey", logged-in identity, Share and
  Logout buttons). Nothing else is served on this hostname.
- **inner** — `foo--inner.<domain>`. What the wrap iframe loads. Routes to
  the actual workspace service.

The hostname alone decides which role a request gets. There is no
`Sec-Fetch-Dest` sniffing, no Referer chain, no URL marker — heuristics like
those break for arbitrary third-party apps. Because the outer hostname
physically serves only the wrap, a plain `<a href="/foo">` inside an upstream
app can never stack a second wrap, and the wrap can never end up decorating
content it has no authority over:

- CSP on the **wrap**: `frame-src https://foo--inner.<domain>` — the iframe
  cannot be navigated to any other origin.
- CSP on the **inner content**: `default-src 'self' https://*.<domain>;
  frame-ancestors https://foo.<domain>` — the upstream app cannot pull
  resources from the open internet, and only the paired wrap may embed it.

Both hostnames are covered by the server's `*.<domain>` wildcard certificate
(see `docs/` on DNS-01 certificates), so the inner subdomain needs no extra
ACME traffic.

## Request flow

```
browser ── https ──▶ platform-traefik
                        │  Host route (outer or inner) → bitswan-protected-proxy:80
                        ▼
                    bitswan-protected-proxy        (oauth2-proxy + Keycloak)
                        │  X-Forwarded-Email / X-Forwarded-Groups
                        ▼
                    daemon :9080  "protected gate"
                        │ outer host?  → serve chrome wrap, done
                        │ inner host?  → ACL check (per-endpoint grants)
                        ▼
                    <workspace>__traefik:80  →  service container
                    (bailey--inner.<domain> → daemon :8080 instead)
```

The gate resolves the upstream per request from the hostname — there is no
intermediate `traefik-protected` hop. Route registration records each
protected hostname's upstream in the `protected_routes` table of bailey.db,
which is the gate's primary lookup; a `<workspace>__traefik:80` fallback by
hostname label covers deployments routed before the table existed. The
single shared Keycloak client (`bitswan-protected-client`) carries the
callback URIs of every protected hostname; they are registered idempotently
via the AOC's `GetOrCreateOAuthClient`.

Logout is two-layered: the wrap's Logout button hits oauth2-proxy's
`/oauth2/sign_out` with an `rd=` to Keycloak's RP-initiated logout
(`end_session`), because clearing the proxy cookie alone leaves the
Keycloak SSO session alive and the next request silently signs the user
back in. For the `rd=` to be honoured, the IdP's hostname must be in
oauth2-proxy's `whitelist_domains` alongside the endpoint domain.

Services behind the protected chain must not run their own oauth2-proxy:
both layers would claim `/oauth2/*` on the same hostname and the inner
proxy's callback would be swallowed by the outer one. Bailey is the auth
layer; workspace services should be started with their per-service OAuth
disabled (`OAUTH_ENABLED=false`).

## Per-endpoint ACL

State lives in SQLite at `~/.config/bitswan/bailey.db` (one file, on the
already-persistent config volume):

- `endpoints` — one row per outer hostname, recording the original owner
  (the user whose action created the route: workspace creator, automation
  deployer, …) and a display name.
- `endpoint_grants` — additional principals. `principal_type` is `email` or
  `group` (a Keycloak group path), `role` is `owner` or `access`.
- `access_requests` — pending "Request access" submissions, shown to owners
  in the share dialog.

Resolution order for a request to endpoint `H` by user `U`:

1. `H` not registered → open (the registration call sets the owner; until a
   route carries an owner the gate does not lock anyone out).
2. `U` is the original owner → role `owner`.
3. Any `email` grant matching `U` → that role (`owner` short-circuits).
4. Any `group` grant matching one of `U`'s Keycloak groups → that role.
5. Otherwise → denied. The denied page records an access request and tells
   `U` who owns the endpoint.

`bailey.<domain>` (the management surface) is never gated — its pages apply
their own per-page authorization — but it is registered as an endpoint on
first sign-in so it has an owner ("the server owner") for later stages.

## Sharing UI

Owners see a **Share** button in the wrap footer. It opens a Google-Docs-style
modal (rendered by the wrap layer, above the iframe) that lists the owner row,
all grants, and pending access requests with Approve/Deny. Changes save
instantly through a JSON API; no page reloads.

The same modal component is reused by the standalone share page, so the UI is
identical everywhere:

| Surface | Path (on any protected host) | Who |
|---|---|---|
| Share modal | wrap footer → `__baileyShareOpen()` | owners |
| Share index | `/2fa-gate/share` | any signed-in user (lists endpoints they own) |
| Share page | `/2fa-gate/share/<host>` | owners of `<host>` |
| Share API | `GET/POST/DELETE /2fa-gate/api/share/<host>` | owners of `<host>` |
| Request access | `POST /2fa-gate/request-access/<host>` | any signed-in user |
| Who am I | `/2fa-gate/whoami` | any signed-in user |

The `/2fa-gate` prefix is kept stable across stages — stage 2 mounts the MFA
pages (enrol/challenge/pair) under the same prefix.

## Identity

The gate trusts `X-Forwarded-Email` / `X-Forwarded-Groups` (or the
`X-Auth-Request-*` variants) set by oauth2-proxy upstream. A user is an
*admin* when one of their Keycloak groups is `admin` or ends in `/admin`
(the AOC convention is one `admin` child group per org). Requests without an
identity are passed through — that means the OIDC handshake upstream failed
and the upstream will 401; the gate never invents an identity.

`BAILEY_GATE_DISABLE=1` disables gate enforcement (CI / bring-up escape
hatch); the wrap is still served.

## Delivery stages

The original prototype (bitswan-automation-server PR #340, ~16k lines) is
re-implemented here in stages. Each stage is independently shippable.

### Stage 1 — protected ingress, iframe wrap, ACL sharing (implemented)

Everything described above:

- outer/inner hostname model + strict CSP builders (`inner_host.go`)
- chrome wrap + middleware (`chrome_wrap.go`, `chrome_wrap_middleware.go`)
- nav-sync: inner pages postMessage their path to the wrap so the outer URL
  follows iframe navigation and reloads resume in place (`inner_navsync.go`)
- SQLite ACL store + grant resolution (`bailey_store.go`, `acl.go`)
- share modal/button/pages/API + access requests (`share_modal.go`,
  `acl_share.go`)
- protected gate on `:9080` with per-host upstream routing and inner-CSP
  injection (`protected_gate.go`)
- route registration creates the outer+inner pair and (when the caller
  supplies `owner_email`) the ACL row (`ingress.go`); `workspace init
  --owner` plumbs the creator's email through
- Keycloak callback registration for both subdomains via AOC
  (`protected_redirect.go`, `aoc.GetOrCreateOAuthClient`)

Out of scope for stage 1, deliberately: nothing here provisions the
`bitswan-protected-proxy` container itself. When it is absent the ingress
falls back to single-tier routes (outer → upstream directly) so bare
dev/CI environments keep working without the wrap.

### Stage 2 — second factor (MFA)

TOTP enrolment + challenge for admins, trusted-device pairing for everyone
(pair codes approved from an existing browser), recovery, the
devices/notifications pages, and the bootstrap TOFU path for the first admin.
Inserts as a phase in `enforceProtectedGate` before the ACL check; the
`bailey.db` schema grows `totp_records`, `devices`, `pending_pairs` tables.

### Stage 3 — Bailey management UI

The `bailey.<domain>` admin surface: workspaces page (create/trash from the
browser), endpoints/audit page, server-wide update settings, certificates
page, network map, custom-domain setup. Stage 1 only redirects
`bailey.<domain>/` to the share index.

### Stage 4 — hardening & operations

Split the network-facing gate into its own unprivileged `bailey-proxy`
container (no docker socket; same binary, `BAILEY_MODE=proxy`), the
workspace container-manager socket proxy, fluent-bit/SIEM log shipping, and
the one-shot migration that pairs pre-existing outer-only routes with their
inner subdomains on upgraded servers.
