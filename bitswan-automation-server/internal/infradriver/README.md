# Infrastructure driver

A backend-agnostic way to run a workspace's automations: gitops stops speaking
Docker and instead **pushes the workspace's `bitswan.yaml` (+ source) to a git
remote that the driver hosts**; the driver's post-receive hook compiles the
declaration and reconciles the backend. Apply is a `git push`. Today there is
one driver — Docker. Kubernetes needs no custom driver: point ArgoCD/Flux at the
same repo.

## Why

Today gitops generates docker-compose, shells out to `docker`, and holds a
read-write Docker socket as root (SECURITY_REPORT CRIT-1). That welds gitops to
Docker and makes every gitops container host-root-equivalent. Behind the driver:

- gitops shrinks to *state management* (bitswan.yaml, secrets, git, the API) and
  **loses the Docker socket** — the driver is its sole holder;
- the orchestration backend is pluggable;
- **the audit trail is free**: every deploy/promote/swap/scale/rollback/backup is
  a committed push, so the git history of `bitswan.yaml` *is* the log (author,
  time, diff) with nothing happening out of band.

## Topology

```
gitops (editing + per-user copies, Sync & Deploy → resolves main)
      │ git push  (resolved bitswan.yaml + source)
      ▼
driver git remote ── post-receive ──▶ compile bitswan.yaml + reconcile backend
      ▲                                 (build images, networks, compose,
      │ HTTP over private UNIX socket    cert/oauth2 sidecars, blue-green data)
      └── container primitives: list / logs / stop / restart
```

- The driver is a subcommand of the existing daemon binary
  (`bitswan infra-driver serve`) — **no new image**. One driver per gitops (and
  one for the daemon).
- gitops keeps its own git server + copies model unchanged. On
  deploy/promote/swap/scale/rollback it resolves the deployed `bitswan.yaml`
  and `git push`es it (with the source needed to build) to the driver's remote.
- **Apply = the post-receive hook.** It runs `bitswan infra-driver apply`,
  whose stdout (the compile/reconcile progress) is relayed back over git's
  sideband to the pushing client, which gitops forwards to the dashboard.

## Surface

There is **no apply RPC**. The RPCs are image building plus four operational
container primitives — none are state changes — served as HTTP over the private
UNIX socket (`api.go`):

| Endpoint | Purpose |
|---|---|
| `POST /v1/build-image` | build a source image (SSE log → image); gitops records the tag in bitswan.yaml then pushes, so apply only deploys already-built images |
| `POST /v1/containers/list` | list workspace containers (+ labels) — gitops derives deployment status/health/slot from this |
| `POST /v1/containers/logs` | stream a container's logs (SSE) |
| `POST /v1/containers/stop` | stop one container (transient) |
| `POST /v1/containers/restart` | restart one container (transient) |

`build-image` exists because after the cut-over gitops has no Docker socket.
Everything else (deploy/promote/swap/scale/rollback/backup) is a `git push`. If
a flow doesn't fit, the fix is to make `bitswan.yaml` more expressive — never to
add a driver command.

## Go interface

`driver.go`. The post-receive hook calls `Apply`; the HTTP server (`server.go`)
exposes the four container methods. Each backend (dockerdriver, …) is one
implementation:

```go
type Driver interface {
    Apply(ctx, ApplyRequest, prog func(Progress)) ([]Route, error) // invoked by the git hook
    ContainerList(ctx, WorkspaceContext, ContainerFilter) ([]Container, error)
    ContainerLogs(ctx, WorkspaceContext, name string, tail int, follow bool, sink func(LogLine)) error
    ContainerStop(ctx, WorkspaceContext, name string) error
    ContainerRestart(ctx, WorkspaceContext, name string) error
}
```

The Docker driver reuses the daemon's existing `internal/dockercompose` and
`internal/docker` as its compilation backend.

## What moves out of gitops (clean cut-over — old code deleted, no flag)

Ported into the Docker driver's `Apply` (Python → Go):

- `automation_service.generate_docker_compose`, `_merge_infra_services`,
  `_stage_network`, blue-green slot generation, egress-gateway wiring,
  `BITSWAN_WORKER_HOSTS`; infra services' `_generate_compose_dict`;
- `utils.docker_compose_up`, `utils.ensure_docker_network`;
- cert install + oauth2-proxy sidecar start;
- `_bake_source_image` (image build folds into `Apply`);
- snapshot/backup data ops — re-expressed as `bitswan.yaml` backup state the
  compiler realizes (blue-green DB seed/restore), not a driver command.

Container reads (`async_docker.py` list/logs) → the four primitives. gitops
keeps bitswan.yaml/secrets/git/the API, gains a thin HTTP client for the
primitives + a `git push` to deploy, and **no longer mounts `docker.sock`**.

## Migration plan (this PR — full, clean transition)

1. **Contract** — `driver.go` + `api.go` + server/client for the five
   primitives (list/logs/stop/restart/exec) + build-image (round-trip tested).
2. **`bitswan infra-driver serve`** — host the bare deploy git remote over git
   smart-HTTP (post-receive → `apply`) + serve the primitives, all over TCP on
   the internal network, guarded by a shared bearer token.
3. **`bitswan infra-driver apply`** — the compiler + reconciler: port
   `generate_docker_compose` + reconcile to Go (`internal/dockercompose` reuse,
   golden-tested), bring the project up, install certs + oauth2, provision per-BP
   DBs/buckets, and **configure ingress itself** (`/ingress/reconcile` on the
   daemon — the applier owns the Ingress, k8s-style).
4. **Cut gitops over** — replace its Docker code with: resolve+`git push` to the
   driver for apply, and the HTTP client for list/logs/stop/restart, exec, and
   build-image. Delete `async_docker.py`, the compose-generation,
   `docker_compose_up`/`ensure_docker_network`, cert/oauth2/baking Docker code,
   and the deploy-path ingress registration (the driver does it). Remove the
   `docker.sock` mount. Validate the integration test + bp-lifecycle e2e green
   running through the driver.

**Backups note.** A snapshot/restore is a user-triggered point-in-time action
that produces an artifact (pg_dump → file, mc mirror → tar), not desired state —
so it does NOT fit "declarative state the compiler converges to." It runs through
the general `exec` primitive: gitops keeps the snapshot orchestration (streaming
the dump to/from its snapshots volume) and uses `exec` for the in-container
`pg_dump`/`psql`/`mc` steps.

## Kubernetes (later, no custom driver)

The apply contract is literally "push `bitswan.yaml` to a git remote" — which is
exactly what ArgoCD/Flux consume. Compile `bitswan.yaml` to manifests in the
pushed repo (or via an ArgoCD config-management plugin) and a GitOps controller
syncs it. No `k8sdriver` to write; gitops is untouched.
