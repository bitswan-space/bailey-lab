"""agent_ssh_proxy: the dashboard's SSH path to the isolated coding agent.

The proxy is plain TCP plumbing, so the tests run it against a local echo
server standing in for the agent's sshd: bytes must flow both ways
unmodified, EOF must propagate as a half-close (SSH's shutdown is
asymmetric), and an unreachable agent must surface as an immediate close
rather than a hang. Config parsing (env knobs) is covered separately.
"""

import asyncio

import pytest

from app.services.agent_ssh_proxy import (
    DEFAULT_AGENT_SSH_PORT,
    DEFAULT_LISTEN_PORT,
    agent_endpoint,
    create_proxy,
    listen_port,
)


async def _start_echo_server() -> tuple[asyncio.Server, int]:
    """Echo server standing in for the agent's sshd."""

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        while True:
            chunk = await reader.read(1024)
            if not chunk:
                break
            writer.write(chunk)
            await writer.drain()
        writer.close()

    server = await asyncio.start_server(handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    return server, port


async def test_proxy_roundtrip():
    echo, echo_port = await _start_echo_server()
    proxy = await create_proxy("127.0.0.1", 0, "127.0.0.1", echo_port)
    proxy_port = proxy.sockets[0].getsockname()[1]
    try:
        reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
        writer.write(b"SSH-2.0-test\r\n")
        await writer.drain()
        assert await reader.readexactly(len(b"SSH-2.0-test\r\n")) == b"SSH-2.0-test\r\n"

        # A second payload on the same connection — the pipe must stay open.
        writer.write(b"more bytes")
        await writer.drain()
        assert await reader.readexactly(len(b"more bytes")) == b"more bytes"

        # Client half-close propagates: the echo server sees EOF, closes, and
        # our read side reaches EOF too instead of hanging.
        writer.write_eof()
        assert await reader.read() == b""
        writer.close()
    finally:
        proxy.close()
        await proxy.wait_closed()
        echo.close()
        await echo.wait_closed()


async def test_proxy_concurrent_connections():
    echo, echo_port = await _start_echo_server()
    proxy = await create_proxy("127.0.0.1", 0, "127.0.0.1", echo_port)
    proxy_port = proxy.sockets[0].getsockname()[1]

    async def roundtrip(payload: bytes) -> bytes:
        reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
        writer.write(payload)
        await writer.drain()
        got = await reader.readexactly(len(payload))
        writer.close()
        return got

    try:
        payloads = [f"conn-{i}".encode() for i in range(5)]
        results = await asyncio.gather(*(roundtrip(p) for p in payloads))
        assert results == payloads
    finally:
        proxy.close()
        await proxy.wait_closed()
        echo.close()
        await echo.wait_closed()


async def test_proxy_closes_client_when_agent_unreachable():
    # Grab a port with no listener behind it, so the upstream dial fails.
    placeholder = await asyncio.start_server(lambda r, w: None, "127.0.0.1", 0)
    dead_port = placeholder.sockets[0].getsockname()[1]
    placeholder.close()
    await placeholder.wait_closed()

    proxy = await create_proxy("127.0.0.1", 0, "127.0.0.1", dead_port)
    proxy_port = proxy.sockets[0].getsockname()[1]
    try:
        reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
        # The proxy must close on us promptly — no bytes, straight to EOF.
        assert await asyncio.wait_for(reader.read(), timeout=5) == b""
        writer.close()
    finally:
        proxy.close()
        await proxy.wait_closed()


def test_listen_port_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("BITSWAN_AGENT_SSH_PROXY_PORT", raising=False)
    assert listen_port() == DEFAULT_LISTEN_PORT
    monkeypatch.setenv("BITSWAN_AGENT_SSH_PROXY_PORT", "2500")
    assert listen_port() == 2500
    # 0 = explicit disable, passed through for the caller to honour.
    monkeypatch.setenv("BITSWAN_AGENT_SSH_PROXY_PORT", "0")
    assert listen_port() == 0
    monkeypatch.setenv("BITSWAN_AGENT_SSH_PROXY_PORT", "not-a-port")
    assert listen_port() == DEFAULT_LISTEN_PORT


def test_agent_endpoint_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("CODING_AGENT_HOST", raising=False)
    monkeypatch.delenv("CODING_AGENT_SSH_PORT", raising=False)
    monkeypatch.setenv("BITSWAN_WORKSPACE_NAME", "foo")
    assert agent_endpoint() == ("foo-coding-agent", DEFAULT_AGENT_SSH_PORT)
    monkeypatch.setenv("CODING_AGENT_HOST", "elsewhere")
    monkeypatch.setenv("CODING_AGENT_SSH_PORT", "2202")
    assert agent_endpoint() == ("elsewhere", 2202)
