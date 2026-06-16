"""Embedded fast-forward-only smart-HTTP git server.

Serves the workspace's canonical bare repo (`repo.git`) over git's smart-HTTP
protocol by driving the stock ``git http-backend`` CGI. Coding agents and the
editor clone/fetch/push here with plain git; the bare repo's ``pre-receive``
hook (see ``app/services/git_server.py``) keeps history append-only.

Auth reuses the existing coding-agent bearer secret. git clients authenticate
with HTTP Basic (any username, password = the agent secret) via a credential
helper, or with an explicit ``Authorization: Bearer <secret>`` header.
"""

import asyncio
import base64
import logging
import os

from fastapi import APIRouter, Request
from fastapi.responses import Response, StreamingResponse

from app.routes.agent import _resolve_agent_secret
from app.services.git_server import GIT_REPOS_DIR

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/git", tags=["git"])

# Stock CGI shipped with git. Override only if the image puts it elsewhere.
GIT_HTTP_BACKEND = os.environ.get(
    "GIT_HTTP_BACKEND", "/usr/lib/git-core/git-http-backend"
)

_UNAUTH_HEADERS = {"WWW-Authenticate": 'Basic realm="bitswan git"'}


def _valid_secrets() -> set[str]:
    """Secrets accepted by the git server.

    The coding agents authenticate with their agent secret; the editor (and
    other gitops-trusted callers) authenticate with the gitops/deploy secret.
    Both are allowed so each can push/pull with normal git.
    """
    secrets = set()
    agent = _resolve_agent_secret()
    if agent:
        secrets.add(agent)
    gitops = os.environ.get("BITSWAN_GITOPS_SECRET", "")
    if gitops:
        secrets.add(gitops)
    return secrets


def _authorized(request: Request) -> bool:
    """True if the request carries an accepted secret (Basic password or Bearer)."""
    secrets = _valid_secrets()
    if not secrets:
        return False
    header = request.headers.get("authorization", "")
    if not header:
        return False
    scheme, _, value = header.partition(" ")
    scheme = scheme.lower()
    if scheme == "bearer":
        return value in secrets
    if scheme == "basic":
        try:
            decoded = base64.b64decode(value).decode("utf-8", "replace")
        except Exception:
            return False
        # "<user>:<password>" — the password carries the secret.
        _, _, password = decoded.partition(":")
        return password in secrets
    return False


def _cgi_env(request: Request, path: str) -> dict:
    """Build the CGI environment for git-http-backend."""
    env = {
        # Minimal, controlled environment for the CGI.
        "PATH": os.environ.get("PATH", "/usr/bin:/bin:/usr/lib/git-core"),
        "GIT_PROJECT_ROOT": GIT_REPOS_DIR,
        "GIT_HTTP_EXPORT_ALL": "1",
        "PATH_INFO": "/" + path,
        "REQUEST_METHOD": request.method,
        "QUERY_STRING": request.url.query or "",
        "REMOTE_USER": "agent",
        "REMOTE_ADDR": request.client.host if request.client else "",
        "GATEWAY_INTERFACE": "CGI/1.1",
        "SERVER_PROTOCOL": "HTTP/1.1",
    }
    content_type = request.headers.get("content-type")
    if content_type:
        env["CONTENT_TYPE"] = content_type
    content_length = request.headers.get("content-length")
    if content_length:
        env["CONTENT_LENGTH"] = content_length
    # git-http-backend inflates gzipped upload-pack request bodies itself.
    content_encoding = request.headers.get("content-encoding")
    if content_encoding:
        env["HTTP_CONTENT_ENCODING"] = content_encoding
    # Protocol v2 negotiation is carried in the Git-Protocol header.
    git_protocol = request.headers.get("git-protocol")
    if git_protocol:
        env["GIT_PROTOCOL"] = git_protocol
    return env


@router.api_route("/{path:path}", methods=["GET", "POST"])
async def git_http(path: str, request: Request):
    if not _authorized(request):
        return Response(status_code=401, headers=_UNAUTH_HEADERS)

    proc = await asyncio.create_subprocess_exec(
        GIT_HTTP_BACKEND,
        env=_cgi_env(request, path),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    async def feed_stdin():
        try:
            async for chunk in request.stream():
                if chunk:
                    proc.stdin.write(chunk)
                    await proc.stdin.drain()
        except Exception as e:  # client disconnect, etc.
            logger.debug("git-http: stdin feed interrupted: %s", e)
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass

    feed_task = asyncio.create_task(feed_stdin())

    # Parse the CGI header block (lines terminated by a blank line).
    status_code = 200
    headers: dict[str, str] = {}
    while True:
        line = await proc.stdout.readline()
        if not line or line in (b"\r\n", b"\n"):
            break
        decoded = line.decode("latin-1").rstrip("\r\n")
        key, sep, value = decoded.partition(":")
        if not sep:
            continue
        key = key.strip()
        value = value.strip()
        if key.lower() == "status":
            try:
                status_code = int(value.split()[0])
            except (ValueError, IndexError):
                pass
        else:
            headers[key] = value

    async def body_stream():
        try:
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    break
                yield chunk
        finally:
            await feed_task
            await proc.wait()
            if proc.returncode:
                stderr = (await proc.stderr.read()).decode("utf-8", "replace")
                if stderr.strip():
                    logger.warning("git-http-backend stderr: %s", stderr.strip())

    return StreamingResponse(body_stream(), status_code=status_code, headers=headers)
