"""Copy management.

A "copy" is an independent ``git clone`` of the workspace's canonical bare repo
(``repo.git``), checked out on its own branch, living at
``${BITSWAN_COPIES_DIR}/<name>``. The ``main`` copy is the editor's working tree
and the default-branch scope; other copies are per-agent / per-task checkouts.
Each copy's ``origin`` points at the embedded smart-HTTP git server so agents
push/pull with normal git (fast-forward only).

This replaces the old shared-``.git`` worktree model. The router is served under
``/copies``.
"""

import asyncio
import logging
import os
import re

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.async_docker import get_async_docker_client, DockerError
from app.deploy_runner import spawn_set_deploy
from app.services.automation_service import scan_workspace_sources
from app.services.git_server import bare_repo_path
from app.utils import call_git_command, call_git_command_with_output


logger = logging.getLogger(__name__)

# No prefix here — main.py includes this router under /copies.
router = APIRouter(tags=["copies"])


def _copies_dir() -> str:
    """Base directory holding the per-copy checkouts."""
    return os.environ.get("BITSWAN_COPIES_DIR", "/copies")


def _git_remote_url() -> str:
    """The smart-HTTP URL agents/editor use as ``origin`` for a copy."""
    url = os.environ.get("BITSWAN_GIT_REMOTE")
    if url:
        return url
    ws = os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace")
    return f"http://{ws}-gitops:8079/git/repo.git"


def _get_postgres_secrets(stage: str = "dev") -> dict | None:
    """Read Postgres connection info from the secrets file for the given stage."""
    from app.services.bp_databases import get_service_secrets

    info = get_service_secrets("postgres", stage)
    if (
        info
        and info.get("POSTGRES_USER")
        and info.get("POSTGRES_PASSWORD")
        and info.get("POSTGRES_HOST")
    ):
        return info
    return None


def _copy_db_name(copy_name: str) -> str:
    """Generate a Postgres database name for a copy."""
    safe = re.sub(r"[^a-z0-9_]", "_", copy_name.lower())
    return f"postgres_copy_{safe}"


async def _clone_postgres_db(copy_name: str) -> str:
    """Clone the dev Postgres database for a copy. Returns the new DB name.

    A copy's live-dev backends are wired to connect to ``postgres_copy_<copy>``,
    so when this workspace runs Postgres the database MUST exist — a failure to
    clone it then is fatal (the backend would boot against a nonexistent DB and
    die with an opaque 502). But a workspace with no Postgres yet (e.g. a fresh
    one where a user's personal copy is created before any business process)
    simply has nothing to clone, so we skip — there is no dev DB to copy and the
    per-copy DB is provisioned later when a Postgres-backed BP is deployed.
    Returns the new DB name, or None when Postgres isn't enabled in this
    workspace.
    """
    secrets = _get_postgres_secrets("dev")
    if not secrets:
        logger.info(
            "Postgres not enabled in this workspace; skipping per-copy database "
            "for '%s' (nothing to clone)",
            copy_name,
        )
        return None

    user = secrets["POSTGRES_USER"]
    password = secrets["POSTGRES_PASSWORD"]
    source_db = secrets.get("POSTGRES_DB", "postgres")
    new_db = _copy_db_name(copy_name)

    docker_client = get_async_docker_client()
    workspace_name = os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace-local")
    container_name = f"{workspace_name}__postgres-dev"

    try:
        terminate_sql = (
            f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            f"WHERE datname = '{source_db}' AND pid <> pg_backend_pid();"
        )
        clone_sql = f'CREATE DATABASE "{new_db}" WITH TEMPLATE "{source_db}";'

        containers = await docker_client.list_containers(
            all=False,
            filters={"name": [f"^/{container_name}$"]},
        )
        if not containers:
            raise RuntimeError(
                f"Postgres dev container '{container_name}' not found; cannot "
                f"create the copy database for '{copy_name}'"
            )

        cid = containers[0]["Id"]

        for sql in [terminate_sql, clone_sql]:
            exec_id = await docker_client.exec_create(
                cid,
                [
                    "sh",
                    "-c",
                    f"PGPASSWORD='{password}' psql -U {user} -d postgres -c \"{sql}\"",
                ],
            )
            output = await docker_client.exec_start(exec_id)
            info = await docker_client.exec_inspect(exec_id)
            if info.get("ExitCode", 1) != 0 and "already exists" not in (output or ""):
                raise RuntimeError(
                    f"Postgres command failed (exit {info.get('ExitCode')}) while "
                    f"creating copy database '{new_db}': {output}"
                )

        logger.info(
            f"Cloned Postgres DB '{source_db}' -> '{new_db}' for copy '{copy_name}'"
        )
        return new_db
    except DockerError as e:
        raise RuntimeError(
            f"Failed to clone Postgres DB for copy '{copy_name}': {e}"
        ) from e


async def _drop_postgres_db(copy_name: str) -> None:
    """Drop the copy's Postgres database."""
    secrets = _get_postgres_secrets("dev")
    if not secrets:
        return

    user = secrets["POSTGRES_USER"]
    password = secrets["POSTGRES_PASSWORD"]
    new_db = _copy_db_name(copy_name)

    docker_client = get_async_docker_client()
    workspace_name = os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace-local")
    container_name = f"{workspace_name}__postgres-dev"

    try:
        containers = await docker_client.list_containers(
            all=False,
            filters={"name": [f"^/{container_name}$"]},
        )
        if not containers:
            return

        cid = containers[0]["Id"]

        terminate_sql = (
            f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            f"WHERE datname = '{new_db}' AND pid <> pg_backend_pid();"
        )
        for sql in [terminate_sql, f'DROP DATABASE IF EXISTS "{new_db}";']:
            exec_id = await docker_client.exec_create(
                cid,
                [
                    "sh",
                    "-c",
                    f"PGPASSWORD='{password}' psql -U {user} -d postgres -c \"{sql}\"",
                ],
            )
            await docker_client.exec_start(exec_id)

        logger.info(f"Dropped Postgres DB '{new_db}' for copy '{copy_name}'")
    except Exception as e:
        logger.warning(f"Failed to drop Postgres DB for copy '{copy_name}': {e}")


# Copy names are filesystem path segments AND git branch names AND positional
# git args. Rule out path traversal (no `/`, `.`), leading `-` (option
# injection), and empty strings.
_COPY_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9\-]*$")


def _validate_copy_name(name: str) -> None:
    if not name or not _COPY_NAME_RE.match(name):
        raise HTTPException(
            status_code=400,
            detail=(
                "Invalid copy name: must be alphanumeric with hyphens only "
                "and must not start with a hyphen."
            ),
        )


# Looser ref-name check for an optional client-supplied base branch.
_REF_NAME_RE = re.compile(r"^[A-Za-z0-9._/\-]+$")


def _validate_ref_name(name: str) -> None:
    if (
        not name
        or name.startswith("-")
        or not _REF_NAME_RE.match(name)
        or ".." in name
        or "@{" in name
        or name.startswith(("/", "."))
        or name.endswith(("/", ".", ".lock"))
        or "//" in name
    ):
        raise HTTPException(status_code=400, detail="Invalid ref name")


def _resolve_copy_path(name: str) -> str:
    """Validate `name` and return the realpath to the copy checkout."""
    _validate_copy_name(name)
    base = os.path.realpath(_copies_dir())
    candidate = os.path.realpath(os.path.join(base, name))
    if candidate != base and not candidate.startswith(base + os.sep):
        raise HTTPException(status_code=400, detail="Invalid copy name")
    return candidate


class CreateCopyRequest(BaseModel):
    branch_name: str
    base_branch: str = None  # defaults to main


@router.post("/create")
async def create_copy(body: CreateCopyRequest):
    """Create a new copy: an independent clone of the canonical repo on its own
    branch, with origin set to the smart-HTTP git server."""
    _validate_copy_name(body.branch_name)

    name = body.branch_name
    copy_path = os.path.join(_copies_dir(), name)
    if os.path.exists(copy_path):
        raise HTTPException(status_code=409, detail=f"Copy '{name}' already exists")

    base = "main"
    if body.base_branch:
        _validate_ref_name(body.base_branch)
        base = body.base_branch

    os.makedirs(_copies_dir(), exist_ok=True)
    bare = bare_repo_path()

    # Clone from the local bare repo (fast, direct disk access), branch off the
    # base, publish the new branch back to the bare (the pre-receive hook allows
    # new branches), then repoint origin at the smart-HTTP URL that the agent /
    # editor containers use at runtime.
    if not await call_git_command("git", "clone", bare, copy_path):
        raise HTTPException(status_code=500, detail="Failed to clone canonical repo")

    ok = await call_git_command(
        "git", "checkout", "-b", name, f"origin/{base}", cwd=copy_path
    )
    if not ok:
        await _rm_rf_as_root_in_container(copy_path)
        raise HTTPException(
            status_code=500, detail=f"Failed to create branch '{name}' from '{base}'"
        )

    pub_out, pub_err, pub_rc = await call_git_command_with_output(
        "git", "push", "origin", name, cwd=copy_path
    )
    if pub_rc != 0:
        await _rm_rf_as_root_in_container(copy_path)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to publish branch '{name}': {(pub_err or pub_out).strip()}",
        )

    await call_git_command(
        "git", "remote", "set-url", "origin", _git_remote_url(), cwd=copy_path
    )

    # Clone the Postgres dev database for this copy — the copy's live-dev
    # backends connect to it, so a failure aborts creation.
    try:
        cloned_db = await _clone_postgres_db(name)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

    result = {"name": name, "path": copy_path, "postgres_db": cloned_db}

    # Auto-start live-dev for every automation in the new copy (best-effort).
    try:
        members = scan_workspace_sources(_copies_dir(), copy=name)
        res = await spawn_set_deploy(
            label=f"copy:{name}",
            members=members,
            stage="live-dev",
            copy=name,
        )
        if res.get("deploy"):
            result["deploy_task_id"] = res["deploy"]["task_id"]
        elif res.get("error"):
            result["deploy_error"] = res["error"]
    except Exception as e:
        logger.warning("Copy auto-deploy spawn failed for '%s': %s", name, e)
        result["deploy_error"] = str(e)

    return result


# In-memory cache for the copy list, refreshed by the filesystem watcher in
# lifespan.py and broadcast over SSE. None = never computed yet.
_copies_cache: list[dict] | None = None


async def _git_state(copy_path: str, name: str) -> dict:
    """Read a copy's git state from its own .git (independent clone)."""
    branch = name
    br_out, _, br_rc = await call_git_command_with_output(
        "git", "rev-parse", "--abbrev-ref", "HEAD", cwd=copy_path
    )
    if br_rc == 0 and br_out.strip():
        branch = br_out.strip()

    commit_hash = ""
    commit_message = ""
    log_out, _, log_rc = await call_git_command_with_output(
        "git", "log", "-1", "--format=%H %s", cwd=copy_path
    )
    if log_rc == 0 and log_out.strip():
        parts = log_out.strip().split(" ", 1)
        commit_hash = parts[0] if parts else ""
        commit_message = parts[1] if len(parts) > 1 else ""

    has_requirements = os.path.exists(os.path.join(copy_path, ".requirements.json"))

    # Synced when there are no uncommitted changes and the branch is neither
    # ahead of nor behind origin/main. origin/main is updated by `git fetch`;
    # compare against the locally-known remote ref (cheap, no network).
    status_out, _, _ = await call_git_command_with_output(
        "git", "status", "--porcelain", cwd=copy_path
    )
    has_changes = bool(status_out and status_out.strip())
    synced = False
    if not has_changes:
        _, _, behind_rc = await call_git_command_with_output(
            "git", "merge-base", "--is-ancestor", "origin/main", "HEAD", cwd=copy_path
        )
        _, _, ahead_rc = await call_git_command_with_output(
            "git", "merge-base", "--is-ancestor", "HEAD", "origin/main", cwd=copy_path
        )
        synced = behind_rc == 0 and ahead_rc == 0

    return {
        "name": name,
        "branch": branch,
        "commit_hash": commit_hash,
        "commit_message": commit_message,
        "has_requirements": has_requirements,
        "synced": synced,
    }


async def _compute_copies() -> list[dict]:
    """Enumerate the copies directory and assemble the listing.

    Each copy is an independent clone with its own .git, so state is read
    per-copy. The `main` copy is excluded from the list (it's the editor's
    working tree / default scope, not a user-managed copy).
    """
    copies_base = _copies_dir()
    if not os.path.isdir(copies_base):
        return []

    result = []
    for entry in sorted(os.listdir(copies_base)):
        if entry.startswith(".") or entry == "main":
            continue
        copy_path = os.path.join(copies_base, entry)
        if not os.path.isdir(os.path.join(copy_path, ".git")):
            continue
        try:
            result.append(await _git_state(copy_path, entry))
        except Exception as e:
            logger.warning("Failed to read git state for copy '%s': %s", entry, e)
    return result


async def get_cached_copies() -> list[dict]:
    """Return the cached copy list, computing on first call."""
    global _copies_cache
    if _copies_cache is None:
        _copies_cache = await _compute_copies()
    return _copies_cache


async def refresh_copies() -> list[dict]:
    """Re-run the copy scan and update the cache (called by the watcher)."""
    global _copies_cache
    _copies_cache = await _compute_copies()
    return _copies_cache


@router.get("/")
async def list_copies():
    return await get_cached_copies()


class MergeCopyResponse(BaseModel):
    status: str
    message: str


@router.post("/{name}/merge")
async def merge_copy(name: str):
    """Fast-forward `main` to the copy's branch tip in the canonical repo.

    Append-only: this only succeeds when `main` is an ancestor of the copy's
    branch (a true fast-forward). Otherwise the caller must rebase the copy onto
    the latest main (and push) first — we never rewrite published history.
    """
    _validate_copy_name(name)
    bare = bare_repo_path()

    # Does the branch exist in the canonical repo?
    _, _, exists_rc = await call_git_command_with_output(
        "git", "-C", bare, "rev-parse", "--verify", f"refs/heads/{name}"
    )
    if exists_rc != 0:
        raise HTTPException(status_code=404, detail=f"Copy branch '{name}' not found")

    # main must be an ancestor of the branch tip (fast-forward only).
    _, _, ff_rc = await call_git_command_with_output(
        "git",
        "-C",
        bare,
        "merge-base",
        "--is-ancestor",
        "refs/heads/main",
        f"refs/heads/{name}",
    )
    if ff_rc != 0:
        raise HTTPException(
            status_code=409,
            detail=(
                f"'{name}' is not a fast-forward of main. Rebase the copy onto "
                "the latest main and push, then merge."
            ),
        )

    out, err, rc = await call_git_command_with_output(
        "git", "-C", bare, "update-ref", "refs/heads/main", f"refs/heads/{name}"
    )
    if rc != 0:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to fast-forward main: {(err or out).strip()}",
        )

    return {
        "status": "success",
        "message": f"main fast-forwarded to '{name}'",
    }


def _own_container_id_from_proc() -> str | None:
    cgroup_re = re.compile(r"docker[-/]([0-9a-f]{64})")
    try:
        with open("/proc/self/cgroup") as f:
            for line in f:
                m = cgroup_re.search(line)
                if m:
                    return m.group(1)
    except OSError:
        pass
    try:
        with open("/proc/self/mountinfo") as f:
            for line in f:
                m = re.search(r"/containers/([0-9a-f]{64})/", line)
                if m:
                    return m.group(1)
    except OSError:
        pass
    return None


async def _own_container_id_from_api() -> str | None:
    hostname = os.uname().nodename
    if not hostname:
        return None
    try:
        client = get_async_docker_client()
        containers = await client.list_containers(filters={"status": ["running"]})
        for c in containers:
            cid = c.get("Id")
            if not cid:
                continue
            try:
                info = await client.get_container(cid)
                if info.get("Config", {}).get("Hostname") == hostname:
                    return cid
            except DockerError:
                continue
    except Exception as e:
        logger.debug("Docker API container lookup failed: %s", e)
    return None


async def _own_container_id() -> str | None:
    return _own_container_id_from_proc() or await _own_container_id_from_api()


async def _rm_rf_as_root_in_container(path: str) -> bool:
    """Wipe `path` as root via docker exec into our own container.

    A copy's working tree contains files created by other containers (editor,
    live-dev automations, build outputs) that uid 1000 often can't unlink. We
    have the Docker socket, so re-enter our own container as root to remove it.
    """
    container_id = await _own_container_id()
    if not container_id:
        logger.warning(
            "rm -rf %s: could not determine own container ID; cannot docker exec as root",
            path,
        )
        return False
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker",
            "exec",
            "--user",
            "0",
            container_id,
            "rm",
            "-rf",
            path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            logger.warning(
                "rm -rf %s via docker exec failed (%s): %s",
                path,
                proc.returncode,
                stderr.decode(errors="replace").strip(),
            )
            return False
        return True
    except Exception as e:
        logger.warning("rm -rf %s via docker exec raised: %s", path, e)
        return False


class CommitRequest(BaseModel):
    message: str
    copy: str | None = None  # None = the main copy
    paths: list[str] | None = None  # None/empty = stage all changes (-A)


@router.post("/commit")
async def commit_changes(body: CommitRequest):
    """Stage and commit changes in a copy (or the main copy when copy is
    None). Used by the editor UI to record filesystem changes it just made."""
    copy = body.copy or "main"
    repo_path = _resolve_copy_path(copy)
    if not os.path.exists(repo_path):
        raise HTTPException(status_code=404, detail=f"Copy '{copy}' not found")

    safe_paths: list[str] | None = None
    if body.paths:
        for p in body.paths:
            if os.path.isabs(p) or any(part == ".." for part in p.split(os.sep)):
                raise HTTPException(status_code=400, detail=f"Invalid path: {p}")
        safe_paths = body.paths

    if safe_paths:
        success = await call_git_command("git", "add", "--", *safe_paths, cwd=repo_path)
    else:
        success = await call_git_command("git", "add", "-A", cwd=repo_path)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to stage changes")

    stdout, stderr, rc = await call_git_command_with_output(
        "git", "commit", "-m", body.message, cwd=repo_path
    )
    if rc != 0:
        combined = (stdout or "") + (stderr or "")
        if "nothing to commit" in combined:
            return {"status": "noop", "message": "Nothing to commit"}
        raise HTTPException(
            status_code=500, detail=f"Failed to commit: {(stderr or stdout).strip()}"
        )

    hash_stdout, _, hash_rc = await call_git_command_with_output(
        "git", "rev-parse", "HEAD", cwd=repo_path
    )
    return {
        "status": "success",
        "commit_hash": hash_stdout.strip() if hash_rc == 0 else "unknown",
    }


@router.delete("/{name}")
async def delete_copy(name: str):
    """Delete a copy: remove its checkout and drop its Postgres database. The
    published branch in the canonical repo is left intact (append-only)."""
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    await _drop_postgres_db(name)

    # uid 1000 often can't unlink files created by other containers — try a
    # plain rmtree, then fall back to a privileged docker-exec rm.
    import shutil

    try:
        shutil.rmtree(copy_path)
    except Exception:
        if not await _rm_rf_as_root_in_container(copy_path):
            raise HTTPException(
                status_code=500, detail=f"Failed to remove copy '{name}'"
            )

    return {"status": "success", "message": f"Copy '{name}' deleted"}


def _is_safe_relative_path(p: str) -> bool:
    if not p:
        return False
    if p.startswith("/") or p.startswith("\\"):
        return False
    parts = re.split(r"[\\/]", p)
    return not any(seg in ("", "..") for seg in parts)


def _porcelain_to_kind(code: str) -> str | None:
    if not code:
        return None
    x, y = code[0], code[1] if len(code) > 1 else " "
    if x == "?" and y == "?":
        return "A"
    if x == "D" or y == "D":
        return "D"
    if x == "A" or y == "A":
        return "A"
    if x == "R" or y == "R":
        return "M"
    if x == "M" or y == "M" or x == "T" or y == "T" or x == "C" or y == "C":
        return "M"
    return None


@router.get("/{name}/status")
async def get_copy_status(name: str):
    """Per-file change list for a copy (status --porcelain + diff --numstat)."""
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    status_out, status_err, status_rc = await call_git_command_with_output(
        "git", "status", "--porcelain=v1", "-z", cwd=copy_path
    )
    if status_rc != 0:
        raise HTTPException(
            status_code=500, detail=f"git status failed: {status_err.strip()}"
        )

    changed: list[dict] = []
    records = status_out.split("\x00")
    skip_next = False
    for rec in records:
        if skip_next:
            skip_next = False
            continue
        if not rec:
            continue
        code = rec[:2]
        path = rec[3:] if len(rec) > 3 else ""
        kind = _porcelain_to_kind(code)
        if not kind or not path:
            continue
        if code[0] == "R" or code[1] == "R":
            skip_next = True
        changed.append({"path": path, "kind": kind, "adds": 0, "dels": 0})

    numstat_out, _, numstat_rc = await call_git_command_with_output(
        "git", "diff", "--numstat", "HEAD", cwd=copy_path
    )
    if numstat_rc == 0:
        by_path = {c["path"]: c for c in changed}
        for line in numstat_out.splitlines():
            parts = line.split("\t", 2)
            if len(parts) != 3:
                continue
            adds_str, dels_str, path = parts
            adds = int(adds_str) if adds_str.isdigit() else 0
            dels = int(dels_str) if dels_str.isdigit() else 0
            entry = by_path.get(path)
            if entry is not None:
                entry["adds"] = adds
                entry["dels"] = dels

    return {"changed": changed}


@router.get("/{name}/diff")
async def get_copy_diff(name: str, path: str | None = Query(None)):
    """Unified diff of the copy against its own HEAD. Optional `?path=` filter."""
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    git_args: list[str] = ["git", "diff", "HEAD"]
    if path is not None:
        if not _is_safe_relative_path(path):
            raise HTTPException(status_code=400, detail="invalid path")
        git_args += ["--", path]
    else:
        git_args += ["--", "."]

    stdout, stderr, rc = await call_git_command_with_output(*git_args, cwd=copy_path)
    if rc != 0:
        raise HTTPException(
            status_code=500, detail=f"Failed to get diff: {stderr.strip()}"
        )

    return {"diff": stdout}
