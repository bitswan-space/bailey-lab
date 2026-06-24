"""
Async client for the per-workspace infra-driver.

The driver (bitswan-automation-server/internal/infradriver) is the only
component that touches docker.sock after the cut-over. It exposes two
transports, both reached over the internal network and guarded by a shared
bearer token (BITSWAN_INFRA_DRIVER_TOKEN):

  * DEPLOY is a ``git push`` to the driver's deploy repo
    (BITSWAN_DEPLOY_REMOTE). The driver's post-receive hook materializes the
    pushed tree, compiles + applies the bitswan.yaml, and prints ``[step]
    message`` progress lines plus ``[route] {json}`` route lines on stdout,
    which git relays back to us as ``remote:`` sideband lines. The git history
    of the deploy repo IS the deploy audit log.

  * The four container primitives + build-image are HTTP/SSE under ``/v1``
    (BITSWAN_INFRA_DRIVER_URL).

This mirrors ``internal/infradriver/client.go`` and matches the JSON contract
in ``internal/infradriver/{driver.go,api.go}`` exactly. It fails loudly: every
error path raises ``InfraDriverError`` — there are no silent fallbacks and no
return-None-on-error.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
from dataclasses import dataclass, field
from typing import AsyncIterator, Awaitable, Callable, Optional

import httpx

# /v1 paths (api.go).
PATH_BUILD_IMAGE = "/v1/build-image"
PATH_CONTAINERS_LIST = "/v1/containers/list"
PATH_CONTAINERS_INSPECT = "/v1/containers/inspect"
PATH_CONTAINERS_LOGS = "/v1/containers/logs"
PATH_CONTAINERS_STOP = "/v1/containers/stop"
PATH_CONTAINERS_RESTART = "/v1/containers/restart"
PATH_CONTAINERS_EXEC = "/v1/containers/exec"

# SSE event names (api.go).
EVENT_LOG = "log"
EVENT_IMAGE = "image"
EVENT_ERROR = "error"

# exec wire (api.go / execframe.go): metadata rides this header (base64 of
# {ctx, spec}); stdin is the raw request body; the response is a binary
# multiplexed stream of [stream:1][len:4 big-endian][payload] frames.
HEADER_EXEC = "X-Bitswan-Exec"
_EXEC_STDOUT = 1
_EXEC_STDERR = 2
_EXEC_EXIT = 3
_EXEC_ERROR = 4

# Markers the driver's apply prints on the post-receive hook's stdout.
_ROUTE_PREFIX = "[route] "
_REMOTE_PREFIX = "remote: "

# A progress callback: (step, message) -> awaitable. Mirrors the gitops deploy
# progress_callback contract (step, message[, current]).
ProgressCallback = Callable[..., Awaitable[None]]


class InfraDriverError(RuntimeError):
    """Any failure talking to the driver. Raised loudly — never swallowed."""


@dataclass
class WorkspaceContext:
    """Everything the compiler needs that is not in bitswan.yaml (driver.go
    WorkspaceContext). Serialized with the Go json snake_case field names."""

    workspace_name: str
    domain: str
    gitops_dir: str
    secrets_dir: str
    wrap_available: bool = False

    def to_json(self) -> dict:
        return {
            "workspace_name": self.workspace_name,
            "domain": self.domain,
            "gitops_dir": self.gitops_dir,
            "secrets_dir": self.secrets_dir,
            "wrap_available": self.wrap_available,
        }


@dataclass
class Route:
    """A desired ingress route (driver.go Route). gitops registers these with
    the daemon ingress via reconcile_ingress."""

    hostname: str
    upstream: str
    stage: str

    @classmethod
    def from_json(cls, d: dict) -> "Route":
        return cls(
            hostname=d["hostname"], upstream=d["upstream"], stage=d.get("stage", "")
        )


@dataclass
class Container:
    """One realized container (driver.go Container)."""

    id: str
    name: str
    state: str
    health: str
    image: str
    created: int = 0
    labels: dict = field(default_factory=dict)

    @classmethod
    def from_json(cls, d: dict) -> "Container":
        return cls(
            id=d.get("id", ""),
            name=d.get("name", ""),
            state=d.get("state", ""),
            health=d.get("health", ""),
            image=d.get("image", ""),
            created=d.get("created", 0) or 0,
            labels=d.get("labels") or {},
        )

    def to_docker_dict(self) -> dict:
        """Map to the docker-API /containers/json shape gitops historically got
        from async_docker.list_containers, so the existing get_automations
        overlay (which reads Id/Names/State/Status/Created/Labels) is unchanged."""
        return {
            "Id": self.id,
            "Names": [f"/{self.name}"] if self.name else [],
            "State": self.state,
            "Status": self.health or self.state,
            "Created": self.created,
            "Image": self.image,
            "Labels": self.labels,
        }


@dataclass
class ImageRef:
    """Result of build-image (driver.go ImageRef)."""

    full_tag: str
    image_id: str
    cache_hit: bool = False

    @classmethod
    def from_json(cls, d: dict) -> "ImageRef":
        return cls(
            full_tag=d.get("full_tag", ""),
            image_id=d.get("image_id", ""),
            cache_hit=bool(d.get("cache_hit", False)),
        )


@dataclass
class BuildRequest:
    """build-image request (driver.go BuildRequest)."""

    ctx: WorkspaceContext
    tag: str
    source_path: str
    base_image: str = ""
    mount_path: str = ""
    # When set, build this Dockerfile (relative to source_path) as-is instead of
    # the generated FROM base + COPY . mount_path (driver.go BuildRequest).
    dockerfile: str = ""
    source_sha: str = ""

    def to_json(self) -> dict:
        return {
            "ctx": self.ctx.to_json(),
            "tag": self.tag,
            "source_path": self.source_path,
            "base_image": self.base_image,
            "mount_path": self.mount_path,
            "dockerfile": self.dockerfile,
            "source_sha": self.source_sha,
        }


@dataclass
class ExecSpec:
    """One container exec invocation (driver.go ExecSpec)."""

    container: str
    cmd: list[str]
    tty: bool = False
    user: str = ""

    def to_json(self) -> dict:
        return {
            "container": self.container,
            "cmd": self.cmd,
            "tty": self.tty,
            "user": self.user,
        }


class InfraDriverClient:
    """Talks to one workspace's infra-driver. Construct from the environment
    the sidecar wiring sets on the gitops container, or pass values explicitly
    (tests)."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        deploy_remote: Optional[str] = None,
        timeout: float = 600.0,
    ):
        self.base_url = (base_url or _require_env("BITSWAN_INFRA_DRIVER_URL")).rstrip(
            "/"
        )
        self.token = token or _require_env("BITSWAN_INFRA_DRIVER_TOKEN")
        self.deploy_remote = deploy_remote or _require_env("BITSWAN_DEPLOY_REMOTE")
        self.timeout = timeout

    @property
    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token}"}

    # ---- deploy (git push) -------------------------------------------------

    async def deploy(
        self,
        work_tree: str,
        commit_message: str,
        progress_callback: Optional[ProgressCallback] = None,
        author: Optional[str] = None,
    ) -> list[Route]:
        """Commit the resolved tree in ``work_tree`` and push it to the driver,
        streaming the apply progress to ``progress_callback`` and returning the
        ingress routes the apply produced.

        ``work_tree`` must be a git repository whose working tree is the fully
        resolved bitswan.yaml + per-deployment source trees. The deployed state
        is authoritative, so the push is a force-push to refs/heads/main.
        """
        await self._git(work_tree, "add", "-A", error="stage resolved tree for deploy")
        # Identity is set inline so the deploy never depends on ambient git
        # config; the operator (when known) is the author, gitops the committer.
        commit_args = [
            "-c",
            "user.name=bitswan-gitops",
            "-c",
            "user.email=gitops@bitswan.local",
            "commit",
            "--allow-empty",
            "-m",
            commit_message,
        ]
        if author:
            commit_args += ["--author", author]
        # An empty commit still triggers a push + re-apply (idempotent reconcile).
        await self._git(work_tree, *commit_args, error="commit resolved tree")

        routes: list[Route] = []

        async def on_line(line: str):
            await self._handle_push_line(line, routes, progress_callback)

        rc = await self._run_streaming(
            [
                "git",
                "-C",
                work_tree,
                "push",
                "--force",
                self.deploy_remote,
                "HEAD:refs/heads/main",
            ],
            on_line,
        )
        if rc != 0:
            raise InfraDriverError(
                f"deploy push to driver failed (git push exit {rc}); see progress log"
            )
        return routes

    async def _handle_push_line(
        self,
        line: str,
        routes: list[Route],
        progress_callback: Optional[ProgressCallback],
    ):
        # git writes the hook's stdout back as "remote: <line>" on stderr.
        if line.startswith(_REMOTE_PREFIX):
            line = line[len(_REMOTE_PREFIX) :]
        line = line.rstrip()
        if not line:
            return
        if line.startswith(_ROUTE_PREFIX):
            payload = line[len(_ROUTE_PREFIX) :]
            try:
                routes.append(Route.from_json(json.loads(payload)))
            except (ValueError, KeyError) as e:
                raise InfraDriverError(
                    f"malformed [route] line from driver: {line!r}"
                ) from e
            return
        # Progress lines are "[step] message".
        if progress_callback is not None and line.startswith("[") and "]" in line:
            step, _, message = line[1:].partition("] ")
            await progress_callback(step, message)

    # ---- build-image (HTTP/SSE) --------------------------------------------

    async def build_image(
        self,
        req: BuildRequest,
        progress_callback: Optional[Callable[[str], Awaitable[None]]] = None,
    ) -> ImageRef:
        """Build a source image on the driver, streaming build-log lines, and
        return the resulting image ref."""
        result: dict = {}

        async def on_frame(event: str, data: dict):
            if event == EVENT_LOG:
                if progress_callback is not None:
                    await progress_callback(data.get("line", ""))
            elif event == EVENT_IMAGE:
                result["image"] = ImageRef.from_json(data)
            elif event == EVENT_ERROR:
                raise InfraDriverError(f"build-image: {data.get('error', 'unknown')}")

        await self._stream(PATH_BUILD_IMAGE, req.to_json(), on_frame)
        if "image" not in result:
            raise InfraDriverError("build-image returned no image frame")
        return result["image"]

    # ---- container primitives ----------------------------------------------

    async def container_list(
        self, ctx: WorkspaceContext, labels: Optional[dict] = None
    ) -> list[Container]:
        body = {"ctx": ctx.to_json(), "filter": {"labels": labels or {}}}
        out = await self._post_json(PATH_CONTAINERS_LIST, body)
        return [Container.from_json(c) for c in (out.get("containers") or [])]

    async def container_inspect(self, ctx: WorkspaceContext, container: str) -> dict:
        """Raw `docker inspect` of one container (the driver returns a 1-element
        array). Returns the single record, or {} if absent."""
        out = await self._post_json(
            PATH_CONTAINERS_INSPECT, {"ctx": ctx.to_json(), "container": container}
        )
        if isinstance(out, list):
            return out[0] if out else {}
        return out or {}

    async def container_stop(self, ctx: WorkspaceContext, container: str) -> None:
        await self._post_json(
            PATH_CONTAINERS_STOP, {"ctx": ctx.to_json(), "container": container}
        )

    async def container_restart(self, ctx: WorkspaceContext, container: str) -> None:
        await self._post_json(
            PATH_CONTAINERS_RESTART, {"ctx": ctx.to_json(), "container": container}
        )

    async def container_logs(
        self,
        ctx: WorkspaceContext,
        container: str,
        tail: int = 0,
        follow: bool = False,
        sink: Optional[Callable[[str, bool], Awaitable[None]]] = None,
    ) -> None:
        body = {
            "ctx": ctx.to_json(),
            "container": container,
            "tail": tail,
            "follow": follow,
        }

        async def on_frame(event: str, data: dict):
            if event == EVENT_LOG:
                if sink is not None:
                    await sink(data.get("line", ""), bool(data.get("stderr", False)))
            elif event == EVENT_ERROR:
                raise InfraDriverError(
                    f"container logs: {data.get('error', 'unknown')}"
                )

        await self._stream(PATH_CONTAINERS_LOGS, body, on_frame)

    # ---- exec (general escape hatch: backups/restores/maintenance) ----------

    async def exec(
        self,
        ctx: WorkspaceContext,
        spec: ExecSpec,
        stdin: "bytes | AsyncIterator[bytes] | None" = None,
        on_stdout: Optional[Callable[[bytes], Awaitable[None]]] = None,
        on_stderr: Optional[Callable[[bytes], Awaitable[None]]] = None,
    ) -> int:
        """Run a command in a container and return its exit code.

        ``stdin`` (bytes or an async byte iterator) is streamed to the process
        stdin — used to feed restore dumps without buffering. ``on_stdout`` /
        ``on_stderr`` receive raw byte chunks as they arrive (binary-safe: a
        pg_dump is not text). The driver holds docker.sock; this is the only
        path by which gitops runs in-container commands after the cut-over.
        Fails loudly: a transport error or a driver error frame raises.
        """
        meta = base64.b64encode(
            json.dumps({"ctx": ctx.to_json(), "spec": spec.to_json()}).encode()
        ).decode()
        headers = {
            **self._headers,
            HEADER_EXEC: meta,
            "Content-Type": "application/octet-stream",
        }
        # httpx sends None as an empty body; bytes/async-iterators stream as-is.
        content = b"" if stdin is None else stdin
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            try:
                async with client.stream(
                    "POST",
                    self.base_url + PATH_CONTAINERS_EXEC,
                    content=content,
                    headers=headers,
                ) as resp:
                    if resp.status_code != 200:
                        text = (await resp.aread()).decode(errors="replace")
                        raise InfraDriverError(
                            f"{PATH_CONTAINERS_EXEC}: HTTP {resp.status_code}: {text}"
                        )
                    return await _read_exec_frames(
                        resp.aiter_bytes(), on_stdout, on_stderr
                    )
            except httpx.HTTPError as e:
                raise InfraDriverError(f"{PATH_CONTAINERS_EXEC}: {e}") from e

    # ---- transport helpers --------------------------------------------------

    async def _post_json(self, path: str, body: dict) -> dict:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            try:
                resp = await client.post(
                    self.base_url + path, json=body, headers=self._headers
                )
            except httpx.HTTPError as e:
                raise InfraDriverError(f"{path}: {e}") from e
            if resp.status_code != 200:
                raise InfraDriverError(f"{path}: HTTP {resp.status_code}: {resp.text}")
            if not resp.content:
                return {}
            return resp.json()

    async def _stream(
        self, path: str, body: dict, on_frame: Callable[[str, dict], Awaitable[None]]
    ) -> None:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            headers = {**self._headers, "Accept": "text/event-stream"}
            try:
                async with client.stream(
                    "POST", self.base_url + path, json=body, headers=headers
                ) as resp:
                    if resp.status_code != 200:
                        text = (await resp.aread()).decode(errors="replace")
                        raise InfraDriverError(
                            f"{path}: HTTP {resp.status_code}: {text}"
                        )
                    event = ""
                    data_buf = ""
                    async for line in resp.aiter_lines():
                        if line == "":
                            if event:
                                await on_frame(event, _decode_sse_data(data_buf))
                            event, data_buf = "", ""
                        elif line.startswith("event:"):
                            event = line[len("event:") :].strip()
                        elif line.startswith("data:"):
                            data_buf += line[len("data:") :].strip()
                    if event:
                        await on_frame(event, _decode_sse_data(data_buf))
            except httpx.HTTPError as e:
                raise InfraDriverError(f"{path}: {e}") from e

    async def _git(self, work_tree: str, *args: str, error: str) -> None:
        rc, out = await _capture(["git", "-C", work_tree, *args])
        if rc != 0:
            raise InfraDriverError(f"{error}: git {' '.join(args)} (exit {rc}): {out}")

    async def _run_streaming(
        self, cmd: list[str], on_line: Callable[[str], Awaitable[None]]
    ) -> int:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        assert proc.stdout is not None
        async for raw in proc.stdout:
            await on_line(raw.decode(errors="replace").rstrip("\n"))
        return await proc.wait()


async def _read_exec_frames(
    chunks: AsyncIterator[bytes],
    on_stdout: Optional[Callable[[bytes], Awaitable[None]]],
    on_stderr: Optional[Callable[[bytes], Awaitable[None]]],
) -> int:
    """Demux the binary exec response (execframe.go) from a byte-chunk stream:
    [stream:1][len:4 big-endian][payload]. Returns the exit-frame code; an
    error frame (or a stream that ends with no exit frame) raises."""
    buf = bytearray()
    chunk_iter = chunks.__aiter__()

    async def fill(n: int) -> bool:
        # Pull chunks until buf has at least n bytes; False at clean EOF.
        while len(buf) < n:
            try:
                buf.extend(await chunk_iter.__anext__())
            except StopAsyncIteration:
                return False
        return True

    while True:
        if not await fill(5):
            if buf:
                raise InfraDriverError("exec stream truncated mid-frame header")
            raise InfraDriverError("exec stream ended without an exit frame")
        stream = buf[0]
        length = int.from_bytes(bytes(buf[1:5]), "big")
        if not await fill(5 + length):
            raise InfraDriverError("exec stream truncated mid-frame payload")
        payload = bytes(buf[5 : 5 + length])
        del buf[: 5 + length]
        if stream == _EXEC_STDOUT:
            if on_stdout is not None:
                await on_stdout(payload)
        elif stream == _EXEC_STDERR:
            if on_stderr is not None:
                await on_stderr(payload)
        elif stream == _EXEC_EXIT:
            if len(payload) != 4:
                raise InfraDriverError("malformed exec exit frame")
            return int.from_bytes(payload, "big", signed=True)
        elif stream == _EXEC_ERROR:
            raise InfraDriverError(f"exec: {payload.decode(errors='replace')}")
        else:
            raise InfraDriverError(f"unknown exec frame stream {stream}")


def _decode_sse_data(data: str) -> dict:
    if not data:
        return {}
    try:
        return json.loads(data)
    except ValueError as e:
        raise InfraDriverError(f"malformed SSE data frame: {data!r}") from e


def _require_env(key: str) -> str:
    val = os.environ.get(key)
    if not val:
        raise InfraDriverError(
            f"{key} is not set — the infra-driver sidecar env is required after "
            f"the docker-driver cut-over"
        )
    return val


async def _capture(cmd: list[str]) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    out, _ = await proc.communicate()
    return proc.returncode, out.decode(errors="replace")
