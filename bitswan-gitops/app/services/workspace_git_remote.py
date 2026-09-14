import asyncio
import json
import os
import re
import shlex
import tempfile
from datetime import datetime, timezone

REMOTE_SUBDIR = "git-remote"
PRIVATE_KEY = "id_ed25519"
PUBLIC_KEY = "id_ed25519.pub"
KNOWN_HOSTS = "known_hosts"
CONFIG_FILE = "config.json"
STATUS_FILE = "status.json"

ALLOW_LOCAL_REMOTES = os.environ.get("BITSWAN_GIT_REMOTE_ALLOW_LOCAL", "") == "1"

_SCP_LIKE_RE = re.compile(
    r"^(?P<user>[A-Za-z0-9._-]+)@(?P<host>[A-Za-z0-9.-]+):(?P<path>[^\s:]+)$"
)
_SSH_URL_RE = re.compile(
    r"^ssh://(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+(?::\d{1,5})?/\S+$"
)
_LOCAL_RE = re.compile(r"^(?:file:///|/)\S+$")

SSH_ONLY_MESSAGE = (
    "Only SSH remotes are supported — the workspace authenticates with its "
    "deploy key. Use git@host:org/repo.git or ssh://git@host/org/repo.git."
)


class RemoteUrlError(ValueError):
    pass


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def remote_dir(secrets_dir: str) -> str:
    path = os.path.join(secrets_dir, REMOTE_SUBDIR)
    os.makedirs(path, mode=0o700, exist_ok=True)
    os.chmod(path, 0o700)
    return path


def _write_private_file(path: str, data: bytes, mode: int = 0o600) -> None:
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _write_private_json(path: str, obj: dict) -> None:
    _write_private_file(path, json.dumps(obj, indent=2, sort_keys=True).encode())


def _read_json(path: str) -> dict | None:
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def load_config(secrets_dir: str) -> dict:
    cfg = _read_json(os.path.join(secrets_dir, REMOTE_SUBDIR, CONFIG_FILE)) or {}
    return {
        "url": cfg.get("url") or None,
        "updated_at": cfg.get("updated_at"),
        "updated_by": cfg.get("updated_by"),
    }


def save_config(secrets_dir: str, url: str | None, by: str | None) -> dict:
    cfg = {"url": url or None, "updated_at": _now_iso(), "updated_by": by or None}
    _write_private_json(os.path.join(remote_dir(secrets_dir), CONFIG_FILE), cfg)
    return cfg


def load_status(secrets_dir: str) -> dict:
    return _read_json(os.path.join(secrets_dir, REMOTE_SUBDIR, STATUS_FILE)) or {
        "result": "unconfigured",
        "last_attempt_at": None,
        "last_success_at": None,
        "error": None,
        "branches": {},
        "tags": {},
        "warnings": [],
    }


def save_status(secrets_dir: str, status: dict) -> None:
    _write_private_json(os.path.join(remote_dir(secrets_dir), STATUS_FILE), status)


def validate_remote_url(url: str) -> str:
    candidate = (url or "").strip()
    if not candidate:
        raise RemoteUrlError("A git remote URL is required.")
    if candidate.startswith("-"):
        raise RemoteUrlError("The remote URL may not start with '-'.")
    if any(ch.isspace() for ch in candidate):
        raise RemoteUrlError("The remote URL may not contain whitespace.")
    if re.match(r"^https?://", candidate, re.IGNORECASE):
        raise RemoteUrlError(SSH_ONLY_MESSAGE)
    if _SCP_LIKE_RE.match(candidate) or _SSH_URL_RE.match(candidate):
        return candidate
    if _LOCAL_RE.match(candidate):
        if ALLOW_LOCAL_REMOTES:
            return candidate
        raise RemoteUrlError(
            "Local path remotes are disabled on this server. " + SSH_ONLY_MESSAGE
        )
    raise RemoteUrlError(SSH_ONLY_MESSAGE)


def remote_host(url: str) -> str:
    m = _SCP_LIKE_RE.match(url)
    if m:
        return m.group("host")
    m = re.match(r"^ssh://(?:[^@/]+@)?([A-Za-z0-9.-]+)", url)
    if m:
        return m.group(1)
    return "local"


def private_key_path(secrets_dir: str) -> str:
    return os.path.join(remote_dir(secrets_dir), PRIVATE_KEY)


def public_key_path(secrets_dir: str) -> str:
    return os.path.join(remote_dir(secrets_dir), PUBLIC_KEY)


def known_hosts_path(secrets_dir: str) -> str:
    return os.path.join(remote_dir(secrets_dir), KNOWN_HOSTS)


async def _run(*argv: str) -> tuple[str, str, int]:
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    out, err = await proc.communicate()
    return out.decode(), err.decode(), proc.returncode


def _read_public_key(secrets_dir: str) -> str:
    with open(public_key_path(secrets_dir)) as f:
        return f.read().strip()


async def ensure_keypair(secrets_dir: str) -> str:
    key = private_key_path(secrets_dir)
    pub = public_key_path(secrets_dir)
    if os.path.isfile(key) and os.path.isfile(pub):
        return _read_public_key(secrets_dir)
    workspace = os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace")
    with tempfile.TemporaryDirectory(dir=remote_dir(secrets_dir)) as tmp:
        tmp_key = os.path.join(tmp, PRIVATE_KEY)
        _, err, rc = await _run(
            "ssh-keygen",
            "-q",
            "-t",
            "ed25519",
            "-N",
            "",
            "-C",
            f"bitswan-gitops-{workspace}",
            "-f",
            tmp_key,
        )
        if rc != 0:
            raise RuntimeError(f"ssh-keygen failed: {err.strip()}")
        with open(tmp_key, "rb") as f:
            _write_private_file(key, f.read(), 0o600)
        with open(tmp_key + ".pub", "rb") as f:
            _write_private_file(pub, f.read(), 0o644)
    return _read_public_key(secrets_dir)


async def key_fingerprint(secrets_dir: str) -> str:
    out, _, rc = await _run("ssh-keygen", "-lf", public_key_path(secrets_dir))
    if rc != 0:
        return ""
    for token in out.split():
        if token.startswith("SHA256:"):
            return token
    return ""


def ssh_env(secrets_dir: str, *, connect_timeout: int = 20) -> dict:
    known_hosts = known_hosts_path(secrets_dir)
    if not os.path.exists(known_hosts):
        _write_private_file(known_hosts, b"", 0o600)
    ssh_command = " ".join(
        [
            "ssh",
            "-F",
            "/dev/null",
            "-i",
            shlex.quote(private_key_path(secrets_dir)),
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            f"UserKnownHostsFile={shlex.quote(known_hosts)}",
            "-o",
            f"ConnectTimeout={int(connect_timeout)}",
        ]
    )
    return {"GIT_SSH_COMMAND": ssh_command, "GIT_TERMINAL_PROMPT": "0"}


async def public_view(secrets_dir: str) -> dict:
    public_key = await ensure_keypair(secrets_dir)
    cfg = load_config(secrets_dir)
    return {
        "url": cfg["url"],
        "updated_at": cfg["updated_at"],
        "updated_by": cfg["updated_by"],
        "public_key": public_key,
        "fingerprint": await key_fingerprint(secrets_dir),
        "status": load_status(secrets_dir),
    }
