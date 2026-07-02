"""Copy management.

A "copy" is a user's working environment: a plain directory at
``${BITSWAN_COPIES_DIR}/<name>`` whose business-process subdirectories are each
an independent ``git clone`` of that BP's own canonical bare repo
(``<bp>.git`` — see ``app.services.git_server``), checked out on branch
``<name>``. The ``main`` copy is the default-branch scope: each of its BP dirs
is a checkout of that repo's ``main``.

Because every BP has its own repo, syncing one BP is a plain push +
fast-forward of that repo's main — it can never entangle another BP's
changes. Copy-level endpoints aggregate over the copy's BP clones so the API
shapes are unchanged from the single-repo era.

Each clone's ``origin`` points at the embedded smart-HTTP git server so agents
push/pull with normal git (fast-forward only; main is deploy-only).
The router is served under ``/copies``.
"""

import datetime
import logging
import os
import re

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.deploy_runner import spawn_set_deploy
from app.services.automation_service import scan_workspace_sources
from app.services.bp_git import (
    copies_dir as _copies_dir,
)
from app.services.bp_git import (
    fetch_main,
    ff_main_to_ref,
    git_remote_url,
    list_bp_clones,
    refresh_main_bp_checkout,
)
from app.services.git_server import (
    bp_bare_repo_path,
    bp_main_has_content,
    list_bp_repos,
)
from app.utils import (
    call_git_command,
    call_git_command_with_output,
    read_bitswan_yaml,
)


logger = logging.getLogger(__name__)

# No prefix here — main.py includes this router under /copies.
router = APIRouter(tags=["copies"])


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
    """Validate `name` and return the realpath to the copy directory."""
    _validate_copy_name(name)
    base = os.path.realpath(_copies_dir())
    candidate = os.path.realpath(os.path.join(base, name))
    if candidate != base and not candidate.startswith(base + os.sep):
        raise HTTPException(status_code=400, detail="Invalid copy name")
    return candidate


def _validate_bp_dir(bp: str) -> None:
    if bp in (".", "..") or not re.fullmatch(r"[A-Za-z0-9._-]+", bp or ""):
        raise HTTPException(status_code=400, detail="invalid business process name")


async def _clone_bp_into_copy(
    copy_path: str, name: str, bp: str, base: str = "main", allow_empty: bool = False
) -> bool:
    """Materialize BP `bp` inside copy `name` as a clone of its bare repo on
    branch `name`.

    Start-point priority: the copy's own branch if the bare already has it
    (re-materializing a deleted clone dir), else `base` (another copy's
    branch), else main WHEN it has real content. Returns False when there is
    nothing to clone from (the BP exists only as an empty seed) — unless
    `allow_empty` is set (BP creation: the scaffold lands in this fresh clone,
    branched off the seed commit so the first sync is a plain fast-forward).
    The new branch is pushed back to the bare so it exists server-side, and
    origin is repointed at the smart-HTTP URL agents use.
    """
    bare = bp_bare_repo_path(bp)
    clone = os.path.join(copy_path, bp)

    async def _branch_exists(ref: str) -> bool:
        _, _, rc = await call_git_command_with_output(
            "git", "-C", bare, "rev-parse", "--verify", f"refs/heads/{ref}"
        )
        return rc == 0

    if await _branch_exists(name):
        start = name
    elif base != "main" and await _branch_exists(base):
        start = base
    elif allow_empty or await bp_main_has_content(bp):
        start = "main"
    else:
        return False

    if not await call_git_command("git", "clone", bare, clone):
        raise HTTPException(status_code=500, detail=f"Failed to clone {bp}.git")

    if start == name:
        ok = await call_git_command("git", "checkout", name, cwd=clone)
    else:
        ok = await call_git_command(
            "git", "checkout", "-b", name, f"origin/{start}", cwd=clone
        )
    if not ok:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to create branch '{name}' in {bp}",
        )

    if start != name:
        # Publish the new branch (the pre-receive hook allows new branches).
        pub_out, pub_err, pub_rc = await call_git_command_with_output(
            "git", "push", "origin", name, cwd=clone
        )
        if pub_rc != 0:
            raise HTTPException(
                status_code=500,
                detail=(
                    f"Failed to publish branch '{name}' for {bp}: "
                    f"{(pub_err or pub_out).strip()}"
                ),
            )

    await call_git_command(
        "git", "remote", "set-url", "origin", git_remote_url(bp), cwd=clone
    )
    return True


class CreateCopyRequest(BaseModel):
    branch_name: str
    base_branch: str = None  # defaults to main


@router.post("/create")
async def create_copy(body: CreateCopyRequest):
    """Create a new copy: a directory of per-BP clones, each on a new branch
    named after the copy, with origins set to the smart-HTTP git server.

    Eagerly clones every BP whose main has content (matching the old
    "a new copy starts from main" semantics); BPs that exist only in other
    copies appear here after they are synced into main (or via a pull)."""
    _validate_copy_name(body.branch_name)

    name = body.branch_name
    copy_path = os.path.join(_copies_dir(), name)
    if os.path.exists(copy_path):
        raise HTTPException(status_code=409, detail=f"Copy '{name}' already exists")

    base = "main"
    if body.base_branch:
        _validate_ref_name(body.base_branch)
        base = body.base_branch

    os.makedirs(copy_path, exist_ok=True)

    try:
        for bp in list_bp_repos():
            await _clone_bp_into_copy(copy_path, name, bp, base)
    except HTTPException:
        await _rm_rf_as_root_in_container(copy_path)
        raise

    result = {"name": name, "path": copy_path}

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


async def _bp_clone_state(clone_path: str, bp: str) -> dict:
    """Git state of one BP clone: last commit, dirtiness, ahead/behind vs the
    BP repo's main."""
    commit_hash = ""
    commit_message = ""
    commit_ts = 0
    log_out, _, log_rc = await call_git_command_with_output(
        "git", "log", "-1", "--format=%H%x1f%ct%x1f%s", cwd=clone_path
    )
    if log_rc == 0 and log_out.strip():
        f = log_out.strip().split("\x1f")
        if len(f) == 3:
            commit_hash = f[0]
            commit_ts = int(f[1]) if f[1].isdigit() else 0
            commit_message = f[2]

    status_out, _, _ = await call_git_command_with_output(
        "git", "status", "--porcelain", cwd=clone_path
    )
    has_changes = bool(status_out and status_out.strip())

    ahead = behind = 0
    await fetch_main(clone_path, bp)
    ahead_out, _, ahead_rc = await call_git_command_with_output(
        "git", "rev-list", "--count", "FETCH_HEAD..HEAD", cwd=clone_path
    )
    if ahead_rc == 0 and ahead_out.strip().isdigit():
        ahead = int(ahead_out.strip())
    behind_out, _, behind_rc = await call_git_command_with_output(
        "git", "rev-list", "--count", "HEAD..FETCH_HEAD", cwd=clone_path
    )
    if behind_rc == 0 and behind_out.strip().isdigit():
        behind = int(behind_out.strip())

    return {
        "bp": bp,
        "commit_hash": commit_hash,
        "commit_message": commit_message,
        "commit_ts": commit_ts,
        "has_changes": has_changes,
        "ahead": ahead,
        "behind": behind,
    }


async def _git_state(copy_path: str, name: str) -> dict:
    """Aggregate git state of a copy across its per-BP clones.

    ahead/behind are sums, has_changes is any, synced is all — the wire shape
    matches the single-repo era so the dashboard needs no change. The commit
    shown is the newest across the copy's clones.
    """
    states = []
    for bp in list_bp_clones(copy_path):
        try:
            states.append(await _bp_clone_state(os.path.join(copy_path, bp), bp))
        except Exception as e:
            logger.warning("Failed to read state of %s/%s: %s", name, bp, e)

    newest = max(states, key=lambda s: s["commit_ts"], default=None)
    ahead = sum(s["ahead"] for s in states)
    behind = sum(s["behind"] for s in states)
    has_changes = any(s["has_changes"] for s in states)

    has_requirements = os.path.exists(os.path.join(copy_path, ".requirements.json"))

    return {
        "name": name,
        "branch": name,
        "commit_hash": newest["commit_hash"] if newest else "",
        "commit_message": newest["commit_message"] if newest else "",
        "has_requirements": has_requirements,
        "synced": not has_changes and ahead == 0 and behind == 0,
        "ahead": ahead,
        "behind": behind,
        "has_changes": has_changes,
    }


async def _compute_copies() -> list[dict]:
    """Enumerate the copies directory and assemble the listing.

    A copy is any non-hidden directory except `main` (the default scope, not a
    user-managed copy). The copy root is a plain directory — its git state
    lives in the per-BP clones inside it.
    """
    copies_base = _copies_dir()
    if not os.path.isdir(copies_base):
        return []

    result = []
    for entry in sorted(os.listdir(copies_base)):
        if entry.startswith(".") or entry == "main":
            continue
        copy_path = os.path.join(copies_base, entry)
        if not os.path.isdir(copy_path):
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


class SyncCopyResponse(BaseModel):
    status: str  # "success" | "needs_rebase"
    method: str | None = None  # "fast-forward" when synced server-side
    message: str
    # Task id of the dev-stage redeploy spawned after a successful sync, so the
    # deployed dev stage tracks main (matches live-dev). None when nothing was
    # deployed (no change, or no deployable members).
    deploy_task_id: str | None = None
    # Per-BP outcomes (additive; one entry per BP the sync touched):
    # [{bp, status, method, deploy_task_id, message}]
    bp_results: list[dict] = []


class SyncCopyRequest(BaseModel):
    # Email of the user who pressed Sync & Deploy, recorded on the deploy tag.
    deployer: str | None = None
    # When set, sync/rebase ONLY this business process. Each BP is its own
    # repo, so the operation is naturally scoped — other BPs are untouched.
    bp: str | None = None


def _ident_args(deployer: str | None) -> list[str]:
    """`-c user.name/email` so commits are attributed to the deployer, not gitops."""
    who = (deployer or "").strip()
    return ["-c", f"user.name={who}", "-c", f"user.email={who}"] if who else []


async def _wip_commit(
    clone_path: str, deployer: str | None, add_args: list[str], message: str
) -> None:
    """Stage ``add_args`` and commit if anything was staged (no-op otherwise)."""
    await call_git_command("git", "add", *add_args, cwd=clone_path)
    _, _, clean_rc = await call_git_command_with_output(
        "git", "diff", "--cached", "--quiet", cwd=clone_path
    )
    if clean_rc == 0:
        return  # nothing staged
    _, c_err, c_rc = await call_git_command_with_output(
        "git", *_ident_args(deployer), "commit", "-m", message, cwd=clone_path
    )
    if c_rc != 0:
        raise HTTPException(
            status_code=500, detail=f"Failed to commit: {c_err.strip()}"
        )


async def _bp_dev_stage_stale(bp: str, service) -> bool:
    """True when the BP's dev stage needs (re)deploying to match its repo's
    main: never deployed, the recorded commit is unknown (e.g. it predates the
    per-BP-repo migration), or the source differs between the deployed commit
    and main's HEAD. Returns False only when dev already reflects main — so
    "Sync & Deploy" is a genuine no-op only when there's truly nothing to do."""
    dev_commit = service.bp_stage_commit(bp, "dev")
    if not dev_commit:
        return True  # never deployed to dev
    main_dir = os.path.join(_copies_dir(), "main", bp)
    if not os.path.isdir(os.path.join(main_dir, ".git")):
        return True  # no main checkout to compare against → let the deploy run
    head_out, _, hrc = await call_git_command_with_output(
        "git", "rev-parse", "HEAD", cwd=main_dir
    )
    if hrc != 0:
        return True  # can't tell → deploy
    main_head = head_out.strip()
    if dev_commit == main_head:
        return False
    # A commit recorded before the per-BP-repo migration doesn't exist in this
    # repo — treat as stale so the first deploy re-records a real commit.
    _, _, known_rc = await call_git_command_with_output(
        "git", "cat-file", "-e", f"{dev_commit}^{{commit}}", cwd=main_dir
    )
    if known_rc != 0:
        return True
    _, _, drc = await call_git_command_with_output(
        "git", "diff", "--quiet", f"{dev_commit}..{main_head}", cwd=main_dir
    )
    return drc != 0  # non-zero exit = there are differences = stale


async def _spawn_dev_deploy(bp: str, deployer: str | None) -> str | None:
    """(Re)deploy a business process's dev stage from main so the deployed dev
    stage tracks main — i.e. once a copy is "fully synced", the dev stage shows
    the same thing as live-dev. Called on every successful sync AND on a no-op
    sync (nothing to merge), since the dev stage can still be behind main.

    Skips when dev already reflects main for this BP (no spurious redeploy).
    Best-effort and non-blocking: bakes/deploys in a background task (mirrors
    the copy-creation auto-deploy) and returns the deploy task id, or None when
    there's nothing to do. Never raises — a sync must not fail because the
    follow-up deploy couldn't start."""
    try:
        from app.dependencies import get_automation_service

        service = get_automation_service()
        members = service.members_for_bp(bp, copy=None, stage="dev")
        if not members:
            return None
        if not await _bp_dev_stage_stale(bp, service):
            logger.info("Dev stage for '%s' already matches main; no redeploy", bp)
            return None
        res = await spawn_set_deploy(
            label=f"sync-deploy:{bp}",
            members=members,
            stage="dev",
            commit_subject=(f"{deployer} synced {bp}" if deployer else None),
            service=service,
            deployed_by=deployer,
        )
        deploy = res.get("deploy")
        if res.get("error"):
            logger.warning(
                "Auto dev-deploy after sync failed for '%s': %s", bp, res["error"]
            )
        return deploy["task_id"] if deploy else None
    except Exception as e:
        logger.warning("Auto dev-deploy after sync errored for '%s': %s", bp, e)
        return None


async def _tag_deploy(bp: str, deployer: str | None) -> None:
    """Tag the BP repo's new main tip to record a deploy: an annotated tag
    whose subject is "<email> deployed <date> <time> UTC". These tags are what
    the history view shows as deploy markers on main."""
    bare = bp_bare_repo_path(bp)
    # Annotated tags need a tagger identity; set a mechanical one on the bare
    # repo (idempotent). The human + time live in the tag subject.
    await call_git_command_with_output(
        "git", "-C", bare, "config", "user.email", "bailey@bitswan"
    )
    await call_git_command_with_output(
        "git", "-C", bare, "config", "user.name", "Bailey"
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    who = (deployer or "someone").strip() or "someone"
    subject = f"{who} deployed {now.strftime('%Y-%m-%d %H:%M UTC')}"
    tag = f"deploy/{int(now.timestamp())}"
    await call_git_command_with_output(
        "git", "-C", bare, "tag", "-a", "-f", tag, "-m", subject, "refs/heads/main"
    )


async def _sync_one_bp(
    name: str, copy_path: str, bp: str, deployer: str | None
) -> dict:
    """Sync one BP of a copy into that BP repo's main.

    Commits WIP in the clone (only this BP's files — it's this BP's repo),
    then, IF the clone is a pure fast-forward of main, pushes the branch and
    fast-forwards main server-side. When main HAS advanced, nothing is touched
    and the result is ``needs_rebase`` (the coding agent rebases just this BP).
    Returns {bp, status, method, deploy_task_id, message}.
    """
    clone = os.path.join(copy_path, bp)
    if not os.path.isdir(os.path.join(clone, ".git")):
        raise HTTPException(
            status_code=404, detail=f"'{bp}' is not checked out in copy '{name}'"
        )

    await _wip_commit(clone, deployer, ["-A"], f"Sync: commit work in progress ({bp})")
    await fetch_main(clone, bp)

    ahead_out, _, _ = await call_git_command_with_output(
        "git", "rev-list", "--count", "FETCH_HEAD..HEAD", cwd=clone
    )
    if ahead_out.strip() == "0":
        # Nothing to merge — but the deployed dev stage can still be behind
        # main (e.g. synced from another copy). Bring dev up when it's stale.
        task_id = await _spawn_dev_deploy(bp, deployer)
        return {
            "bp": bp,
            "status": "success",
            "method": "noop",
            "deploy_task_id": task_id,
            "message": f"No changes to '{bp}' to sync into main.",
        }

    _, _, ff_rc = await call_git_command_with_output(
        "git", "merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD", cwd=clone
    )
    if ff_rc != 0:
        return {
            "bp": bp,
            "status": "needs_rebase",
            "method": None,
            "deploy_task_id": None,
            "message": (
                f"'{bp}' has advanced on main since this copy branched; a "
                "rebase is required. Hand off to the coding agent."
            ),
        }

    # Push directly to the local bare repo path (not the smart-HTTP `origin`):
    # gitops has no git credentials for its own HTTP server, and a local push
    # still runs the pre-receive hook (this is a copy branch, so a fast-forward
    # is allowed). This transfers the new commit objects; ff_main_to_ref then
    # advances main with a compare-and-swap update-ref.
    p_out, p_err, p_rc = await call_git_command_with_output(
        "git", "push", bp_bare_repo_path(bp), f"HEAD:refs/heads/{name}", cwd=clone
    )
    if p_rc != 0:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to push '{bp}' branch '{name}': "
            f"{(p_err or p_out).strip()}",
        )

    try:
        await ff_main_to_ref(bp, f"refs/heads/{name}")
    except HTTPException as e:
        if e.status_code == 409:
            # main moved between our fetch and the ref update — same handoff
            # as an ordinary divergence: rebase and retry.
            return {
                "bp": bp,
                "status": "needs_rebase",
                "method": None,
                "deploy_task_id": None,
                "message": f"'{bp}': {e.detail}",
            }
        raise

    await _tag_deploy(bp, deployer)
    await refresh_main_bp_checkout(bp)
    task_id = await _spawn_dev_deploy(bp, deployer)
    return {
        "bp": bp,
        "status": "success",
        "method": "fast-forward",
        "deploy_task_id": task_id,
        "message": f"Synced '{bp}' into main (fast-forward).",
    }


@router.post("/{name}/sync")
async def sync_copy(name: str, body: SyncCopyRequest | None = None):
    """Sync a copy into main, per business process.

    Every BP is its own repo, so a sync is a plain push + server-side
    fast-forward of that repo's main — never a cherry-pick, never entangled
    with other BPs' changes. With ``bp`` set, exactly that BP syncs; without,
    every BP checked out in the copy syncs independently and the response
    aggregates the outcomes (any ``needs_rebase`` surfaces as the overall
    status, naming the BPs that need the coding agent).
    """
    _validate_copy_name(name)
    if name == "main":
        raise HTTPException(
            status_code=400, detail="the main copy cannot be synced with itself"
        )
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    deployer = body.deployer if body else None
    bp = body.bp if body else None

    if bp:
        _validate_bp_dir(bp)
        results = [await _sync_one_bp(name, copy_path, bp, deployer)]
    else:
        clones = list_bp_clones(copy_path)
        if not clones:
            return SyncCopyResponse(
                status="success",
                method="noop",
                message="This copy has no business processes to sync.",
            )
        results = [await _sync_one_bp(name, copy_path, b, deployer) for b in clones]

    needs = [r for r in results if r["status"] == "needs_rebase"]
    synced = [r for r in results if r["method"] == "fast-forward"]
    first_task = next(
        (r["deploy_task_id"] for r in results if r["deploy_task_id"]), None
    )

    if needs:
        parts = []
        if synced:
            parts.append(f"synced: {', '.join(r['bp'] for r in synced)}")
        parts.append(f"needs rebase: {', '.join(r['bp'] for r in needs)}")
        return SyncCopyResponse(
            status="needs_rebase",
            message=(
                f"{'; '.join(parts)}. Hand off to the coding agent to rebase "
                "and resolve."
            ),
            deploy_task_id=first_task,
            bp_results=results,
        )
    return SyncCopyResponse(
        status="success",
        method="fast-forward" if synced else "noop",
        message=(
            f"Synced {', '.join(r['bp'] for r in synced)} into main (fast-forward)."
            if synced
            else "Nothing to sync — already up to date with main."
        ),
        deploy_task_id=first_task,
        bp_results=results,
    )


class RebaseCopyResponse(BaseModel):
    status: str  # "success" | "needs_rebase" | "noop"
    message: str
    # BPs whose image dir changed in the pull and were therefore redeployed.
    redeployed_bps: list[str] = []
    # Task ids of the live-dev redeploys spawned for those BPs.
    deploy_task_ids: list[str] = []


async def _spawn_live_dev_deploy(
    members: list[dict], bp: str, copy: str, deployer: str | None
) -> str | None:
    """(Re)deploy the given already-running live-dev members of a BP in a copy
    after a pull changed its image dir. ``members`` is the caller's pre-filtered
    set (only members with an existing live-dev deployment entry). Best-effort,
    non-blocking, never raises — a pull must not fail because the follow-up
    deploy couldn't start."""
    try:
        from app.dependencies import get_automation_service

        service = get_automation_service()
        res = await spawn_set_deploy(
            label=f"pull-redeploy:{copy}:{bp}",
            members=members,
            stage="live-dev",
            commit_subject=(
                f"{deployer} pulled main into {copy}" if deployer else None
            ),
            service=service,
            deployed_by=deployer,
        )
        deploy = res.get("deploy")
        if res.get("error"):
            logger.warning(
                "Live-dev redeploy after pull failed for '%s' in '%s': %s",
                bp,
                copy,
                res["error"],
            )
        return deploy["task_id"] if deploy else None
    except Exception as e:
        logger.warning(
            "Live-dev redeploy after pull errored for '%s' in '%s': %s", bp, copy, e
        )
        return None


def _image_changed_bps(changed_paths: list[str]) -> list[str]:
    """Business processes whose *image dir* changed, from copy-root-relative
    changed paths. An automation's image is built from ``<bp>/<automation>/image/``
    (automation_service checksums exactly that dir), so a pulled change forces a
    rebuild only when it lands inside an ``image/`` directory. Returns the
    top-level BP dirs of such paths. This mirrors the builder's on-disk layout —
    not a guess from names."""
    bps: set[str] = set()
    for p in changed_paths:
        segs = p.split("/")
        # Need <bp>/…/image/<file>: an "image" segment that is neither the first
        # (the BP dir) nor the last (the changed file) component.
        if "image" in segs[1:-1]:
            bps.add(segs[0])
    return sorted(bps)


async def _rebase_one_bp(
    name: str, copy_path: str, bp: str, deployer: str | None
) -> dict:
    """Pull the BP repo's main INTO this copy's clone (rebase the copy branch
    onto main). Clean rebase → the branch is advanced server-side (the rebase
    rewrites history, which the ff-only push hook rejects, so objects travel
    via a temp ref + update-ref). A conflict touches NOTHING and returns
    ``needs_rebase``. Returns {bp, status, pulled, changed_paths} where
    changed_paths are copy-root-relative (``<bp>/…``)."""
    clone = os.path.join(copy_path, bp)
    bare = bp_bare_repo_path(bp)

    await _wip_commit(
        clone,
        deployer,
        ["-A"],
        f"Pull: commit work in progress before rebasing {bp} onto main",
    )
    await fetch_main(clone, bp)

    orig_out, _, _ = await call_git_command_with_output(
        "git", "rev-parse", "HEAD", cwd=clone
    )
    orig_head = orig_out.strip()

    behind_out, _, _ = await call_git_command_with_output(
        "git", "rev-list", "--count", "HEAD..FETCH_HEAD", cwd=clone
    )
    behind = int(behind_out.strip()) if behind_out.strip().isdigit() else 0
    if behind == 0:
        return {"bp": bp, "status": "noop", "pulled": 0, "changed_paths": []}

    _, _rb_err, rb_rc = await call_git_command_with_output(
        "git", *_ident_args(deployer), "rebase", "FETCH_HEAD", cwd=clone
    )
    if rb_rc != 0:
        await call_git_command("git", "rebase", "--abort", cwd=clone)
        await call_git_command_with_output(
            "git", "reset", "--hard", orig_head, cwd=clone
        )
        return {"bp": bp, "status": "needs_rebase", "pulled": 0, "changed_paths": []}

    new_out, _, _ = await call_git_command_with_output(
        "git", "rev-parse", "HEAD", cwd=clone
    )
    new_tip = new_out.strip()

    tmp_ref = f"refs/pull-tmp/{name}"
    _, tp_err, tp_rc = await call_git_command_with_output(
        "git", "push", bare, f"HEAD:{tmp_ref}", cwd=clone
    )
    if tp_rc != 0:
        await call_git_command_with_output(
            "git", "reset", "--hard", orig_head, cwd=clone
        )
        raise HTTPException(
            status_code=500,
            detail=f"Failed to publish rebased '{bp}': {tp_err.strip()}",
        )
    await call_git_command_with_output(
        "git", "-C", bare, "update-ref", f"refs/heads/{name}", new_tip
    )
    await call_git_command_with_output("git", "-C", bare, "update-ref", "-d", tmp_ref)

    diff_out, _, _ = await call_git_command_with_output(
        "git", "diff", "--name-only", f"{orig_head}..{new_tip}", cwd=clone
    )
    changed_paths = [f"{bp}/{p}" for p in diff_out.splitlines() if p.strip()]
    return {
        "bp": bp,
        "status": "success",
        "pulled": behind,
        "changed_paths": changed_paths,
    }


@router.post("/{name}/rebase")
async def rebase_copy(name: str, body: SyncCopyRequest | None = None):
    """Pull main's new commits INTO a copy — per business process. This is the
    opposite direction from ``/sync`` (which publishes the copy's commits TO
    main).

    With ``bp`` set only that BP is pulled; without, every BP is pulled — and
    main-carrying BPs the copy doesn't have yet are materialized as fresh
    clones (that's how a copy gains a BP another copy created). Any business
    process whose *image dir* changed in the pull gets its live-dev stage
    redeployed (a config-only change needs no rebuild). A conflict in a BP
    touches nothing in that BP and reports ``needs_rebase`` so the caller hands
    off to the coding agent."""
    _validate_copy_name(name)
    if name == "main":
        raise HTTPException(
            status_code=400, detail="the main copy has nothing to pull into"
        )
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    deployer = body.deployer if body else None
    only_bp = body.bp if body else None

    if only_bp:
        _validate_bp_dir(only_bp)
        if not os.path.isdir(os.path.join(copy_path, only_bp, ".git")):
            if not await _clone_bp_into_copy(copy_path, name, only_bp):
                raise HTTPException(
                    status_code=404,
                    detail=f"'{only_bp}' has no repo content to pull",
                )
        bps = [only_bp]
    else:
        existing = set(list_bp_clones(copy_path))
        for candidate in list_bp_repos():
            if candidate not in existing and await bp_main_has_content(candidate):
                await _clone_bp_into_copy(copy_path, name, candidate)
        bps = list_bp_clones(copy_path)

    results = [await _rebase_one_bp(name, copy_path, b, deployer) for b in bps]

    conflicts = [r["bp"] for r in results if r["status"] == "needs_rebase"]
    pulled_total = sum(r["pulled"] for r in results)
    changed_paths = [p for r in results for p in r["changed_paths"]]

    # Redeploy live-dev ONLY for BPs whose image dir changed in the pull AND
    # that already run live-dev in THIS copy. We never spin up a new
    # deployment — we only refresh members that already have a live-dev
    # deployment entry (matched by deployment_id against bitswan.yaml).
    changed_bps = _image_changed_bps(changed_paths)
    from app.dependencies import get_automation_service

    service = get_automation_service()
    bs = read_bitswan_yaml(service.gitops_dir) or {}
    deployed_ids = set((bs.get("deployments") or {}).keys())
    redeployed: list[str] = []
    task_ids: list[str] = []
    for bp in changed_bps:
        members = [
            m
            for m in service.members_for_bp(bp, copy=name, stage="live-dev")
            if m.get("deployment_id") in deployed_ids
        ]
        if not members:
            continue  # this BP isn't running live-dev in the copy — nothing to do
        tid = await _spawn_live_dev_deploy(members, bp, name, deployer)
        redeployed.append(bp)
        if tid:
            task_ids.append(tid)

    if conflicts:
        return RebaseCopyResponse(
            status="needs_rebase",
            message=(
                f"Main couldn't be pulled in automatically for: "
                f"{', '.join(conflicts)} (conflict) — hand off to the coding "
                "agent to rebase and resolve."
            ),
            redeployed_bps=redeployed,
            deploy_task_ids=task_ids,
        )
    if pulled_total == 0:
        return RebaseCopyResponse(
            status="noop", message="Already up to date with main."
        )
    msg = f"Pulled {pulled_total} change(s) from main into '{name}'."
    if redeployed:
        msg += f" Redeploying live-dev for: {', '.join(redeployed)}."
    return RebaseCopyResponse(
        status="success",
        message=msg,
        redeployed_bps=redeployed,
        deploy_task_ids=task_ids,
    )


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


async def _own_container_id() -> str | None:
    # /proc-based id works without Docker (reads our own cgroup) — gitops has no
    # docker.sock after the cut-over, so there is no API fallback.
    return _own_container_id_from_proc()


async def _rm_rf_as_root_in_container(path: str) -> bool:
    """Wipe `path` as root by re-entering our own container via the driver's
    exec (--user 0). A copy's working tree contains files created by other
    containers (live-dev automations, build outputs) that uid 1000 often can't
    unlink. The driver holds docker.sock and permits this because the gitops
    container is labelled with this workspace.
    """
    container_id = await _own_container_id()
    if not container_id:
        logger.warning(
            "rm -rf %s: could not determine own container ID; cannot exec as root",
            path,
        )
        return False
    from app.services.infra_driver_client import (
        ExecSpec,
        InfraDriverClient,
        InfraDriverError,
        WorkspaceContext,
    )

    gitops_root = os.environ.get("BITSWAN_GITOPS_DIR", "/gitops")
    client = InfraDriverClient()
    ctx = WorkspaceContext(
        workspace_name=os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace-local"),
        domain=os.environ.get("BITSWAN_GITOPS_DOMAIN", ""),
        gitops_dir=os.path.join(gitops_root, "gitops"),
        secrets_dir=os.path.join(gitops_root, "secrets"),
    )
    err: list[bytes] = []

    async def on_stderr(d: bytes):
        err.append(d)

    try:
        rc = await client.exec(
            ctx,
            ExecSpec(container=container_id, cmd=["rm", "-rf", path], user="0"),
            on_stderr=on_stderr,
        )
    except InfraDriverError as e:
        logger.warning("rm -rf %s via driver exec raised: %s", path, e)
        return False
    if rc != 0:
        logger.warning(
            "rm -rf %s via driver exec failed (%s): %s",
            path,
            rc,
            b"".join(err).decode(errors="replace").strip(),
        )
        return False
    return True


def _is_safe_relative_path(p: str) -> bool:
    if not p:
        return False
    if p.startswith("/") or p.startswith("\\"):
        return False
    parts = re.split(r"[\\/]", p)
    return not any(seg in ("", "..") for seg in parts)


_NAME_STATUS_KIND = {
    "A": "added",
    "M": "modified",
    "D": "deleted",
    "R": "renamed",
    "C": "copied",
    "T": "modified",
}


async def _clone_status(clone_path: str, bp: str, by_path: dict) -> None:
    """Collect one BP clone's change list into `by_path`, with paths prefixed
    ``<bp>/…`` so they stay copy-root-relative (the wire shape of the
    single-repo era)."""
    await fetch_main(clone_path, bp)

    # Tracked delta vs main (commits ahead of main + staged/unstaged edits).
    # --no-renames so paths stay real (a rename becomes delete + add) — the UI
    # uses each path to fetch its per-file diff.
    num_out, _, _ = await call_git_command_with_output(
        "git", "diff", "--no-renames", "--numstat", "FETCH_HEAD", cwd=clone_path
    )
    for line in num_out.splitlines():
        parts = line.split("\t", 2)
        if len(parts) != 3:
            continue
        adds_str, dels_str, p = parts
        full = f"{bp}/{p}"
        by_path[full] = {
            "path": full,
            "kind": "modified",
            "adds": int(adds_str) if adds_str.isdigit() else 0,
            "dels": int(dels_str) if dels_str.isdigit() else 0,
        }
    ns_out, _, _ = await call_git_command_with_output(
        "git", "diff", "--no-renames", "--name-status", "FETCH_HEAD", cwd=clone_path
    )
    for line in ns_out.splitlines():
        cols = line.split("\t")
        if len(cols) < 2:
            continue
        kind = _NAME_STATUS_KIND.get(cols[0][:1], "modified")
        full = f"{bp}/{cols[-1]}"  # for renames, the new path
        if full in by_path:
            by_path[full]["kind"] = kind
        else:
            by_path[full] = {"path": full, "kind": kind, "adds": 0, "dels": 0}

    # New untracked files (not in main and not yet committed) — the whole file
    # becomes main, so surface it as added.
    others_out, _, _ = await call_git_command_with_output(
        "git", "ls-files", "--others", "--exclude-standard", cwd=clone_path
    )
    for p in others_out.splitlines():
        p = p.strip()
        if not p:
            continue
        full = f"{bp}/{p}"
        if full not in by_path:
            by_path[full] = {"path": full, "kind": "added", "adds": 0, "dels": 0}


@router.get("/{name}/status")
async def get_copy_status(name: str, bp: str | None = None):
    """Per-file change list for a copy: everything that pressing Sync & Deploy
    will make the new main — commits ahead of main, plus uncommitted edits,
    plus new untracked files. Paths are copy-root-relative (``<bp>/…``).
    Optional ``?bp=`` scopes the list to one business process."""
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    if bp:
        _validate_bp_dir(bp)
        if not os.path.isdir(os.path.join(copy_path, bp, ".git")):
            return {"changed": []}
        bps = [bp]
    else:
        bps = list_bp_clones(copy_path)

    by_path: dict[str, dict] = {}
    for b in bps:
        await _clone_status(os.path.join(copy_path, b), b, by_path)
    return {"changed": list(by_path.values())}


async def _clone_divergence(clone_path: str, bp: str) -> tuple[int, int]:
    """(ahead, behind) of one BP clone vs its repo's main."""
    await fetch_main(clone_path, bp)

    async def _count(rng: str) -> int:
        out, _, rc = await call_git_command_with_output(
            "git", "rev-list", "--count", rng, cwd=clone_path
        )
        return int(out.strip()) if rc == 0 and out.strip().isdigit() else 0

    return await _count("FETCH_HEAD..HEAD"), await _count("HEAD..FETCH_HEAD")


async def _missing_clone_behind(bp: str) -> int:
    """How far behind a copy is on a BP it hasn't checked out at all: every
    commit on that repo's main (including the seed) — a nonzero signal that a
    pull will materialize the BP."""
    out, _, rc = await call_git_command_with_output(
        "git", "-C", bp_bare_repo_path(bp), "rev-list", "--count", "main"
    )
    return int(out.strip()) if rc == 0 and out.strip().isdigit() else 0


@router.get("/{name}/divergence")
async def get_bp_divergence(name: str, bp: str = Query(...)):
    """Divergence from main for THIS business process vs every OTHER business
    process in the copy.

    Each BP is its own repo, so "this BP" is simply its clone's ahead/behind;
    the ``_other`` fields sum the remaining clones so the Sync & Deploy screen
    can say "other business processes have unsynced work" without mixing it
    into this BP's counts."""
    _validate_bp_dir(bp)
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    clones = list_bp_clones(copy_path)

    if bp in clones:
        ahead_bp, behind_bp = await _clone_divergence(os.path.join(copy_path, bp), bp)
    elif await bp_main_has_content(bp):
        ahead_bp, behind_bp = 0, await _missing_clone_behind(bp)
    else:
        ahead_bp = behind_bp = 0

    ahead_other = behind_other = 0
    for other in clones:
        if other == bp:
            continue
        a, b = await _clone_divergence(os.path.join(copy_path, other), other)
        ahead_other += a
        behind_other += b

    return {
        "bp": bp,
        "ahead_bp": ahead_bp,
        "ahead_other": ahead_other,
        "behind_bp": behind_bp,
        "behind_other": behind_other,
    }


@router.get("/{name}/divergence-all")
async def get_all_bp_divergence(name: str):
    """Per-business-process ahead/behind counts vs main for a WHOLE copy — so
    the switcher can show ↑/↓ on each BP at a glance.

    Each BP clone is compared against its own repo's main; a main-carrying BP
    the copy hasn't checked out reports behind-only (a pull materializes it).
    Only BPs that actually diverge appear in the result; the caller treats a
    missing BP as "in step with main"."""
    _validate_copy_name(name)
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    result: dict[str, dict] = {}
    clones = list_bp_clones(copy_path)
    for bp in clones:
        ahead, behind = await _clone_divergence(os.path.join(copy_path, bp), bp)
        if ahead or behind:
            result[bp] = {"ahead": ahead, "behind": behind}
    for bp in list_bp_repos():
        if bp in clones:
            continue
        if await bp_main_has_content(bp):
            behind = await _missing_clone_behind(bp)
            if behind:
                result[bp] = {"ahead": 0, "behind": behind}
    return result


async def _git_log(ref: str, cwd: str, limit: int = 50) -> list[dict]:
    """Recent commits on `ref` as structured rows. Fields are unit-separated so
    subjects with tabs/spaces survive intact."""
    out, _, rc = await call_git_command_with_output(
        "git",
        "log",
        f"-{limit}",
        "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s",
        ref,
        cwd=cwd,
    )
    commits: list[dict] = []
    if rc == 0:
        for line in out.splitlines():
            f = line.split("\x1f")
            if len(f) == 6:
                commits.append(
                    {
                        "sha": f[0],
                        "short": f[1],
                        "author_name": f[2],
                        "author_email": f[3],
                        "date": f[4],
                        "subject": f[5],
                    }
                )
    return commits


async def _deploy_tags(bp: str) -> dict[str, list[str]]:
    """Map main-commit sha → deploy-tag subjects for one BP repo. Annotated
    tags expose the tagged commit via %(*objectname); fall back to
    %(objectname) just in case. NB: for-each-ref does NOT interpret git-log's
    %x1f escape, so use a plain separator; the two object ids are hex (no "|")
    and the subject is last, so maxsplit=2 keeps a subject containing "|"
    intact."""
    deploys: dict[str, list[str]] = {}
    tags_out, _, _ = await call_git_command_with_output(
        "git",
        "-C",
        bp_bare_repo_path(bp),
        "for-each-ref",
        "refs/tags/deploy",
        "--format=%(*objectname)|%(objectname)|%(contents:subject)",
    )
    for line in tags_out.splitlines():
        f = line.split("|", 2)
        if len(f) == 3:
            commit_sha = f[0] or f[1]
            deploys.setdefault(commit_sha, []).append(f[2])
    return deploys


@router.get("/{name}/history")
async def get_copy_history(name: str, bp: str | None = None):
    """Commit history for the Sync & Deploy history view: the copy's commits
    and main's commits, with deploy markers (`<email> deployed <date>`)
    attached to the main commits each Sync & Deploy tagged.

    With ``?bp=`` (the normal, BP-scoped view) the logs come from that BP's
    repo alone. Without it, logs are merged across every BP clone (newest
    first) — an aggregate view kept for API compatibility."""
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    if bp:
        _validate_bp_dir(bp)
        if not os.path.isdir(os.path.join(copy_path, bp, ".git")):
            raise HTTPException(
                status_code=404, detail=f"'{bp}' is not checked out in '{name}'"
            )
        bps = [bp]
    else:
        bps = list_bp_clones(copy_path)

    copy_commits: list[dict] = []
    main_commits: list[dict] = []
    deploys: dict[str, list[str]] = {}
    for b in bps:
        clone = os.path.join(copy_path, b)
        await fetch_main(clone, b)
        copy_commits.extend(await _git_log("HEAD", clone))
        main_commits.extend(await _git_log("FETCH_HEAD", clone))
        deploys.update(await _deploy_tags(b))

    if len(bps) > 1:
        copy_commits.sort(key=lambda c: c["date"], reverse=True)
        main_commits.sort(key=lambda c: c["date"], reverse=True)
        copy_commits = copy_commits[:50]
        main_commits = main_commits[:50]

    for c in main_commits:
        c["deploys"] = deploys.get(c["sha"], [])

    return {"copy": copy_commits, "main": main_commits}


async def _clone_diff(clone_path: str, bp: str, rel_path: str | None) -> str:
    """Unified diff of one BP clone vs its main, with `a/<bp>/…` patch headers
    so paths stay copy-root-relative."""
    prefix_args = [f"--src-prefix=a/{bp}/", f"--dst-prefix=b/{bp}/"]
    git_args = ["git", "diff", *prefix_args, "FETCH_HEAD", "--"]
    git_args.append(rel_path if rel_path else ".")

    stdout, stderr, rc = await call_git_command_with_output(*git_args, cwd=clone_path)
    if rc != 0:
        raise HTTPException(
            status_code=500, detail=f"Failed to get diff: {stderr.strip()}"
        )

    # Untracked new files don't appear in `git diff` against a ref — show the
    # whole file as added (`--no-index` exits 1 when it finds a diff; that's
    # expected, not an error, so we ignore the return code and use the output).
    if rel_path is not None and not stdout.strip():
        no_index_out, _, _ = await call_git_command_with_output(
            "git",
            "diff",
            "--no-index",
            *prefix_args,
            "--",
            "/dev/null",
            rel_path,
            cwd=clone_path,
        )
        if no_index_out.strip():
            stdout = no_index_out
    return stdout


@router.get("/{name}/diff")
async def get_copy_diff(name: str, path: str | None = None):
    """Unified diff of the copy against main — what will become the new main on
    Sync & Deploy, committed or not. Optional `?path=<bp>/rest` filter routes
    to that BP's clone; without a path, per-BP diffs are concatenated. Patch
    headers stay copy-root-relative (`a/<bp>/…`)."""
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")
    if path is not None and not _is_safe_relative_path(path):
        raise HTTPException(status_code=400, detail="invalid path")

    if path is not None:
        bp, _, rest = path.partition("/")
        _validate_bp_dir(bp)
        clone = os.path.join(copy_path, bp)
        if not os.path.isdir(os.path.join(clone, ".git")):
            raise HTTPException(
                status_code=404, detail=f"'{bp}' is not checked out in '{name}'"
            )
        await fetch_main(clone, bp)
        return {"diff": await _clone_diff(clone, bp, rest or None)}

    parts: list[str] = []
    for bp in list_bp_clones(copy_path):
        clone = os.path.join(copy_path, bp)
        await fetch_main(clone, bp)
        d = await _clone_diff(clone, bp, None)
        if d.strip():
            parts.append(d)
    return {"diff": "".join(parts)}


@router.get("/{name}/commit/{sha}/diff")
async def get_commit_diff(name: str, sha: str, bp: str | None = None):
    """Unified diff introduced by a single commit (`git show`), for the history
    view's clickable rows. Each BP has its own repo, so the commit is looked up
    in the named BP's clone — or, without ``?bp=``, in whichever clone knows
    the sha (shas are unique across repos in practice)."""
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")
    if not re.fullmatch(r"[0-9a-fA-F]{4,64}", sha or ""):
        raise HTTPException(status_code=400, detail="invalid commit")

    if bp:
        _validate_bp_dir(bp)
        bps = [bp]
    else:
        bps = list_bp_clones(copy_path)

    for b in bps:
        clone = os.path.join(copy_path, b)
        if not os.path.isdir(os.path.join(clone, ".git")):
            continue
        # main commits are reachable only via FETCH_HEAD's objects — fetch first.
        await fetch_main(clone, b)
        _, _, known_rc = await call_git_command_with_output(
            "git", "cat-file", "-e", f"{sha}^{{commit}}", cwd=clone
        )
        if known_rc != 0:
            continue
        stdout, stderr, rc = await call_git_command_with_output(
            "git", "show", "--no-color", "--format=medium", sha, cwd=clone
        )
        if rc == 0:
            return {"diff": stdout}
    raise HTTPException(status_code=404, detail="commit not found")
