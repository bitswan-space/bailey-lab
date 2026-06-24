"""Tests for the infra-driver client.

Validates the two transports end-to-end without docker:
  * deploy() against a real local bare repo whose post-receive hook prints the
    same `[step] message` / `[route] {json}` lines the Go driver's apply emits,
    proving progress streaming + route extraction off the git push sideband.
  * the HTTP/SSE primitives against a real aiohttp server speaking the api.go
    JSON + SSE contract.
"""

import base64
import json
import os
import stat
import subprocess

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from app.services.infra_driver_client import (
    BuildRequest,
    Container,
    ExecSpec,
    ImageRef,
    InfraDriverClient,
    InfraDriverError,
    Route,
    WorkspaceContext,
)

WCTX = WorkspaceContext(
    workspace_name="acme",
    domain="example.com",
    gitops_dir="/gitops/gitops",
    secrets_dir="/gitops/secrets",
)


def _git(cwd, *args):
    subprocess.run(
        ["git", "-C", cwd, *args],
        check=True,
        capture_output=True,
        env={
            **os.environ,
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@e",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@e",
        },
    )


async def test_deploy_streams_progress_and_parses_routes(tmp_path):
    # A bare deploy repo whose post-receive hook stands in for `infra-driver
    # apply`: it prints progress + route lines exactly as the Go apply does.
    bare = tmp_path / "deploy.git"
    subprocess.run(
        ["git", "init", "--bare", str(bare)], check=True, capture_output=True
    )
    _git(str(bare), "config", "http.receivepack", "true")
    hook = bare / "hooks" / "post-receive"
    route = {
        "hostname": "acme.example.com",
        "upstream": "acme-svc:8080",
        "stage": "dev",
    }
    hook.write_text(
        "#!/bin/sh\n"
        "echo '[compile] Compiling bitswan.yaml...'\n"
        "echo '[compose_up] Bringing up project...'\n"
        f"echo '[route] {json.dumps(route)}'\n"
    )
    hook.chmod(hook.stat().st_mode | stat.S_IEXEC)

    # A work tree to push.
    work = tmp_path / "work"
    work.mkdir()
    _git(str(work), "init")
    (work / "bitswan.yaml").write_text("deployments: {}\n")

    client = InfraDriverClient(
        base_url="http://unused", token="t", deploy_remote=str(bare)
    )

    seen: list[tuple[str, str]] = []

    async def progress(step, message, current=None):
        seen.append((step, message))

    routes = await client.deploy(str(work), "deploy acme", progress_callback=progress)

    assert routes == [Route("acme.example.com", "acme-svc:8080", "dev")]
    assert ("compile", "Compiling bitswan.yaml...") in seen
    assert ("compose_up", "Bringing up project...") in seen


async def test_deploy_raises_on_push_failure(tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    _git(str(work), "init")
    (work / "f").write_text("x")
    client = InfraDriverClient(
        base_url="http://unused",
        token="t",
        deploy_remote=str(tmp_path / "does-not-exist.git"),
    )
    with pytest.raises(InfraDriverError):
        await client.deploy(str(work), "deploy")


@pytest.fixture
async def driver_server():
    """A fake driver speaking the api.go HTTP/SSE contract, with token auth.
    Uses aiohttp's TestServer directly (no pytest-aiohttp plugin dependency)."""

    # Captures cross-request state (e.g. the copy-in body) for assertions; kept
    # in a closure rather than request.app to avoid aiohttp's app-key warnings.
    captured: dict = {}

    def authed(request):
        return request.headers.get("Authorization") == "Bearer s3cret"

    async def list_handler(request):
        if not authed(request):
            return web.Response(status=401)
        body = await request.json()
        assert body["ctx"]["workspace_name"] == "acme"
        return web.json_response(
            {
                "containers": [
                    {
                        "id": "abc",
                        "name": "acme-svc",
                        "state": "running",
                        "health": "healthy",
                        "image": "img:1",
                        "labels": {"k": "v"},
                    }
                ]
            }
        )

    async def stop_handler(request):
        if not authed(request):
            return web.Response(status=401)
        return web.json_response({"ok": True})

    async def build_handler(request):
        if not authed(request):
            return web.Response(status=401)
        resp = web.StreamResponse()
        resp.headers["Content-Type"] = "text/event-stream"
        await resp.prepare(request)
        await resp.write(b'event: log\ndata: {"line":"step 1/2"}\n\n')
        await resp.write(b'event: log\ndata: {"line":"step 2/2"}\n\n')
        img = {
            "full_tag": "internal/acme:sha",
            "image_id": "sha256:deadbeef",
            "cache_hit": False,
        }
        await resp.write(f"event: image\ndata: {json.dumps(img)}\n\n".encode())
        await resp.write_eof()
        return resp

    async def build_error_handler(request):
        resp = web.StreamResponse()
        resp.headers["Content-Type"] = "text/event-stream"
        await resp.prepare(request)
        await resp.write(b'event: error\ndata: {"error":"boom"}\n\n')
        await resp.write_eof()
        return resp

    def _frame(stream: int, payload: bytes) -> bytes:
        return bytes([stream]) + len(payload).to_bytes(4, "big") + payload

    async def exec_handler(request):
        # Echo the exec metadata + streamed stdin back as framed stdout, then a
        # stderr line and an exit frame — mirrors execframe.go on the Go side.
        if not authed(request):
            return web.Response(status=401)
        meta = json.loads(base64.b64decode(request.headers["X-Bitswan-Exec"]))
        stdin = await request.read()
        resp = web.StreamResponse()
        resp.headers["Content-Type"] = "application/octet-stream"
        await resp.prepare(request)
        # binary-safe stdout: echo stdin verbatim (could be a dump), plus a marker
        await resp.write(_frame(1, b"\x00\x01" + stdin))
        await resp.write(_frame(2, b"cmd: " + " ".join(meta["spec"]["cmd"]).encode()))
        code = 7 if meta["spec"]["container"] == "boom" else 0
        await resp.write(_frame(3, code.to_bytes(4, "big")))
        await resp.write_eof()
        return resp

    async def exec_error_handler(request):
        resp = web.StreamResponse()
        resp.headers["Content-Type"] = "application/octet-stream"
        await resp.prepare(request)
        await resp.write(
            bytes([4])
            + len(b"no such container").to_bytes(4, "big")
            + b"no such container"
        )
        await resp.write_eof()
        return resp

    async def copy_out_handler(request):
        # Stream a raw TAR back (the response body IS the archive) — mirrors the
        # Go handleCopyOut. Echo the requested path into the archive so the test
        # can assert it round-tripped.
        if not authed(request):
            return web.Response(status=401)
        body = await request.json()
        resp = web.StreamResponse()
        resp.headers["Content-Type"] = "application/x-tar"
        await resp.prepare(request)
        # Two binary chunks (a TAR is opaque bytes) — must round-trip verbatim.
        await resp.write(b"\x00ustar")
        await resp.write(body["path"].encode())
        await resp.write_eof()
        return resp

    async def copy_in_handler(request):
        # Read the streamed TAR body + the X-Bitswan-Copy metadata, stash them so
        # the test can assert both — mirrors the Go handleCopyIn.
        if not authed(request):
            return web.Response(status=401)
        meta = json.loads(base64.b64decode(request.headers["X-Bitswan-Copy"]))
        tar = await request.read()
        captured["copy_in"] = {"meta": meta, "tar": tar}
        return web.json_response({"ok": True})

    app = web.Application()
    app.router.add_post("/v1/containers/list", list_handler)
    app.router.add_post("/v1/containers/stop", stop_handler)
    app.router.add_post("/v1/build-image", build_handler)
    app.router.add_post("/v1/build-error", build_error_handler)
    app.router.add_post("/v1/containers/exec", exec_handler)
    app.router.add_post("/v1/exec-error", exec_error_handler)
    app.router.add_post("/v1/containers/copy-out", copy_out_handler)
    app.router.add_post("/v1/containers/copy-in", copy_in_handler)
    server = TestServer(app)
    server.captured = captured  # expose cross-request captures to the tests
    await server.start_server()
    try:
        yield server
    finally:
        await server.close()


async def test_container_list(driver_server):
    client = InfraDriverClient(
        base_url=str(driver_server.make_url("")),
        token="s3cret",
        deploy_remote="x",
    )
    containers = await client.container_list(WCTX, labels={"gitops.stage": "dev"})
    assert containers == [
        Container("abc", "acme-svc", "running", "healthy", "img:1", labels={"k": "v"})
    ]


async def test_container_stop_ok(driver_server):
    client = InfraDriverClient(
        base_url=str(driver_server.make_url("")), token="s3cret", deploy_remote="x"
    )
    await client.container_stop(WCTX, "acme-svc")  # no raise == ok


async def test_token_enforced(driver_server):
    client = InfraDriverClient(
        base_url=str(driver_server.make_url("")), token="wrong", deploy_remote="x"
    )
    with pytest.raises(InfraDriverError):
        await client.container_list(WCTX)


async def test_build_image_streams_log_then_image(driver_server):
    client = InfraDriverClient(
        base_url=str(driver_server.make_url("")), token="s3cret", deploy_remote="x"
    )
    logs: list[str] = []

    async def prog(line):
        logs.append(line)

    img = await client.build_image(
        BuildRequest(
            ctx=WCTX,
            tag="internal/acme:sha",
            source_path="/src",
            base_image="python:3.12",
        ),
        progress_callback=prog,
    )
    assert img == ImageRef("internal/acme:sha", "sha256:deadbeef", False)
    assert logs == ["step 1/2", "step 2/2"]


async def test_sse_error_frame_raises(driver_server):
    # An `error` SSE frame must raise loudly. Exercised via the stream helper
    # against the error endpoint (build_image/container_logs both route the
    # `error` event to InfraDriverError the same way).
    client = InfraDriverClient(
        base_url=str(driver_server.make_url("")), token="s3cret", deploy_remote="x"
    )

    async def on_frame(event, data):
        if event == "error":
            raise InfraDriverError(data.get("error", ""))

    with pytest.raises(InfraDriverError, match="boom"):
        await client._stream("/v1/build-error", {"ctx": WCTX.to_json()}, on_frame)


async def test_exec_streams_stdin_stdout_and_exit(driver_server):
    client = InfraDriverClient(
        base_url=str(driver_server.make_url("")), token="s3cret", deploy_remote="x"
    )
    out, err = bytearray(), bytearray()

    async def on_out(chunk):
        out.extend(chunk)

    async def on_err(chunk):
        err.extend(chunk)

    code = await client.exec(
        WCTX,
        ExecSpec(container="acme-postgres", cmd=["pg_dump", "-Fc", "db"]),
        stdin=b"\xff\x00binary-stdin",
        on_stdout=on_out,
        on_stderr=on_err,
    )
    assert code == 0
    # stdout is the server marker + echoed (binary-safe) stdin.
    assert bytes(out) == b"\x00\x01\xff\x00binary-stdin"
    assert bytes(err) == b"cmd: pg_dump -Fc db"


async def test_exec_propagates_nonzero_exit(driver_server):
    client = InfraDriverClient(
        base_url=str(driver_server.make_url("")), token="s3cret", deploy_remote="x"
    )
    code = await client.exec(WCTX, ExecSpec(container="boom", cmd=["false"]))
    assert code == 7


async def test_exec_error_frame_raises(driver_server):
    with pytest.raises(InfraDriverError, match="no such container"):
        # Hit the error endpoint directly via the frame reader path.
        async with __import__("httpx").AsyncClient() as hc:
            async with hc.stream(
                "POST",
                str(driver_server.make_url("/v1/exec-error")),
                headers={"Authorization": "Bearer s3cret"},
            ) as resp:
                from app.services.infra_driver_client import _read_exec_frames

                await _read_exec_frames(resp.aiter_bytes(), None, None)


async def test_copy_out_streams_tar(driver_server):
    client = InfraDriverClient(
        base_url=str(driver_server.make_url("")), token="s3cret", deploy_remote="x"
    )
    got = bytearray()

    async def on_chunk(chunk):
        got.extend(chunk)

    await client.copy_out(WCTX, "acme-minio", "/tmp/bpsnap-bkt", on_chunk)
    # The raw TAR bytes round-trip verbatim (binary-safe), incl. the echoed path.
    assert bytes(got) == b"\x00ustar/tmp/bpsnap-bkt"


async def test_copy_in_streams_tar_and_metadata(driver_server):
    client = InfraDriverClient(
        base_url=str(driver_server.make_url("")), token="s3cret", deploy_remote="x"
    )

    async def chunks():
        yield b"\x00ustar"
        yield b"\xfe\xffpayload"

    await client.copy_in(WCTX, "acme-minio", "/tmp", chunks())
    received = driver_server.captured["copy_in"]
    assert received["tar"] == b"\x00ustar\xfe\xffpayload"
    assert received["meta"]["container"] == "acme-minio"
    assert received["meta"]["path"] == "/tmp"
    assert received["meta"]["ctx"]["workspace_name"] == "acme"


async def test_copy_out_token_enforced(driver_server):
    client = InfraDriverClient(
        base_url=str(driver_server.make_url("")), token="wrong", deploy_remote="x"
    )
    with pytest.raises(InfraDriverError):
        await client.copy_out(WCTX, "acme-minio", "/x", lambda _c: None)


def test_require_env_fails_loudly(monkeypatch):
    monkeypatch.delenv("BITSWAN_INFRA_DRIVER_URL", raising=False)
    with pytest.raises(InfraDriverError):
        InfraDriverClient(token="t", deploy_remote="x")
