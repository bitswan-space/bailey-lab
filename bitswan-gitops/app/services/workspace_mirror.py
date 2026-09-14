import asyncio
import logging
import os
import re
import time
from datetime import datetime, timezone
from typing import Callable

from app.services import git_server
from app.services import workspace_git_remote as remote_cfg
from app.services.git_server import bp_bare_repo_path, list_bp_repos, validate_bp_name
from app.task_queue import TaskStatus, current_requester, task_queue
from app.utils import bp_state_dir, bp_state_path, read_bitswan_yaml

logger = logging.getLogger(__name__)

MIRROR_DIRNAME = ".workspace-mirror"
STAGES = ("dev", "staging", "production")
GITOPS_BRANCH = "gitops"
COPIES_PREFIX = "copies/"
DEBOUNCE_S = 5.0
FETCH_TIMEOUT_S = 300
LS_REMOTE_TIMEOUT_S = 60
PUSH_TIMEOUT_S = int(os.environ.get("BITSWAN_GIT_REMOTE_PUSH_TIMEOUT", "600"))
TASK_KIND = "mirror push"

_BAILEY_IDENT = ("Bailey", "bailey@bitswan")
_COPY_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9\-]*$")
_ZERO_SHA = "0" * 40


class MirrorError(RuntimeError):
    pass


def mirror_path() -> str:
    return os.path.join(git_server.GIT_REPOS_DIR, MIRROR_DIRNAME)


def _tail(text: str, limit: int = 2000) -> str:
    text = (text or "").strip()
    return text[-limit:]


async def _git(
    *args: str,
    env: dict | None = None,
    stdin: bytes | None = None,
    timeout: float | None = None,
) -> tuple[str, str, int]:
    full_env = dict(os.environ)
    full_env.update(env or {})
    proc = await asyncio.create_subprocess_exec(
        "git",
        *args,
        stdin=asyncio.subprocess.PIPE
        if stdin is not None
        else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=full_env,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(stdin), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise MirrorError(f"git {args[0] if args else ''} timed out after {timeout}s")
    return out.decode(errors="replace"), err.decode(errors="replace"), proc.returncode


async def _mgit(*args: str, **kwargs) -> tuple[str, str, int]:
    return await _git("-C", mirror_path(), *args, **kwargs)


async def _mgit_ok(*args: str, **kwargs) -> str:
    out, err, rc = await _mgit(*args, **kwargs)
    if rc != 0:
        raise MirrorError(f"git {' '.join(args[:2])} failed: {_tail(err, 500)}")
    return out.strip()


def _ident_env(requester: str | None) -> dict:
    who = (requester or "").strip()
    name, email = (who, who) if who else _BAILEY_IDENT
    return {
        "GIT_AUTHOR_NAME": name,
        "GIT_AUTHOR_EMAIL": email,
        "GIT_COMMITTER_NAME": name,
        "GIT_COMMITTER_EMAIL": email,
    }


async def ensure_mirror_repo() -> str:
    path = mirror_path()
    if not os.path.isdir(os.path.join(path, "objects")):
        os.makedirs(path, exist_ok=True)
        _, err, rc = await _git("init", "-q", "--bare", path)
        if rc != 0:
            raise MirrorError(f"failed to init mirror repo: {_tail(err, 500)}")
    await _mgit("config", "http.receivepack", "false")
    return path


async def _ref_is_valid(ref: str) -> bool:
    _, _, rc = await _git("check-ref-format", ref)
    return rc == 0


async def import_bp_repo(bp: str) -> list[str]:
    if not await _ref_is_valid(f"refs/bp/{bp}/heads/main"):
        return [f"{bp}: name cannot be used as a git ref; not mirrored"]
    _, err, rc = await _mgit(
        "fetch",
        "--quiet",
        "--prune",
        "--no-tags",
        bp_bare_repo_path(bp),
        f"+refs/heads/*:refs/bp/{bp}/heads/*",
        f"+refs/tags/deploy/*:refs/bp/{bp}/tags/deploy/*",
        timeout=FETCH_TIMEOUT_S,
    )
    if rc != 0:
        return [f"{bp}: fetch failed: {_tail(err, 300)}"]
    return []


def list_state_bps(gitops_dir: str) -> list[str]:
    base = bp_state_dir(gitops_dir)
    if not os.path.isdir(base):
        return []
    out: list[str] = []
    for entry in sorted(os.listdir(base)):
        if not os.path.isdir(os.path.join(base, entry, ".git")):
            continue
        try:
            validate_bp_name(entry)
        except ValueError:
            continue
        out.append(entry)
    return out


async def import_state_repo(gitops_dir: str, bp: str) -> list[str]:
    if not await _ref_is_valid(f"refs/state/{bp}/main"):
        return [f"{bp}: name cannot be used as a git ref; manifests not mirrored"]
    path = bp_state_path(gitops_dir, bp)
    _, err, rc = await _mgit(
        "fetch",
        "--quiet",
        "--no-tags",
        path,
        f"+refs/heads/main:refs/state/{bp}/main",
        timeout=FETCH_TIMEOUT_S,
    )
    if rc != 0:
        return [f"{bp}: manifests fetch failed: {_tail(err, 300)}"]
    return []


async def _rev(ref: str) -> str | None:
    out, _, rc = await _mgit("rev-parse", "--verify", "-q", ref)
    return out.strip() if rc == 0 and out.strip() else None


async def _commit_exists(sha: str) -> bool:
    _, _, rc = await _mgit("cat-file", "-e", f"{sha}^{{commit}}")
    return rc == 0


async def _is_ancestor(ancestor: str, descendant: str) -> bool:
    _, _, rc = await _mgit("merge-base", "--is-ancestor", ancestor, descendant)
    return rc == 0


async def _tree_of(commitish: str) -> str | None:
    tree = await _rev(f"{commitish}^{{tree}}")
    if not tree:
        return None
    out, _, rc = await _mgit("ls-tree", tree)
    if rc != 0 or not out.strip():
        return None
    return tree


Entry = tuple[str, str | None]


async def resolve_stage_entries(
    bps: list[str],
    stage: str,
    stage_commit: Callable[[str, str], str | None],
    prev_tip: str | None,
) -> tuple[dict[str, Entry], list[str]]:
    entries: dict[str, Entry] = {}
    warnings: list[str] = []
    for bp in bps:
        sha = stage_commit(bp, stage)
        if not sha and stage == "dev":
            sha = await _rev(f"refs/bp/{bp}/heads/main")
        if not sha:
            continue
        if not await _commit_exists(sha):
            prev_tree = await _rev(f"{prev_tip}:{bp}") if prev_tip else None
            if prev_tree:
                entries[bp] = (prev_tree, None)
                warnings.append(
                    f"{bp}/{stage}: commit {sha[:12]} not found in {bp}.git; kept previous tree"
                )
            else:
                warnings.append(
                    f"{bp}/{stage}: commit {sha[:12]} not found in {bp}.git; skipped"
                )
            continue
        tree = await _tree_of(sha)
        if tree:
            entries[bp] = (tree, sha)
    return entries, warnings


async def resolve_copy_entries(bps: list[str]) -> dict[str, dict[str, Entry]]:
    out, _, rc = await _mgit(
        "for-each-ref", "--format=%(refname) %(objectname)", "refs/bp/"
    )
    copies: dict[str, dict[str, Entry]] = {}
    if rc != 0:
        return copies
    wanted = set(bps)
    for line in out.splitlines():
        if not line.strip():
            continue
        refname, sha = line.split(" ", 1)
        parts = refname.split("/")
        if len(parts) < 5 or parts[3] != "heads":
            continue
        bp = parts[2]
        copy = "/".join(parts[4:])
        if bp not in wanted or copy == "main" or not _COPY_NAME_RE.match(copy):
            continue
        tree = await _tree_of(sha)
        if not tree:
            continue
        copies.setdefault(copy, {})[bp] = (tree, sha)
    return copies


async def build_composite_commit(
    branch: str,
    entries: dict[str, Entry],
    *,
    ident_env: dict,
    trigger: str,
    requester: str | None,
) -> str | None:
    if not entries:
        return None
    ref = f"refs/heads/{branch}"
    prev = await _rev(ref)
    listing = "".join(
        f"040000 tree {tree}\t{bp}\n" for bp, (tree, _) in sorted(entries.items())
    )
    root_tree = await _mgit_ok("mktree", stdin=listing.encode())
    if prev and await _rev(f"{prev}^{{tree}}") == root_tree:
        return None

    parents: list[str] = [prev] if prev else []
    changed: list[str] = []
    for bp, (tree, sha) in sorted(entries.items()):
        if prev and await _rev(f"{prev}:{bp}") == tree:
            continue
        changed.append(f"{bp} → {sha[:7] if sha else 'kept'}")
        if sha and sha not in parents and not (prev and await _is_ancestor(sha, prev)):
            parents.append(sha)

    removed: list[str] = []
    if prev:
        names, _, _ = await _mgit("ls-tree", "--name-only", prev)
        removed = [n for n in names.split() if n not in entries]

    summary_parts = list(changed)
    if removed:
        summary_parts.append("removed " + ", ".join(sorted(removed)))
    unchanged = len(entries) - len(changed)
    subject = f"Mirror {branch}: " + ", ".join(summary_parts)
    if unchanged:
        subject += f" (+{unchanged} unchanged)"
    message = (
        f"{subject}\n\nBitswan-Trigger: {trigger}\n"
        f"Bitswan-Requester: {(requester or '').strip() or 'bailey'}\n"
    )

    args = ["commit-tree", root_tree]
    for parent in parents:
        args += ["-p", parent]
    args += ["-m", message]
    new = await _mgit_ok(*args, env=ident_env)
    await _mgit_ok("update-ref", ref, new, prev or _ZERO_SHA)
    return new


async def mirror_deploy_tags(bps: list[str]) -> dict:
    counts = {"created": 0, "existing": 0}
    out, _, rc = await _mgit(
        "for-each-ref", "--format=%(refname) %(objectname)", "refs/bp/"
    )
    if rc != 0:
        return counts
    wanted = set(bps)
    for line in out.splitlines():
        if not line.strip():
            continue
        refname, obj = line.split(" ", 1)
        marker = "/tags/deploy/"
        if marker not in refname:
            continue
        bp = refname.split("/")[2]
        if bp not in wanted:
            continue
        ts = refname.split(marker, 1)[1]
        dst = f"refs/tags/deploy/{bp}/{ts}"
        if await _rev(dst) == obj:
            counts["existing"] += 1
            continue
        await _mgit_ok("update-ref", dst, obj)
        counts["created"] += 1
    return counts


async def _local_copy_branches() -> list[str]:
    out, _, rc = await _mgit(
        "for-each-ref", "--format=%(refname:strip=2)", f"refs/heads/{COPIES_PREFIX}"
    )
    if rc != 0:
        return []
    return [line.strip() for line in out.splitlines() if line.strip()]


async def sync_mirror(
    *,
    gitops_dir: str,
    stage_commit: Callable[[str, str], str | None],
    requester: str | None,
    trigger: str,
) -> dict:
    await ensure_mirror_repo()
    warnings: list[str] = []
    bps = list_bp_repos()
    for bp in bps:
        warnings += await import_bp_repo(bp)
    state_bps = list_state_bps(gitops_dir)
    for bp in state_bps:
        warnings += await import_state_repo(gitops_dir, bp)

    ident = _ident_env(requester)
    build_kwargs = {"ident_env": ident, "trigger": trigger, "requester": requester}
    heads: dict[str, str | None] = {}

    for stage in STAGES:
        prev = await _rev(f"refs/heads/{stage}")
        entries, stage_warnings = await resolve_stage_entries(
            bps, stage, stage_commit, prev
        )
        warnings += stage_warnings
        await build_composite_commit(stage, entries, **build_kwargs)
        heads[stage] = await _rev(f"refs/heads/{stage}")

    manifest_entries: dict[str, Entry] = {}
    for bp in state_bps:
        sha = await _rev(f"refs/state/{bp}/main")
        tree = await _tree_of(sha) if sha else None
        if sha and tree:
            manifest_entries[bp] = (tree, sha)
    await build_composite_commit(GITOPS_BRANCH, manifest_entries, **build_kwargs)
    heads[GITOPS_BRANCH] = await _rev(f"refs/heads/{GITOPS_BRANCH}")

    copy_entries = await resolve_copy_entries(bps)
    previously = set(await _local_copy_branches())
    for copy, entries in sorted(copy_entries.items()):
        branch = f"{COPIES_PREFIX}{copy}"
        await build_composite_commit(branch, entries, **build_kwargs)
        heads[branch] = await _rev(f"refs/heads/{branch}")
    deletions: list[str] = []
    for branch in sorted(previously):
        if branch[len(COPIES_PREFIX) :] in copy_entries:
            continue
        await _mgit("update-ref", "-d", f"refs/heads/{branch}")
        deletions.append(branch)

    tags = await mirror_deploy_tags(bps)
    return {"heads": heads, "deletions": deletions, "tags": tags, "warnings": warnings}


def _parse_ls_remote(out: str) -> dict[str, str]:
    refs: dict[str, str] = {}
    for line in out.splitlines():
        if "\t" not in line:
            continue
        sha, ref = line.split("\t", 1)
        if ref.endswith("^{}"):
            continue
        refs[ref.strip()] = sha.strip()
    return refs


def _parse_porcelain(out: str) -> list[tuple[str, str, str]]:
    rows: list[tuple[str, str, str]] = []
    for line in out.splitlines():
        if len(line) < 2 or line[1] != "\t" or line[0] not in " +-*=!":
            continue
        flag, rest = line[0], line[2:]
        refspec, _, summary = rest.partition("\t")
        _, _, dst = refspec.rpartition(":")
        rows.append((flag, dst.strip(), summary.strip()))
    return rows


async def _local_deploy_tags() -> dict[str, str]:
    out, _, rc = await _mgit(
        "for-each-ref", "--format=%(refname) %(objectname)", "refs/tags/deploy/"
    )
    if rc != 0:
        return {}
    tags: dict[str, str] = {}
    for line in out.splitlines():
        if line.strip():
            ref, sha = line.split(" ", 1)
            tags[ref] = sha
    return tags


async def push_mirror(
    url: str, env: dict, heads: dict[str, str | None], deletions: list[str]
) -> dict:
    result: dict = {
        "result": "ok",
        "error": None,
        "branches": {},
        "tags": {"pushed": 0, "up_to_date": 0, "rejected": 0},
    }
    out, err, rc = await _mgit(
        "ls-remote", "--heads", "--tags", url, env=env, timeout=LS_REMOTE_TIMEOUT_S
    )
    if rc != 0:
        result["result"] = "error"
        result["error"] = f"cannot reach remote: {_tail(err, 800)}"
        return result
    remote = _parse_ls_remote(out)

    refspecs: list[str] = []
    for branch, local in heads.items():
        if not local:
            continue
        ref = f"refs/heads/{branch}"
        remote_sha = remote.get(ref)
        row = {
            "local": local,
            "remote": remote_sha,
            "result": "pending",
            "detail": None,
        }
        if remote_sha == local:
            row["result"] = "up_to_date"
        elif remote_sha is None or (
            await _commit_exists(remote_sha) and await _is_ancestor(remote_sha, local)
        ):
            refspecs.append(f"{ref}:{ref}")
        else:
            row["result"] = "diverged"
            row["detail"] = (
                f"remote {branch} is at {remote_sha[:12]}, which this workspace did not "
                "push; left untouched (never force-pushed)"
            )
        result["branches"][branch] = row

    for branch in deletions:
        ref = f"refs/heads/{branch}"
        if ref not in remote:
            continue
        refspecs.append(f":{ref}")
        result["branches"][branch] = {
            "local": None,
            "remote": remote[ref],
            "result": "pending",
            "detail": "copy no longer exists; deleting on the remote",
        }

    local_tags = await _local_deploy_tags()
    stale_tags = [ref for ref, sha in local_tags.items() if remote.get(ref) != sha]
    result["tags"]["up_to_date"] = len(local_tags) - len(stale_tags)
    if stale_tags:
        refspecs.append("refs/tags/deploy/*:refs/tags/deploy/*")

    if refspecs:
        out, err, rc = await _mgit(
            "push",
            "--porcelain",
            "--no-follow-tags",
            url,
            *refspecs,
            env=env,
            timeout=PUSH_TIMEOUT_S,
        )
        rows = _parse_porcelain(out)
        if rc != 0 and not rows:
            result["result"] = "error"
            result["error"] = f"push failed: {_tail(err, 800)}"
            return result
        for flag, dst, summary in rows:
            if dst.startswith("refs/tags/"):
                if flag == "!":
                    result["tags"]["rejected"] += 1
                elif flag == "=":
                    result["tags"]["up_to_date"] += 1
                else:
                    result["tags"]["pushed"] += 1
                continue
            branch = dst[len("refs/heads/") :] if dst.startswith("refs/heads/") else dst
            row = result["branches"].get(branch)
            if row is None:
                continue
            if flag == "!":
                row["result"] = "rejected"
                row["detail"] = summary or "rejected by the remote"
            elif flag == "=":
                row["result"] = "up_to_date"
            elif flag == "-":
                row["result"] = "deleted"
            else:
                row["result"] = "pushed"
                row["remote"] = row["local"]
        for row in result["branches"].values():
            if row["result"] == "pending":
                row["result"] = "error"
                row["detail"] = _tail(err, 300) or "no result reported by git push"

    rows = result["branches"].values()
    if any(r["result"] == "error" for r in rows):
        result["result"] = "error"
        result["error"] = result["error"] or "some branches could not be pushed"
    elif any(r["result"] == "diverged" for r in rows):
        result["result"] = "diverged"
    elif any(r["result"] == "rejected" for r in rows) or result["tags"]["rejected"]:
        result["result"] = "partial"
    return result


def _service():
    from app.dependencies import get_automation_service

    return get_automation_service()


def stage_commit_lookup(gitops_dir: str) -> Callable[[str, str], str | None]:
    processes = (read_bitswan_yaml(gitops_dir) or {}).get("business_processes") or {}

    def lookup(bp: str, stage: str) -> str | None:
        stage_key = "production" if stage in ("", "production") else stage
        node = ((processes.get(bp) or {}).get(stage_key)) or {}
        return node.get("git_commit") or None

    return lookup


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


async def run_mirror_push(trigger: str, requester: str | None) -> dict:
    svc = _service()
    secrets_dir = svc.secrets_dir
    previous = remote_cfg.load_status(secrets_dir)
    started = time.monotonic()
    status: dict = {
        "result": "unconfigured",
        "trigger": trigger,
        "requester": requester,
        "last_attempt_at": _now_iso(),
        "last_success_at": previous.get("last_success_at"),
        "duration_s": 0.0,
        "error": None,
        "branches": {},
        "tags": {},
        "warnings": [],
    }
    cfg = remote_cfg.load_config(secrets_dir)
    if not cfg["url"]:
        remote_cfg.save_status(secrets_dir, status)
        return status
    try:
        await remote_cfg.ensure_keypair(secrets_dir)
        synced = await sync_mirror(
            gitops_dir=svc.gitops_dir,
            stage_commit=stage_commit_lookup(svc.gitops_dir),
            requester=requester,
            trigger=trigger,
        )
        pushed = await push_mirror(
            cfg["url"],
            remote_cfg.ssh_env(secrets_dir),
            synced["heads"],
            synced["deletions"],
        )
    except Exception as e:
        status["result"] = "error"
        status["error"] = _tail(str(e), 2000)
        status["duration_s"] = round(time.monotonic() - started, 1)
        remote_cfg.save_status(secrets_dir, status)
        raise
    status.update(
        result=pushed["result"],
        error=pushed["error"],
        branches=pushed["branches"],
        tags={**synced["tags"], **pushed["tags"]},
        warnings=synced["warnings"],
        duration_s=round(time.monotonic() - started, 1),
    )
    if pushed["result"] != "error":
        status["last_success_at"] = status["last_attempt_at"]
    remote_cfg.save_status(secrets_dir, status)
    if pushed["result"] == "error":
        raise MirrorError(pushed["error"] or "mirror push failed")
    return status


_queued_task_id: str | None = None
_debounce_handle: asyncio.TimerHandle | None = None
_pending: tuple[str, str | None] | None = None


def reset_for_tests() -> None:
    global _queued_task_id, _debounce_handle, _pending
    if _debounce_handle is not None:
        _debounce_handle.cancel()
    _queued_task_id = None
    _debounce_handle = None
    _pending = None


def push_in_flight() -> bool:
    active = (TaskStatus.QUEUED.value, TaskStatus.RUNNING.value)
    return any(
        t["kind"] == TASK_KIND and t["status"] in active for t in task_queue.snapshot()
    )


def _still_queued(task_id: str | None) -> bool:
    if not task_id:
        return False
    return any(
        t["task_id"] == task_id and t["status"] == TaskStatus.QUEUED.value
        for t in task_queue.snapshot()
    )


def _submit(trigger: str, requester: str | None, url: str) -> str:
    global _queued_task_id

    async def fn():
        global _queued_task_id
        _queued_task_id = None
        return await run_mirror_push(trigger, requester)

    task_id = task_queue.submit(
        TASK_KIND, fn, requester_email=requester, label=remote_cfg.remote_host(url)
    )
    _queued_task_id = task_id
    return task_id


def _fire_debounced() -> None:
    global _debounce_handle, _pending
    _debounce_handle = None
    pending, _pending = _pending, None
    if pending is None or _still_queued(_queued_task_id):
        return
    url = remote_cfg.load_config(_service().secrets_dir)["url"]
    if not url:
        return
    try:
        _submit(pending[0], pending[1], url)
    except Exception:
        logger.warning("debounced mirror push could not be queued", exc_info=True)


def request_push(
    trigger: str, requester: str | None = None, *, immediate: bool = False
) -> str | None:
    global _debounce_handle, _pending
    requester = (requester or "").strip() or current_requester.get()
    url = remote_cfg.load_config(_service().secrets_dir)["url"]
    if not url:
        return None
    if _still_queued(_queued_task_id):
        return _queued_task_id
    if immediate:
        if _debounce_handle is not None:
            _debounce_handle.cancel()
            _debounce_handle = None
            _pending = None
        return _submit(trigger, requester, url)
    _pending = (trigger, requester)
    if _debounce_handle is None:
        loop = asyncio.get_running_loop()
        _debounce_handle = loop.call_later(DEBOUNCE_S, _fire_debounced)
    return None


def cancel_pending() -> None:
    global _debounce_handle, _pending
    if _debounce_handle is not None:
        _debounce_handle.cancel()
    _debounce_handle = None
    _pending = None
