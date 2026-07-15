# Go backend worker

A Go HTTP backend that runs behind the Bitswan platform's ingress. It ships
with a Postgres + MinIO example app (per-user counter, image gallery) and —
more importantly — the platform's **identity & admin contract** wired up
correctly, so role-gated features can be built on it without guesswork.

## Identity & admin contract

### Where identity comes from

Identity is resolved from the **verified Bearer token only**. The platform's
gate strips forwarded identity headers (`X-Forwarded-Email` etc.) for user
apps by design — do not read them; do not invent header-based identity modes.

The flow end to end:

1. The frontend fetches `/oauth2/auth` (oauth2-proxy) and reads the access
   token from the `X-Auth-Request-Access-Token` response header.
2. It sends API requests with `Authorization: Bearer <token>`.
3. This backend validates the token's RSA signature against the issuer's
   JWKS (`$KEYCLOAK_ISSUER_URL/protocol/openid-connect/certs`) and reads
   identity from the verified claims:
   - `preferred_username`, `email`, `name`
   - `group_membership` — the caller's org-scoped group paths, e.g.
     `["/Example Org", "/Example Org/admin"]`

`GET /internal/me` returns the resolved identity (including `is_admin`) and
is the reference implementation to copy from.

### Admin

Admin is **explicit, never implicit**: a caller is admin if and only if the
verified `group_membership` claim contains the admin group. Being
authenticated — in any stage — grants nothing beyond member access.

- Admin group: `$BITSWAN_ADMIN_GROUP`, defaulting to
  `$BITSWAN_ALLOWED_GROUP/admin` (the AOC provisions an `admin` child group
  under every org group; the platform gate uses the same convention).
- Checks fail closed: no admin group configured, or no groups claim, means
  not admin.
- `DELETE /internal/gallery/{filename}` demonstrates gating an endpoint with
  `app.requireAdmin(...)`.

### Environment (injected by the platform — do not set by hand in deploys)

| Variable | Meaning |
| --- | --- |
| `KEYCLOAK_ISSUER_URL` | OIDC issuer (`https://…/realms/<realm>`) to validate Bearer JWTs against. Present on AOC-connected platforms. |
| `BITSWAN_ALLOWED_GROUP` | The org's group path (e.g. `/Example Org`). Members of this group may call `/internal/*`. |
| `BITSWAN_ADMIN_GROUP` | Group whose members are admins. Defaults to `$BITSWAN_ALLOWED_GROUP/admin`. |
| `BITSWAN_AUTH_MODE` | `aoc` when the platform is AOC-connected — the worker's signal that the identity env above *should* exist. |
| `BITSWAN_AUTOMATION_STAGE` | Deployment stage (`dev`, `staging`, `production`, `live-dev`). Set on every platform deploy. |

### Startup behaviour (fail loudly, never degrade silently)

| Situation | Behaviour |
| --- | --- |
| `KEYCLOAK_ISSUER_URL` set | AOC mode: Bearer JWTs are validated; group/admin checks active. |
| `BITSWAN_AUTH_MODE=aoc` but no issuer | **Refuses to start.** The platform should have injected the issuer; running unverified would silently trust every request. Fix the platform (re-run `bitswan workspace update`), don't work around it in the app. |
| Deployed stage, no identity env at all | Starts with a loud warning: the upstream Bailey gate is the only authentication. Never expose the worker except through the gate. |
| Nothing set (local development) | Simple mode: no token validation, requests pass through. |

## Endpoints

- `GET /health` — liveness, no auth
- `GET /public/*` — no auth (gallery read-only)
- `GET /internal/me` — verified identity of the caller
- `GET|POST /internal/count` — per-user counter
- `GET|POST /internal/gallery…` — gallery list/get/upload
- `DELETE /internal/gallery/{filename}` — **admin only**

## Development

```sh
go test ./...   # contract tests live in auth_test.go
```

`BITSWAN_EGRESS_PROBES` (comma-separated hosts) makes the worker exercise
external hosts so the workspace egress firewall can observe them.
