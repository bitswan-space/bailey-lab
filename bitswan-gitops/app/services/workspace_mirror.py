import asyncio
import logging
import os
import time
from datetime import datetime, timezone

from app.services import git_server
from app.services import workspace_git_remote as remote_cfg
from app.services.bp_git import ff_main_to_ref, refresh_main_bp_checkout
from app.services.git_server import bp_bare_repo_path, list_bp_repos, validate_bp_name
from app.services.workspace_readme import workspace_readme
from app.task_queue import TaskStatus, current_requester, task_queue
from app.utils import bp_state_dir, bp_state_path

logger = logging.getLogger(__name__)

MIRROR_DIRNAME = ".workspace-mirror"
MAIN_BRANCH = "main"
GITOPS_BRANCH = "gitops"
BRANCHES = (MAIN_BRANCH, GITOPS_BRANCH)
REMOTE_NS = "refs/remotes/mirror/"
README = "README.md"
DEBOUNCE_S = 5.0
FETCH_TIMEOUT_S = 300
LS_REMOTE_TIMEOUT_S = 60
PUSH_TIMEOUT_S = int(os.environ.get("BITSWAN_GIT_REMOTE_PUSH_TIMEOUT", "600"))
TASK_KIND = "mirror push"
INBOUND_TMP_REF = "refs/sync-tmp/remote-main"

_BAILEY_IDENT = ("Bailey", "bailey@bitswan")
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
        f"+refs/heads/main:refs/bp/{bp}/heads/main",
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
    _, err, rc = await _mgit(
        "fetch",
        "--quiet",
        "--no-tags",
        bp_state_path(gitops_dir, bp),
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


async def _ls_tree(treeish: str) -> list[tuple[str, str, str, str]]:
    out, _, rc = await _mgit("ls-tree", treeish)
    rows: list[tuple[str, str, str, str]] = []
    if rc != 0:
        return rows
    for line in out.splitlines():
        if not line.strip():
            continue
        meta, name = line.split("\t", 1)
        mode, kind, sha = meta.split(" ")
        rows.append((mode, kind, sha, name))
    return rows


Entry = tuple[str, str | None]


async def _readme_blob() -> str:
    text = workspace_readme(
        os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace"),
        os.environ.get("BITSWAN_GITOPS_DOMAIN", ""),
    )
    return await _mgit_ok("hash-object", "-w", "--stdin", stdin=text.encode())


async def build_composite_commit(
    branch: str,
    entries: dict[str, Entry],
    *,
    ident_env: dict,
    trigger: str,
    requester: str | None,
    with_readme: bool = False,
    mirrored_ns: str = "refs/bp/",
) -> str | None:
    if not entries:
        return None
    ref = f"refs/heads/{branch}"
    prev = await _rev(ref)
    lines = [f"040000 tree {tree}\t{bp}" for bp, (tree, _) in sorted(entries.items())]
    kept_root_files: list[str] = []
    removed: list[str] = []
    if prev:
        for mode, kind, sha, name in await _ls_tree(prev):
            if name in entries:
                continue
            if kind == "tree" and await _rev(f"{mirrored_ns}{name}/main"):
                removed.append(name)
                continue
            if kind == "tree" and await _rev(f"{mirrored_ns}{name}/heads/main"):
                removed.append(name)
                continue
            lines.append(f"{mode} {kind} {sha}\t{name}")
            if kind != "tree":
                kept_root_files.append(name)
    if with_readme and README not in kept_root_files and README not in entries:
        lines.append(f"100644 blob {await _readme_blob()}\t{README}")
    root_tree = await _mgit_ok("mktree", stdin=("\n".join(lines) + "\n").encode())
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

    summary_parts = list(changed)
    if removed:
        summary_parts.append("removed " + ", ".join(sorted(removed)))
    if not summary_parts:
        summary_parts.append(README)
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
    marker = "/tags/deploy/"
    for line in out.splitlines():
        if not line.strip() or marker not in line:
            continue
        refname, obj = line.split(" ", 1)
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


async def fetch_remote(url: str, env: dict) -> dict[str, str | None]:
    out, err, rc = await _mgit(
        "ls-remote", "--heads", "--tags", url, env=env, timeout=LS_REMOTE_TIMEOUT_S
    )
    if rc != 0:
        raise MirrorError(f"cannot reach remote: {_tail(err, 800)}")
    remote = _parse_ls_remote(out)
    refspecs = []
    heads: dict[str, str | None] = {}
    for branch in BRANCHES:
        sha = remote.get(f"refs/heads/{branch}")
        heads[branch] = sha
        if sha:
            refspecs.append(f"+refs/heads/{branch}:{REMOTE_NS}{branch}")
        else:
            await _mgit("update-ref", "-d", f"{REMOTE_NS}{branch}")
    if refspecs:
        _, err, rc = await _mgit(
            "fetch",
            "--quiet",
            "--no-tags",
            url,
            *refspecs,
            env=env,
            timeout=FETCH_TIMEOUT_S,
        )
        if rc != 0:
            raise MirrorError(f"cannot fetch remote branches: {_tail(err, 800)}")
    heads["_tags"] = remote
    return heads


async def classify(local: str | None, remote: str | None) -> str:
    if remote is None:
        return "absent"
    if local is None:
        return "ahead"
    if local == remote:
        return "equal"
    if await _is_ancestor(local, remote):
        return "ahead"
    if await _is_ancestor(remote, local):
        return "behind"
    return "diverged"


async def _remote_author_env(remote: str, prev: str | None, folder: str) -> dict:
    span = f"{prev}..{remote}" if prev else remote
    out, _, rc = await _mgit(
        "log", "-1", "--format=%an%x00%ae%x00%aI", span, "--", folder
    )
    env = _ident_env(None)
    if rc == 0 and out.strip():
        name, email, date = (out.strip().split("\x00") + ["", "", ""])[:3]
        if name:
            env["GIT_AUTHOR_NAME"] = name
        if email:
            env["GIT_AUTHOR_EMAIL"] = email
        if date:
            env["GIT_AUTHOR_DATE"] = date
    return env


async def _remote_subjects(remote: str, prev: str | None, folder: str) -> list[str]:
    span = f"{prev}..{remote}" if prev else remote
    out, _, rc = await _mgit("log", "-5", "--format=%s", span, "--", folder)
    if rc != 0:
        return []
    return [line.strip() for line in out.splitlines() if line.strip()]


async def _merged_tree(base_tree: str, local_tree: str, remote_tree: str) -> str | None:
    env = _ident_env(None)
    base = await _mgit_ok("commit-tree", base_tree, "-m", "base", env=env)
    ours = await _mgit_ok("commit-tree", local_tree, "-p", base, "-m", "ours", env=env)
    theirs = await _mgit_ok(
        "commit-tree", remote_tree, "-p", base, "-m", "theirs", env=env
    )
    out, _, rc = await _mgit("merge-tree", "--write-tree", ours, theirs)
    if rc != 0:
        return None
    return out.splitlines()[0].strip() if out.strip() else None


async def import_inbound(
    prev: str | None, remote: str, bps: list[str], url: str
) -> tuple[list[str], list[str], list[str]]:
    imported: list[str] = []
    conflicts: list[str] = []
    warnings: list[str] = []
    host = remote_cfg.remote_host(url)
    known = set(bps)
    for _, kind, remote_tree, name in await _ls_tree(remote):
        if kind != "tree":
            continue
        if name not in known:
            warnings.append(
                f"{name}/ on the remote is not a business process here; left untouched"
            )
            continue
        local_main = await _rev(f"refs/bp/{name}/heads/main")
        if not local_main:
            warnings.append(f"{name}: no main in {name}.git; remote folder skipped")
            continue
        local_tree = await _rev(f"{local_main}^{{tree}}")
        if remote_tree == local_tree:
            continue
        prev_tree = await _rev(f"{prev}:{name}") if prev else None
        if prev_tree == remote_tree:
            continue
        tree = remote_tree
        if prev_tree and prev_tree != local_tree:
            tree = await _merged_tree(prev_tree, local_tree, remote_tree)
            if not tree:
                conflicts.append(name)
                continue
        subjects = await _remote_subjects(remote, prev, name)
        message = f"Pulled from {host}: " + (
            "; ".join(subjects) if subjects else f"changes to {name}/"
        )
        env = await _remote_author_env(remote, prev, name)
        new = await _mgit_ok(
            "commit-tree", tree, "-p", local_main, "-m", message, env=env
        )
        bare = bp_bare_repo_path(name)
        _, err, rc = await _mgit("push", "--quiet", bare, f"{new}:{INBOUND_TMP_REF}")
        if rc != 0:
            warnings.append(
                f"{name}: could not transfer the pulled commit: {_tail(err, 200)}"
            )
            conflicts.append(name)
            continue
        try:
            await ff_main_to_ref(name, new)
            await refresh_main_bp_checkout(name)
        except Exception as e:
            warnings.append(
                f"{name}: pulled commit not applied to main: {_tail(str(e), 200)}"
            )
            conflicts.append(name)
            continue
        finally:
            await _git("-C", bare, "update-ref", "-d", INBOUND_TMP_REF)
        await import_bp_repo(name)
        imported.append(name)
    return imported, conflicts, warnings


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
    tags: dict[str, str] = {}
    if rc != 0:
        return tags
    for line in out.splitlines():
        if line.strip():
            ref, sha = line.split(" ", 1)
            tags[ref] = sha
    return tags


async def push_refs(
    url: str,
    env: dict,
    branches: list[str],
    remote_tags: dict[str, str],
    *,
    force: bool,
) -> dict:
    result = {
        "branches": {},
        "tags": {"pushed": 0, "up_to_date": 0, "rejected": 0},
        "error": None,
    }
    refspecs = [
        f"{'+' if force else ''}refs/heads/{b}:refs/heads/{b}" for b in branches
    ]
    local_tags = await _local_deploy_tags()
    stale = [ref for ref, sha in local_tags.items() if remote_tags.get(ref) != sha]
    result["tags"]["up_to_date"] = len(local_tags) - len(stale)
    if stale:
        refspecs.append("refs/tags/deploy/*:refs/tags/deploy/*")
    if not refspecs:
        return result
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
        result["error"] = f"push failed: {_tail(err, 800)}"
        for b in branches:
            result["branches"][b] = ("error", result["error"])
        return result
    for flag, dst, summary in rows:
        if dst.startswith("refs/tags/"):
            key = (
                "rejected" if flag == "!" else "up_to_date" if flag == "=" else "pushed"
            )
            result["tags"][key] += 1
            continue
        name = dst[len("refs/heads/") :] if dst.startswith("refs/heads/") else dst
        if flag == "!":
            result["branches"][name] = ("rejected", summary or "rejected by the remote")
        elif flag == "=":
            result["branches"][name] = ("up_to_date", None)
        else:
            result["branches"][name] = ("pushed", None)
    for b in branches:
        result["branches"].setdefault(
            b, ("error", _tail(err, 300) or "no result from git push")
        )
    return result


def _service():
    from app.dependencies import get_automation_service

    return get_automation_service()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _row(local, remote, state, detail=None, **extra) -> dict:
    row = {"local": local, "remote": remote, "result": state, "detail": detail}
    row.update(extra)
    return row


async def run_mirror_sync(
    trigger: str, requester: str | None, *, force: bool = False
) -> dict:
    svc = _service()
    secrets_dir = svc.secrets_dir
    previous = remote_cfg.load_status(secrets_dir)
    started = time.monotonic()
    cfg = remote_cfg.load_config(secrets_dir)
    status: dict = {
        "result": "unconfigured",
        "trigger": trigger,
        "requester": requester,
        "paused": cfg["paused"],
        "last_attempt_at": _now_iso(),
        "last_success_at": previous.get("last_success_at"),
        "duration_s": 0.0,
        "error": None,
        "branches": {},
        "tags": {},
        "warnings": [],
        "inbound": [],
        "conflicts": [],
    }
    if not cfg["url"]:
        remote_cfg.save_status(secrets_dir, status)
        return status
    if cfg["paused"] and not force:
        status["result"] = "paused"
        status["branches"] = previous.get("branches") or {}
        remote_cfg.save_status(secrets_dir, status)
        return status
    url = cfg["url"]
    try:
        await remote_cfg.ensure_keypair(secrets_dir)
        env = remote_cfg.ssh_env(secrets_dir)
        await ensure_mirror_repo()
        bps = list_bp_repos()
        for bp in bps:
            status["warnings"] += await import_bp_repo(bp)
        state_bps = list_state_bps(svc.gitops_dir)
        for bp in state_bps:
            status["warnings"] += await import_state_repo(svc.gitops_dir, bp)

        remote = await fetch_remote(url, env)
        ident = _ident_env(requester)
        build = {"ident_env": ident, "trigger": trigger, "requester": requester}
        to_push: list[str] = []

        local_main = await _rev(f"refs/heads/{MAIN_BRANCH}")
        remote_main = remote[MAIN_BRANCH]
        main_state = await classify(local_main, remote_main)
        if force and main_state in ("diverged", "ahead"):
            main_state = "force"
        if main_state == "ahead":
            imported, conflicts, warnings = await import_inbound(
                local_main, remote_main, bps, url
            )
            status["inbound"] = imported
            status["conflicts"] = conflicts
            status["warnings"] += warnings
            if conflicts:
                main_state = "conflict"
            else:
                await _mgit_ok(
                    "update-ref",
                    f"refs/heads/{MAIN_BRANCH}",
                    remote_main,
                    local_main or _ZERO_SHA,
                )
                for bp in imported:
                    status["warnings"] += await import_bp_repo(bp)
        if main_state in ("absent", "equal", "behind", "ahead", "force"):
            entries: dict[str, Entry] = {}
            for bp in bps:
                sha = await _rev(f"refs/bp/{bp}/heads/main")
                tree = await _tree_of(sha) if sha else None
                if sha and tree:
                    entries[bp] = (tree, sha)
            await build_composite_commit(
                MAIN_BRANCH, entries, with_readme=True, **build
            )
            local_main = await _rev(f"refs/heads/{MAIN_BRANCH}")
            if local_main and local_main != remote_main:
                to_push.append(MAIN_BRANCH)
            status["branches"][MAIN_BRANCH] = _row(
                local_main, remote_main, "up_to_date", inbound=status["inbound"]
            )
        elif main_state == "conflict":
            status["branches"][MAIN_BRANCH] = _row(
                local_main,
                remote_main,
                "conflict",
                "remote changes to "
                + ", ".join(status["conflicts"])
                + " conflict with work in this workspace; main was not pushed",
                inbound=status["inbound"],
                conflicts=status["conflicts"],
            )
        else:
            status["branches"][MAIN_BRANCH] = _row(
                local_main,
                remote_main,
                "diverged",
                f"remote main is at {remote_main[:12]}, which is not a fast-forward of "
                "what this workspace pushed; main was not pushed (never force-pushed)",
            )

        manifest_entries: dict[str, Entry] = {}
        for bp in state_bps:
            sha = await _rev(f"refs/state/{bp}/main")
            tree = await _tree_of(sha) if sha else None
            if sha and tree:
                manifest_entries[bp] = (tree, sha)
        await build_composite_commit(
            GITOPS_BRANCH, manifest_entries, mirrored_ns="refs/state/", **build
        )
        local_gitops = await _rev(f"refs/heads/{GITOPS_BRANCH}")
        remote_gitops = remote[GITOPS_BRANCH]
        gitops_state = await classify(local_gitops, remote_gitops)
        if local_gitops and (gitops_state in ("absent", "behind") or force):
            to_push.append(GITOPS_BRANCH)
            status["branches"][GITOPS_BRANCH] = _row(
                local_gitops, remote_gitops, "up_to_date"
            )
        elif local_gitops and gitops_state == "equal":
            status["branches"][GITOPS_BRANCH] = _row(
                local_gitops, remote_gitops, "up_to_date"
            )
        elif local_gitops:
            status["branches"][GITOPS_BRANCH] = _row(
                local_gitops,
                remote_gitops,
                "diverged",
                f"remote gitops is at {remote_gitops[:12]}, which this workspace did not push; "
                "left untouched",
            )

        status["tags"] = await mirror_deploy_tags(bps)
        pushed = await push_refs(url, env, to_push, remote["_tags"], force=force)
        status["tags"].update(pushed["tags"])
        status["error"] = pushed["error"]
        for name, (state, detail) in pushed["branches"].items():
            row = status["branches"].get(name)
            if row is None:
                continue
            row["result"] = state
            row["detail"] = detail or row.get("detail")
            if state == "pushed":
                row["remote"] = row["local"]
    except Exception as e:
        status["result"] = "error"
        status["error"] = _tail(str(e), 2000)
        status["duration_s"] = round(time.monotonic() - started, 1)
        remote_cfg.save_status(secrets_dir, status)
        raise

    states = [r["result"] for r in status["branches"].values()]
    if status["error"] or "error" in states:
        status["result"] = "error"
        status["error"] = status["error"] or "some branches could not be pushed"
    elif "conflict" in states:
        status["result"] = "conflict"
    elif "diverged" in states:
        status["result"] = "diverged"
    elif "rejected" in states or status["tags"].get("rejected"):
        status["result"] = "partial"
    elif status["inbound"]:
        status["result"] = "inbound"
    else:
        status["result"] = "ok"
    status["duration_s"] = round(time.monotonic() - started, 1)
    if status["result"] != "error":
        status["last_success_at"] = status["last_attempt_at"]
    remote_cfg.save_status(secrets_dir, status)
    if status["result"] == "error":
        raise MirrorError(status["error"])
    return status


async def run_mirror_push(trigger: str, requester: str | None) -> dict:
    return await run_mirror_sync(trigger, requester)


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
    cfg = remote_cfg.load_config(_service().secrets_dir)
    if not cfg["url"] or cfg["paused"]:
        return
    try:
        _submit(pending[0], pending[1], cfg["url"])
    except Exception:
        logger.warning("debounced mirror push could not be queued", exc_info=True)


def request_push(
    trigger: str, requester: str | None = None, *, immediate: bool = False
) -> str | None:
    global _debounce_handle, _pending
    requester = (requester or "").strip() or current_requester.get()
    cfg = remote_cfg.load_config(_service().secrets_dir)
    if not cfg["url"] or cfg["paused"]:
        return None
    if _still_queued(_queued_task_id):
        return _queued_task_id
    if immediate:
        if _debounce_handle is not None:
            _debounce_handle.cancel()
            _debounce_handle = None
            _pending = None
        return _submit(trigger, requester, cfg["url"])
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


async def run_inline(
    trigger: str, requester: str | None, *, force: bool = False
) -> dict:
    task_id = await task_queue.acquire(
        TASK_KIND, requester_email=requester, label=trigger
    )
    try:
        return await run_mirror_sync(trigger, requester, force=force)
    finally:
        task_queue.release(task_id)
