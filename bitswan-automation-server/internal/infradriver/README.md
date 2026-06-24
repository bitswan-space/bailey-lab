# Infrastructure driver

A backend-agnostic **compiler for `bitswan.yaml`**. gitops stops speaking Docker;
it ships declarative intent (the workspace's `bitswan.yaml` + a small context)
over HTTP/SSE to a co-located driver, and the driver realizes that intent
against a concrete backend. Today there is one driver — Docker. A future
Kubernetes driver implements the same contract with **zero gitops changes**.

## Why

Today gitops generates docker-compose, shells out to `docker` / `docker compose`,
and holds a read-write Docker socket as root (SECURITY_REPORT CRIT-1). That
welds gitops to Docker and makes every gitops container host-root-equivalent.
Moving all of that behind a driver:

- shrinks gitops to *state management* (bitswan.yaml, secrets, git, the HTTP API);
- removes the Docker socket from gitops entirely (the driver is its sole holder);
- makes the orchestration backend pluggable.

## Topology

- The driver is a subcommand of the existing automation-server daemon binary
  (`bitswan infra-driver serve`) — **no new image to publish**.
- One driver container per gitops (and one for the daemon). The driver is the
  only container with `/var/run/docker.sock`; gitops loses the mount.
- Transport: **HTTP + Server-Sent Events over a private UNIX socket** shared
  between the gitops and driver containers (a volume); never network-reachable.
  Same shape gitops + the daemon already use (HTTP request/response, SSE for
  streamed progress) — no gRPC, no codegen.

## Contract

`api.go` (endpoints + SSE framing) over the JSON types in `driver.go`. Surface
is deliberately tiny:

- `POST /v1/apply` (ctx + bitswan.yaml [+ only_deployment_ids]) → SSE progress,
  terminal `done` with realized routes — the compiler. Computes desired backend
  state from bitswan.yaml and reconciles (networks, services, sidecars, routes).
  Idempotent. Carries the deploy/promote/swap/scale progress.
- `/v1/build-image`, `/v1/snapshot`, `/v1/restore`, `/v1/status`, `/v1/logs`,
  `/v1/events` — the few imperative ops that aren't pure declaration.

Secrets are passed by reference (shared secrets volume, read-only); plaintext
never crosses the wire.

## Go interface

Both drivers implement:

```go
type Driver interface {
    Apply(ctx context.Context, req ApplyRequest, prog func(Progress)) ([]Route, error)
    BuildImage(ctx context.Context, req BuildRequest, prog func(string)) (ImageRef, error)
    Snapshot(ctx context.Context, req SnapshotRequest, prog func(Progress)) error
    Restore(ctx context.Context, req RestoreRequest, prog func(Progress)) error
    Status(ctx context.Context, ids []string) ([]DeploymentState, error)
    Logs(ctx context.Context, container string, tail int, follow bool, sink func(LogLine)) error
    WatchEvents(ctx context.Context, sink func(Event)) error
}
```

The HTTP/SSE server (`api.go`) is a thin adapter over this interface — it
unmarshals the request, calls the method with a callback that writes SSE frames,
and emits the terminal frame. The Docker driver is the first implementation and
reuses the daemon's existing `internal/dockercompose` and `internal/docker` Go
code as its compilation backend.

## What moves out of gitops

Ported into the Docker driver (Python → Go):

- `automation_service.generate_docker_compose`, `_merge_infra_services`,
  `_stage_network`, blue-green slot generation, egress-gateway wiring,
  `BITSWAN_WORKER_HOSTS` discovery;
- infra services' `_generate_compose_dict` (postgres/couchdb/kafka/minio);
- `utils.docker_compose_up`, `utils.ensure_docker_network`;
- `async_docker.py` (container/exec/image/event API);
- cert install + oauth2-proxy sidecar start (`install_certificates_in_container`,
  `start_oauth2_proxy_in_container`) — folded into `Apply`;
- `_bake_source_image` → `BuildImage`;
- snapshot/backup docker-exec streaming → `Snapshot`/`Restore`.

gitops keeps: bitswan.yaml read/write, secrets encryption, git, the FastAPI
routes — and gains a thin HTTP/SSE client. It no longer mounts `docker.sock`.

## Migration plan (within this PR)

1. **Contract** — `api.go` + `driver.go` (this commit). HTTP/SSE over the UNIX
   socket; no codegen.
2. **Driver service** — `bitswan infra-driver serve`: HTTP/SSE server on the
   UNIX socket, dispatching to the `Driver` interface.
3. **Docker driver `Apply`** — port `generate_docker_compose` + the reconcile
   (compose up, network ensure, cert/oauth2 sidecars) to Go, reusing
   `internal/dockercompose`. Validate against the integration test + the
   bp-lifecycle e2e (both must stay green).
4. **`BuildImage`, `Snapshot`/`Restore`, `Status`/`Logs`/`WatchEvents`**.
5. **gitops client** — replace the Python Docker code with HTTP/SSE calls,
   one flow at a time (deploy → promote → swap → scale → snapshot/restore →
   logs/events), keeping the e2e green at each step.
6. **Drop the socket** — remove `docker.sock` from the gitops container; the
   driver is its sole holder.

## Kubernetes driver (later)

Same contract, different compiler: deployment → Deployment+Service, oauth2
sidecar → sidecar container, CA certs → mounted Secret/init-container,
stage network → namespace + NetworkPolicy, egress policy → NetworkPolicy,
blue-green slot → labels/Service selector. gitops is untouched.
