"""Copy management.

A "copy" is an independent ``git clone`` of the workspace's canonical bare repo
(``repo.git``), checked out on its own branch, living at
``${BITSWAN_COPIES_DIR}/<name>``. The ``main`` copy is the default-branch
scope; other copies are per-agent / per-task checkouts.
Each copy's ``origin`` points at the embedded smart-HTTP git server so agents
push/pull with normal git (fast-forward only).

This replaces the old shared-``.git`` worktree model. The router is served under
``/copies``.
"""

import datetime
import logging
import os
import re
import shutil
import tempfile

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

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
    """The smart-HTTP URL agents use as ``origin`` for a copy."""
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
    # new branches), then repoint origin at the smart-HTTP URL that the agent
    # containers use at runtime.
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

    # No per-copy database at copy-create. Each BP's live-dev backend in this
    # copy gets its OWN per-(copy, BP) database (copy_<copy>_bp_<slug>), created
    # at deploy by the driver's ensure guard and seeded from that BP's dev DB —
    # so there is nothing to clone here.
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

    status_out, _, _ = await call_git_command_with_output(
        "git", "status", "--porcelain", cwd=copy_path
    )
    has_changes = bool(status_out and status_out.strip())

    # Ahead/behind vs the canonical main. Refresh our view of main from the
    # LOCAL bare repo (filesystem, no network, no credentials — gitops can't
    # authenticate to its own smart-HTTP `origin`); FETCH_HEAD then points at
    # the current main. "ahead" = commits on the copy not yet on main;
    # "behind" = commits on main the copy hasn't picked up. behind == 0 means a
    # fast-forward of main to this copy needs no rebase.
    ahead = behind = 0
    await call_git_command("git", "fetch", bare_repo_path(), "main", cwd=copy_path)
    ahead_out, _, ahead_cnt_rc = await call_git_command_with_output(
        "git", "rev-list", "--count", "FETCH_HEAD..HEAD", cwd=copy_path
    )
    if ahead_cnt_rc == 0 and ahead_out.strip().isdigit():
        ahead = int(ahead_out.strip())
    behind_out, _, behind_cnt_rc = await call_git_command_with_output(
        "git", "rev-list", "--count", "HEAD..FETCH_HEAD", cwd=copy_path
    )
    if behind_cnt_rc == 0 and behind_out.strip().isdigit():
        behind = int(behind_out.strip())

    synced = not has_changes and ahead == 0 and behind == 0

    return {
        "name": name,
        "branch": branch,
        "commit_hash": commit_hash,
        "commit_message": commit_message,
        "has_requirements": has_requirements,
        "synced": synced,
        "ahead": ahead,
        "behind": behind,
        "has_changes": has_changes,
    }


async def _compute_copies() -> list[dict]:
    """Enumerate the copies directory and assemble the listing.

    Each copy is an independent clone with its own .git, so state is read
    per-copy. The `main` copy is excluded from the list (it's the
    default scope, not a user-managed copy).
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


async def _fast_forward_main_to_branch(name: str) -> dict:
    """Fast-forward `main` to the copy's branch tip in the canonical (bare)
    repo. Append-only: succeeds only when `main` is an ancestor of the branch
    (a true fast-forward); raises 409 otherwise. The branch must already be
    pushed to the bare repo."""
    bare = bare_repo_path()

    _, _, exists_rc = await call_git_command_with_output(
        "git", "-C", bare, "rev-parse", "--verify", f"refs/heads/{name}"
    )
    if exists_rc != 0:
        raise HTTPException(status_code=404, detail=f"Copy branch '{name}' not found")

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
    # The bare repo's `main` ref now points at the new tip, but the scanners
    # (in_main, main-branch live-dev) read the `copies/main` WORKING TREE — so
    # advance that checkout too, or the synced BP never shows up in main.
    await _refresh_main_copy_checkout()
    return {"status": "success", "message": f"main fast-forwarded to '{name}'"}


async def _refresh_main_copy_checkout() -> None:
    """Fast-forward the gitops-maintained `copies/main` working tree to the
    canonical repo's `main` tip.

    `main` is deploy-only: it advances solely through this code path, never a
    human edit, so the checkout is always a clean fast-forward of the bare ref.
    This is the checkout the process/automation scanners walk for the main
    scope, so without this step a synced BP advances `refs/heads/main` but
    stays invisible in main (`in_main` false, no main-branch live-dev)."""
    main_copy = os.path.join(_copies_dir(), "main")
    if not os.path.isdir(os.path.join(main_copy, ".git")):
        # The main copy is provisioned at workspace init; if it isn't here yet
        # there is nothing to advance (and the bare ref is already current).
        return
    bare = bare_repo_path()
    # Fetch from the local bare path (gitops can't authenticate to its own
    # smart-HTTP `origin`); FETCH_HEAD then points at the new main tip.
    await call_git_command("git", "fetch", bare, "main", cwd=main_copy)
    # `main` is deploy-only and the bare ref is authoritative, so force the
    # checkout to match it exactly (`reset --hard`) rather than `merge --ff-only`.
    # ff-only is fragile: if the checkout ever diverges (a stray commit, an
    # interrupted sync), every subsequent sync would 500 forever. reset --hard
    # leaves untracked/ignored build artifacts in place and just realigns the
    # tracked tree with the canonical main.
    out, err, rc = await call_git_command_with_output(
        "git", "reset", "--hard", "FETCH_HEAD", cwd=main_copy
    )
    if rc != 0:
        raise HTTPException(
            status_code=500,
            detail=(
                "main advanced in the canonical repo, but the main checkout "
                f"could not be realigned: {(err or out).strip()}"
            ),
        )


class SyncCopyResponse(BaseModel):
    status: str  # "success" | "needs_rebase"
    method: str | None = None  # "fast-forward" when synced server-side
    message: str
    # Task id of the dev-stage redeploy spawned after a successful sync, so the
    # deployed dev stage tracks main (matches live-dev). None when nothing was
    # deployed (no change, or no deployable members).
    deploy_task_id: str | None = None


class SyncCopyRequest(BaseModel):
    # Email of the user who pressed Sync & Deploy, recorded on the deploy tag.
    deployer: str | None = None
    # When set, sync ONLY the commits that touched this business process's
    # directory into main (auto-rebasing the copy's other commits), so an
    # unrelated BP's work-in-progress isn't dragged into the deploy.
    bp: str | None = None


def _validate_bp_dir(bp: str) -> None:
    if bp in (".", "..") or not re.fullmatch(r"[A-Za-z0-9._-]+", bp or ""):
        raise HTTPException(status_code=400, detail="invalid business process name")


def _ident_args(deployer: str | None) -> list[str]:
    """`-c user.name/email` so commits are attributed to the deployer, not gitops."""
    who = (deployer or "").strip()
    return ["-c", f"user.name={who}", "-c", f"user.email={who}"] if who else []


async def _wip_commit(
    copy_path: str, deployer: str | None, add_args: list[str], message: str
) -> None:
    """Stage ``add_args`` and commit if anything was staged (no-op otherwise)."""
    await call_git_command("git", "add", *add_args, cwd=copy_path)
    _, _, clean_rc = await call_git_command_with_output(
        "git", "diff", "--cached", "--quiet", cwd=copy_path
    )
    if clean_rc == 0:
        return  # nothing staged
    _, c_err, c_rc = await call_git_command_with_output(
        "git", *_ident_args(deployer), "commit", "-m", message, cwd=copy_path
    )
    if c_rc != 0:
        raise HTTPException(
            status_code=500, detail=f"Failed to commit: {c_err.strip()}"
        )


async def _sync_copy_per_bp(
    name: str, copy_path: str, bp: str, deployer: str | None
) -> "SyncCopyResponse":
    """Sync ONLY the commits that touched business process ``bp`` into main, then
    rebase the copy onto the new main (dropping the now-merged commits).

    Cherry-picks the BP's commits onto a temp branch off main; if that or the
    follow-up copy rebase hits a conflict, NOTHING is touched and we return
    ``needs_rebase`` so the coding agent resolves it. main and the copy's branch
    ref are advanced server-side with ``update-ref`` — the copy rebase rewrites
    history, which the ff-only pre-receive hook would otherwise reject.

    Assumes the caller already committed WIP and fetched main (FETCH_HEAD)."""
    _validate_bp_dir(bp)
    bare = bare_repo_path()
    ident = _ident_args(deployer)

    # Copy HEAD before we touch anything, so a mid-rebuild conflict can restore
    # the copy exactly as it was (then hand off to the agent).
    oh_out, _, _ = await call_git_command_with_output(
        "git", "rev-parse", "HEAD", cwd=copy_path
    )
    orig_head = oh_out.strip()

    # Commits on the copy not yet in main (oldest-first), and the subset that
    # touched this BP's directory.
    all_out, _, _ = await call_git_command_with_output(
        "git", "rev-list", "--reverse", "FETCH_HEAD..HEAD", cwd=copy_path
    )
    bp_out, _, _ = await call_git_command_with_output(
        "git",
        "rev-list",
        "--reverse",
        "FETCH_HEAD..HEAD",
        "--",
        f"{bp}/",
        cwd=copy_path,
    )
    all_commits = all_out.split()
    bp_commits = bp_out.split()

    if not bp_commits:
        # Nothing to merge — but the deployed dev stage can still be behind main
        # (e.g. it was synced before the auto-deploy existed). "Sync & Deploy"
        # should still bring dev up to main, so deploy when it's stale.
        task_id = await _spawn_dev_deploy(bp, deployer)
        return SyncCopyResponse(
            status="success",
            method="noop",
            message=f"No changes to '{bp}' to sync into main.",
            deploy_task_id=task_id,
        )

    # Fast path: the copy's only un-merged commits are this BP's and they sit
    # directly on main — a plain fast-forward, no history rewrite needed.
    _, _, ff_rc = await call_git_command_with_output(
        "git", "merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD", cwd=copy_path
    )
    if ff_rc == 0 and set(all_commits) == set(bp_commits):
        p_out, p_err, p_rc = await call_git_command_with_output(
            "git", "push", bare, f"HEAD:refs/heads/{name}", cwd=copy_path
        )
        if p_rc != 0:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to push copy '{name}': {(p_err or p_out).strip()}",
            )
        await _fast_forward_main_to_branch(name)
        await _tag_deploy(name, deployer)
        task_id = await _spawn_dev_deploy(bp, deployer)
        return SyncCopyResponse(
            status="success",
            method="fast-forward",
            message=f"Synced '{bp}' into main (fast-forward).",
            deploy_task_id=task_id,
        )

    # General path: cherry-pick only the BP commits onto a temp branch off main.
    # The temp dir is "."-prefixed so the copy watchers ignore it.
    tmpdir = tempfile.mkdtemp(prefix=f".syncbp-{name}-", dir=_copies_dir())
    os.rmdir(tmpdir)  # git worktree add needs to create the dir itself
    try:
        _, w_err, w_rc = await call_git_command_with_output(
            "git",
            "worktree",
            "add",
            "--detach",
            tmpdir,
            "FETCH_HEAD",
            cwd=copy_path,
        )
        if w_rc != 0:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to set up temp worktree: {w_err.strip()}",
            )
        try:
            for c in bp_commits:
                _, cp_err, cp_rc = await call_git_command_with_output(
                    "git", *ident, "cherry-pick", "--allow-empty", c, cwd=tmpdir
                )
                if cp_rc != 0:
                    await call_git_command("git", "cherry-pick", "--abort", cwd=tmpdir)
                    return SyncCopyResponse(
                        status="needs_rebase",
                        message=(
                            f"Applying '{bp}' commits onto main hit a conflict — "
                            "hand off to the coding agent to rebase and resolve."
                        ),
                    )
            tip_out, _, _ = await call_git_command_with_output(
                "git", "rev-parse", "HEAD", cwd=tmpdir
            )
            temp_tip = tip_out.strip()
        finally:
            await call_git_command(
                "git", "worktree", "remove", "--force", tmpdir, cwd=copy_path
            )

        # Rebuild the copy as: new main (temp_tip) + its NON-BP commits replayed
        # in order. Explicit (reset + cherry-pick the non-BP commits) rather than
        # `git rebase`, whose already-applied detection is version-dependent —
        # the BP commits are simply not replayed since they're already in main.
        bp_set = set(bp_commits)
        non_bp = [c for c in all_commits if c not in bp_set]
        await call_git_command_with_output(
            "git", "reset", "--hard", temp_tip, cwd=copy_path
        )
        for c in non_bp:
            _, rc_err, rc_rc = await call_git_command_with_output(
                "git", *ident, "cherry-pick", "--allow-empty", c, cwd=copy_path
            )
            if rc_rc != 0:
                await call_git_command("git", "cherry-pick", "--abort", cwd=copy_path)
                # Restore the copy exactly as it was; main is still untouched.
                await call_git_command_with_output(
                    "git", "reset", "--hard", orig_head, cwd=copy_path
                )
                return SyncCopyResponse(
                    status="needs_rebase",
                    message=(
                        "Replaying the copy's other commits onto the new main hit "
                        "a conflict — hand off to the coding agent to rebase."
                    ),
                )
        new_tip_out, _, _ = await call_git_command_with_output(
            "git", "rev-parse", "HEAD", cwd=copy_path
        )
        new_copy_tip = new_tip_out.strip()

        # Transfer the new objects to the bare via a NEW temp ref (allowed by the
        # ff-only hook), then advance main + the copy branch with server-side
        # update-ref (bypasses the hook for the rebased copy history).
        tmp_ref = f"refs/sync-tmp/{name}"
        _, tp_err, tp_rc = await call_git_command_with_output(
            "git", "push", bare, f"HEAD:{tmp_ref}", cwd=copy_path
        )
        if tp_rc != 0:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to publish synced objects: {tp_err.strip()}",
            )
        # Only advance main if temp_tip is a true fast-forward of it.
        _, _, anc_rc = await call_git_command_with_output(
            "git",
            "-C",
            bare,
            "merge-base",
            "--is-ancestor",
            "refs/heads/main",
            temp_tip,
        )
        if anc_rc != 0:
            await call_git_command_with_output(
                "git", "-C", bare, "update-ref", "-d", tmp_ref
            )
            return SyncCopyResponse(
                status="needs_rebase",
                message="main moved during sync — retry, or let the agent rebase.",
            )
        await call_git_command_with_output(
            "git", "-C", bare, "update-ref", "refs/heads/main", temp_tip
        )
        await call_git_command_with_output(
            "git", "-C", bare, "update-ref", f"refs/heads/{name}", new_copy_tip
        )
        await call_git_command_with_output(
            "git", "-C", bare, "update-ref", "-d", tmp_ref
        )

        await _refresh_main_copy_checkout()
        await _tag_deploy(name, deployer)
        task_id = await _spawn_dev_deploy(bp, deployer)
        return SyncCopyResponse(
            status="success",
            method="cherry-pick",
            message=f"Synced '{bp}' into main; rebased the copy onto the new main.",
            deploy_task_id=task_id,
        )
    finally:
        if os.path.isdir(tmpdir):
            shutil.rmtree(tmpdir, ignore_errors=True)


async def _bp_dev_stage_stale(bp: str, service) -> bool:
    """True when the BP's dev stage needs (re)deploying to match main: never
    deployed, or this BP's source differs between the commit dev is deployed at
    and main's HEAD. Returns False only when dev already reflects main for this
    BP — so "Sync & Deploy" is a genuine no-op only when there's truly nothing
    to do (and doesn't spam the deploy history with identical redeploys)."""
    dev_commit = service.bp_stage_commit(bp, "dev")
    if not dev_commit:
        return True  # never deployed to dev
    main_dir = os.path.join(_copies_dir(), "main")
    head_out, _, hrc = await call_git_command_with_output(
        "git", "rev-parse", "HEAD", cwd=main_dir
    )
    if hrc != 0:
        return True  # can't tell → deploy
    main_head = head_out.strip()
    if dev_commit == main_head:
        return False
    # Compare only THIS BP's tree between the deployed commit and main, so an
    # unrelated BP advancing main doesn't trigger a needless redeploy here.
    _, _, drc = await call_git_command_with_output(
        "git",
        "diff",
        "--quiet",
        f"{dev_commit}..{main_head}",
        "--",
        f"{bp}/",
        cwd=main_dir,
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


async def _tag_deploy(name: str, deployer: str | None) -> None:
    """Tag the new main tip to record a deploy: an annotated tag whose subject
    is "<email> deployed <date> <time> UTC". These tags are what the history
    view shows as deploy markers on main."""
    bare = bare_repo_path()
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


@router.post("/{name}/sync")
async def sync_copy(name: str, body: SyncCopyRequest | None = None):
    """Sync a copy into main the cheap way when possible.

    Commits any work in progress, then — IF the copy is a pure fast-forward of
    main (main hasn't advanced since the copy branched, so no rebase is needed)
    — pushes the branch and fast-forwards `main` to it, entirely server-side
    with plain git. No coding agent involved.

    When main HAS advanced (a rebase would be required to resolve the
    divergence), we do NOT touch anything and return ``needs_rebase`` so the
    caller can hand off to the coding agent, which rebases + resolves conflicts.
    """
    _validate_copy_name(name)
    if name == "main":
        raise HTTPException(
            status_code=400, detail="the main copy cannot be synced with itself"
        )
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    # 1) Commit work in progress so it's part of what we sync. For a per-BP
    #    sync, stage ONLY that BP's changes as the syncable commit, then commit
    #    any remaining (other-BP) changes separately so they ride on the copy
    #    but never reach main. For a whole-copy sync, stage everything.
    deployer = body.deployer if body else None
    bp = body.bp if body else None
    if bp:
        _validate_bp_dir(bp)
        await _wip_commit(
            copy_path,
            deployer,
            ["--", f"{bp}/"],
            f"Sync: commit work in progress ({bp})",
        )
        await _wip_commit(
            copy_path,
            deployer,
            ["-A"],
            "wip: changes outside the synced business process",
        )
    else:
        await _wip_commit(copy_path, deployer, ["-A"], "Sync: commit work in progress")

    # 2) Refresh our view of main from the LOCAL bare repo (filesystem — gitops
    #    can't authenticate to its own smart-HTTP `origin`). FETCH_HEAD now
    #    points at the current main and its objects are in the copy.
    bare = bare_repo_path()
    await call_git_command("git", "fetch", bare, "main", cwd=copy_path)

    # 2b) Per-BP sync: when a business process is named, only its commits go to
    #     main and the copy is auto-rebased — keeps unrelated BPs out of the
    #     deploy. Falls through to the whole-copy fast-forward below when no BP.
    if bp:
        return await _sync_copy_per_bp(name, copy_path, bp, deployer)

    # 3) Fast-forward only when main (FETCH_HEAD) is an ancestor of the copy's
    #    HEAD — i.e. the copy is purely ahead and no rebase is required.
    _, _, ff_possible_rc = await call_git_command_with_output(
        "git", "merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD", cwd=copy_path
    )
    if ff_possible_rc != 0:
        return SyncCopyResponse(
            status="needs_rebase",
            message=(
                "main has advanced since this copy branched; a rebase is "
                "required. Hand off to the coding agent to rebase and resolve."
            ),
        )

    # 4) Publish the branch to the canonical repo and fast-forward main.
    # Push directly to the local bare repo path (not the smart-HTTP `origin`):
    # gitops has no git credentials for its own HTTP server, and a local push
    # still runs the pre-receive hook (this is a copy branch, so a fast-forward
    # is allowed). This transfers the new commit objects; the update-ref below
    # then advances main.
    p_out, p_err, p_rc = await call_git_command_with_output(
        "git", "push", bare, f"HEAD:refs/heads/{name}", cwd=copy_path
    )
    if p_rc != 0:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to push copy '{name}': {(p_err or p_out).strip()}",
        )

    await _fast_forward_main_to_branch(name)
    await _tag_deploy(name, body.deployer if body else None)
    # Redeploy the dev stage of every BP whose source changed in this sync, so
    # the deployed dev stage tracks main (FETCH_HEAD is the pre-sync main).
    diff_out, _, _ = await call_git_command_with_output(
        "git", "diff", "--name-only", "FETCH_HEAD..HEAD", cwd=copy_path
    )
    changed_bps = sorted(
        {line.split("/")[0] for line in diff_out.splitlines() if "/" in line}
    )
    first_task: str | None = None
    for changed_bp in changed_bps:
        tid = await _spawn_dev_deploy(changed_bp, deployer)
        if tid and first_task is None:
            first_task = tid
    return SyncCopyResponse(
        status="success",
        method="fast-forward",
        message=f"Synced '{name}' into main (fast-forward).",
        deploy_task_id=first_task,
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


_NAME_STATUS_KIND = {
    "A": "added",
    "M": "modified",
    "D": "deleted",
    "R": "renamed",
    "C": "copied",
    "T": "modified",
}


@router.get("/{name}/status")
async def get_copy_status(name: str):
    """Per-file change list for a copy: everything that pressing Sync & Deploy
    will make the new main — commits ahead of main, plus uncommitted edits,
    plus new untracked files. The working tree (not just HEAD) is compared
    against main, so changes show whether or not they've been committed yet."""
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    # Refresh main from the local bare repo (filesystem, no credentials);
    # FETCH_HEAD then points at the current main.
    await call_git_command("git", "fetch", bare_repo_path(), "main", cwd=copy_path)

    by_path: dict[str, dict] = {}

    # Tracked delta vs main (commits ahead of main + staged/unstaged edits).
    # --no-renames so paths stay real (a rename becomes delete + add) — the UI
    # uses each path to fetch its per-file diff.
    num_out, _, _ = await call_git_command_with_output(
        "git", "diff", "--no-renames", "--numstat", "FETCH_HEAD", cwd=copy_path
    )
    for line in num_out.splitlines():
        parts = line.split("\t", 2)
        if len(parts) != 3:
            continue
        adds_str, dels_str, p = parts
        by_path[p] = {
            "path": p,
            "kind": "modified",
            "adds": int(adds_str) if adds_str.isdigit() else 0,
            "dels": int(dels_str) if dels_str.isdigit() else 0,
        }
    ns_out, _, _ = await call_git_command_with_output(
        "git", "diff", "--no-renames", "--name-status", "FETCH_HEAD", cwd=copy_path
    )
    for line in ns_out.splitlines():
        cols = line.split("\t")
        if len(cols) < 2:
            continue
        kind = _NAME_STATUS_KIND.get(cols[0][:1], "modified")
        p = cols[-1]  # for renames, the new path
        if p in by_path:
            by_path[p]["kind"] = kind
        else:
            by_path[p] = {"path": p, "kind": kind, "adds": 0, "dels": 0}

    # New untracked files (not in main and not yet committed) — the whole file
    # becomes main, so surface it as added.
    others_out, _, _ = await call_git_command_with_output(
        "git", "ls-files", "--others", "--exclude-standard", cwd=copy_path
    )
    for p in others_out.splitlines():
        p = p.strip()
        if p and p not in by_path:
            by_path[p] = {"path": p, "kind": "added", "adds": 0, "dels": 0}

    return {"changed": list(by_path.values())}


@router.get("/{name}/divergence")
async def get_bp_divergence(name: str, bp: str = Query(...)):
    """Split a copy's divergence from main into commits that touch THIS business
    process vs every OTHER business process.

    A per-BP Sync & Deploy only ever syncs/deploys the BP being viewed, so the
    whole-copy ahead/behind counts are misleading there: a copy can be far ahead
    of main purely because of work on *other* BPs, while the viewed BP is itself
    identical to main. This lets the UI show "this business process" and "other
    business processes" separately, so "up to date" reflects the BP you're on."""
    _validate_bp_dir(bp)
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    # Refresh our view of main from the local bare repo; FETCH_HEAD = current main.
    await call_git_command("git", "fetch", bare_repo_path(), "main", cwd=copy_path)

    async def _count(rng: str, path: str | None = None) -> int:
        args = ["git", "rev-list", "--count", rng]
        if path:
            args += ["--", path]
        out, _, rc = await call_git_command_with_output(*args, cwd=copy_path)
        return int(out.strip()) if rc == 0 and out.strip().isdigit() else 0

    ahead_total = await _count("FETCH_HEAD..HEAD")
    ahead_bp = await _count("FETCH_HEAD..HEAD", f"{bp}/")
    behind_total = await _count("HEAD..FETCH_HEAD")
    behind_bp = await _count("HEAD..FETCH_HEAD", f"{bp}/")
    return {
        "bp": bp,
        "ahead_bp": ahead_bp,
        "ahead_other": max(0, ahead_total - ahead_bp),
        "behind_bp": behind_bp,
        "behind_other": max(0, behind_total - behind_bp),
    }


async def _git_log(ref: str, copy_path: str, limit: int = 50) -> list[dict]:
    """Recent commits on `ref` as structured rows. Fields are unit-separated so
    subjects with tabs/spaces survive intact."""
    out, _, rc = await call_git_command_with_output(
        "git",
        "log",
        f"-{limit}",
        "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s",
        ref,
        cwd=copy_path,
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


@router.get("/{name}/history")
async def get_copy_history(name: str):
    """Commit history for the Sync & Deploy history view: this copy's commits
    and main's commits, with deploy markers (`<email> deployed <date>`) attached
    to the main commits each Sync & Deploy left at main's tip."""
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    await call_git_command("git", "fetch", bare_repo_path(), "main", cwd=copy_path)
    copy_commits = await _git_log("HEAD", copy_path)
    main_commits = await _git_log("FETCH_HEAD", copy_path)

    # Map main commit -> deploy-tag subjects. Annotated tags expose the tagged
    # commit via %(*objectname); fall back to %(objectname) just in case.
    # NB: for-each-ref does NOT interpret git-log's %x1f escape, so use a plain
    # separator. The two object ids are hex (no "|"); the subject is last, so
    # maxsplit=2 keeps a subject containing "|" intact.
    deploys: dict[str, list[str]] = {}
    tags_out, _, _ = await call_git_command_with_output(
        "git",
        "for-each-ref",
        "refs/tags/deploy",
        "--format=%(*objectname)|%(objectname)|%(contents:subject)",
        cwd=bare_repo_path(),
    )
    for line in tags_out.splitlines():
        f = line.split("|", 2)
        if len(f) == 3:
            commit_sha = f[0] or f[1]
            deploys.setdefault(commit_sha, []).append(f[2])
    for c in main_commits:
        c["deploys"] = deploys.get(c["sha"], [])

    return {"copy": copy_commits, "main": main_commits}


@router.get("/{name}/diff")
async def get_copy_diff(name: str, path: str | None = Query(None)):
    """Unified diff of the copy against main — what will become the new main on
    Sync & Deploy, committed or not. Optional `?path=` filter."""
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")
    if path is not None and not _is_safe_relative_path(path):
        raise HTTPException(status_code=400, detail="invalid path")

    await call_git_command("git", "fetch", bare_repo_path(), "main", cwd=copy_path)

    git_args: list[str] = ["git", "diff", "FETCH_HEAD"]
    git_args += ["--", path] if path is not None else ["--", "."]

    stdout, stderr, rc = await call_git_command_with_output(*git_args, cwd=copy_path)
    if rc != 0:
        raise HTTPException(
            status_code=500, detail=f"Failed to get diff: {stderr.strip()}"
        )

    # Untracked new files don't appear in `git diff` against a ref — show the
    # whole file as added (`--no-index` exits 1 when it finds a diff; that's
    # expected, not an error, so we ignore the return code and use the output).
    if path is not None and not stdout.strip():
        no_index_out, _, _ = await call_git_command_with_output(
            "git", "diff", "--no-index", "--", "/dev/null", path, cwd=copy_path
        )
        if no_index_out.strip():
            stdout = no_index_out

    return {"diff": stdout}


@router.get("/{name}/commit/{sha}/diff")
async def get_commit_diff(name: str, sha: str):
    """Unified diff introduced by a single commit (`git show`), for the history
    view's clickable rows. Resolves commits from both this copy (HEAD) and main:
    main's objects are fetched below, so either side of the graph is viewable."""
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")
    if not re.fullmatch(r"[0-9a-fA-F]{4,64}", sha or ""):
        raise HTTPException(status_code=400, detail="invalid commit")

    # main commits are reachable only via FETCH_HEAD's objects — fetch first.
    await call_git_command("git", "fetch", bare_repo_path(), "main", cwd=copy_path)
    stdout, stderr, rc = await call_git_command_with_output(
        "git", "show", "--no-color", "--format=medium", sha, cwd=copy_path
    )
    if rc != 0:
        raise HTTPException(
            status_code=404, detail=f"commit not found: {(stderr or stdout).strip()}"
        )
    return {"diff": stdout}
