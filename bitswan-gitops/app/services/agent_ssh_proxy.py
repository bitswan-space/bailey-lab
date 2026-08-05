"""TCP proxy exposing the coding agent's sshd to the control-plane network.

The coding agent runs untrusted (member-/AI-authored) code, so it is
isolated on the dedicated ``<ws>-agent`` bridge shared only with gitops —
it must not sit on ``bitswan_network`` (the control-plane inner ring). But
the workspace dashboard drives the agent over SSH (interactive Claude
sessions in the Agents tab, one-shot ``requirements test`` runs) and lives
only on ``bitswan_network``, so it has no route to the agent. gitops is
dual-homed on both networks: this proxy listens on the control-plane side
(:2222 by default) and forwards raw TCP to the agent's sshd, giving the
dashboard its SSH path back without putting either the dashboard on the
agent bridge or the agent on the control plane.

Isolation is preserved: only *inbound-to-agent* connections flow through
here — the agent still cannot initiate anything toward the control plane.
SSH runs end-to-end (the proxy never sees plaintext) and the agent's sshd
accepts only the workspace keypair, the same authentication that gated
direct access before the agent was moved off bitswan_network.

Env knobs:
  - ``BITSWAN_AGENT_SSH_PROXY_PORT``: listen port (default 2222, ``0``
    disables the proxy).
  - ``CODING_AGENT_HOST``: agent hostname override (default
    ``${BITSWAN_WORKSPACE_NAME}-coding-agent``).
  - ``CODING_AGENT_SSH_PORT``: agent sshd port (default 22).
"""

import asyncio
import logging
import os

logger = logging.getLogger(__name__)

DEFAULT_LISTEN_PORT = 2222
DEFAULT_AGENT_SSH_PORT = 22
CONNECT_TIMEOUT_SECONDS = 10.0
BUFFER_SIZE = 64 * 1024


def listen_port() -> int:
    raw = os.environ.get("BITSWAN_AGENT_SSH_PROXY_PORT")
    if raw is None or raw == "":
        return DEFAULT_LISTEN_PORT
    try:
        port = int(raw)
    except ValueError:
        logger.warning(
            "Invalid BITSWAN_AGENT_SSH_PROXY_PORT %r, using %d",
            raw,
            DEFAULT_LISTEN_PORT,
        )
        return DEFAULT_LISTEN_PORT
    return port


def agent_endpoint() -> tuple[str, int]:
    host = os.environ.get("CODING_AGENT_HOST")
    if not host:
        ws = os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace-local")
        host = f"{ws}-coding-agent"
    try:
        port = int(os.environ.get("CODING_AGENT_SSH_PORT", DEFAULT_AGENT_SSH_PORT))
    except ValueError:
        port = DEFAULT_AGENT_SSH_PORT
    return host, port


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """Shovel bytes one direction until EOF, then half-close the far side.

    The half-close (``write_eof``) matters: SSH shutdown is asymmetric, and
    tearing the whole connection down on the first EOF would cut off the
    peer's in-flight close messages.
    """
    try:
        while True:
            chunk = await reader.read(BUFFER_SIZE)
            if not chunk:
                break
            writer.write(chunk)
            await writer.drain()
    except (ConnectionError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            if writer.can_write_eof():
                writer.write_eof()
        except (ConnectionError, RuntimeError):
            pass


async def _handle_client(
    client_reader: asyncio.StreamReader,
    client_writer: asyncio.StreamWriter,
    agent_host: str,
    agent_port: int,
) -> None:
    # Dial the agent before touching any client bytes so an unreachable
    # agent surfaces to the SSH client as an immediate clean close rather
    # than a hang.
    try:
        upstream_reader, upstream_writer = await asyncio.wait_for(
            asyncio.open_connection(agent_host, agent_port),
            timeout=CONNECT_TIMEOUT_SECONDS,
        )
    except (OSError, asyncio.TimeoutError) as e:
        logger.warning(
            "agent-ssh-proxy: cannot reach %s:%d: %s", agent_host, agent_port, e
        )
        client_writer.close()
        return

    try:
        await asyncio.gather(
            _pipe(client_reader, upstream_writer),
            _pipe(upstream_reader, client_writer),
        )
    finally:
        for w in (client_writer, upstream_writer):
            try:
                w.close()
            except Exception:
                pass


async def create_proxy(
    listen_host: str,
    port: int,
    agent_host: str,
    agent_port: int,
) -> asyncio.Server:
    """Start a TCP proxy server forwarding every connection to the agent."""

    async def handler(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        await _handle_client(reader, writer, agent_host, agent_port)

    return await asyncio.start_server(handler, listen_host, port)


async def start_agent_ssh_proxy() -> asyncio.Server | None:
    """Lifespan entry point: start the proxy from env config.

    Returns the running server (caller closes it on shutdown), or None when
    disabled or when the listen socket can't be bound — a broken proxy must
    not take gitops down with it, it only costs the dashboard's agent tab.
    """
    port = listen_port()
    if port == 0:
        logger.info("agent-ssh-proxy disabled (BITSWAN_AGENT_SSH_PROXY_PORT=0)")
        return None
    agent_host, agent_port = agent_endpoint()
    try:
        server = await create_proxy("0.0.0.0", port, agent_host, agent_port)
    except OSError as e:
        logger.warning("agent-ssh-proxy failed to bind :%d: %s", port, e)
        return None
    logger.info(
        "agent-ssh-proxy listening on :%d, forwarding to %s:%d",
        port,
        agent_host,
        agent_port,
    )
    return server
