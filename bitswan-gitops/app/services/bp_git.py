"""Shared git helpers for the per-business-process repos.

Every BP has its own canonical bare repo (``<bp>.git``, see
``app.services.git_server``) and each copy checks it out as an independent
clone at ``copies/<copy>/<bp>`` on branch ``<copy>`` (the ``main`` copy checks
out ``main``). This module holds the plumbing shared by the copies routes, BP
creation, template scaffolding and CVE waivers:

- resolving clone paths / remote URLs,
- committing inside a BP clone,
- advancing a BP repo's deploy-only ``main`` server-side (clients can never
  push ``main`` — the pre-receive hook rejects it; gitops moves the ref with a
  compare-and-swap ``update-ref`` after an ancestry check),
- keeping the ``copies/main/<bp>`` checkouts aligned with each bare ``main``.
"""

import logging
import os
import re
import shutil

from fastapi import HTTPException

from app.services.git_server import (
    bp_bare_repo_path,
    bp_main_has_content,
    list_bp_repos,
)
from app.utils import call_git_command, call_git_command_with_output

logger = logging.getLogger(__name__)


def copies_dir() -> str:
    """Base directory holding the per-copy checkouts."""
    return os.environ.get("BITSWAN_COPIES_DIR", "/copies")


def bp_clone_path(copy: str | None, bp: str) -> str:
    """Path of a BP's clone inside a copy (``None`` = the main copy)."""
    return os.path.join(copies_dir(), copy or "main", bp)


def list_bp_clones(copy_path: str) -> list[str]:
    """BP names checked out in a copy: subdirectories with their own .git."""
    if not os.path.isdir(copy_path):
        return []
    out: list[str] = []
    for entry in sorted(os.listdir(copy_path)):
        if entry.startswith("."):
            continue
        if os.path.isdir(os.path.join(copy_path, entry, ".git")):
            out.append(entry)
    return out


def git_remote_url(bp: str) -> str:
    """Smart-HTTP URL a clone uses as ``origin`` for a BP's repo.

    ``BITSWAN_GIT_REMOTE`` is the BASE URL (``http://<ws>-gitops:8079/git``).
    """
    base = os.environ.get("BITSWAN_GIT_REMOTE", "")
    if not base:
        ws = os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace")
        base = f"http://{ws}-gitops:8079/git"
    return f"{base.rstrip('/')}/{bp}.git"


# Where a clone keeps its view of the BP repo's main.
#
# NOT ``FETCH_HEAD``. FETCH_HEAD is a single file that EVERY ``git fetch`` in
# the same clone rewrites, and it is not written under a lock. gitops fetches
# concurrently into the same clone all the time — the divergence, behind,
# status, history and diff reads all do it on demand, from whichever browsers
# happen to be open, while a pull or a sync is running in the task queue. A
# reader that catches FETCH_HEAD mid-write sees an empty file, and
# ``git rebase FETCH_HEAD`` then dies with ``invalid upstream 'FETCH_HEAD'``
# (live-seen: a pull failed that way while two sessions were open).
#
# A real ref is updated through git's ref lock, so a concurrent fetch either
# has finished or has not — never half. Namespaced under refs/bitswan/ so it
# can never collide with a branch, a tag or a remote-tracking ref.
MAIN_REF = "refs/bitswan/main"


async def fetch_main(clone_path: str, bp: str) -> str:
    """Refresh the clone's view of the BP repo's main from the LOCAL bare
    (filesystem — gitops can't authenticate to its own smart-HTTP origin), and
    return the sha it now points at. :data:`MAIN_REF` names it.

    Raises on failure. A fetch that quietly fails leaves the ref at whatever it
    held before, so every ahead/behind count, diff and rebase computed
    afterwards is silently answered against a stale main."""
    ok = await call_git_command(
        "git",
        "fetch",
        "--no-tags",
        bp_bare_repo_path(bp),
        f"+refs/heads/main:{MAIN_REF}",
        cwd=clone_path,
    )
    if not ok:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read '{bp}'s main into {clone_path}",
        )
    out, err, rc = await call_git_command_with_output(
        "git", "rev-parse", MAIN_REF, cwd=clone_path
    )
    if rc != 0:
        raise HTTPException(
            status_code=500,
            detail=f"'{bp}'s main was fetched but could not be resolved: {(err or out).strip()}",
        )
    return out.strip()


async def commit_in_bp_clone(
    clone_path: str, message: str, author: str | None = None
) -> bool:
    """Stage everything in the BP clone and commit if anything changed.

    Returns True when a commit was created. `author` (an email) is recorded as
    the commit identity when given; otherwise the request's gate-verified
    identity (X-Forwarded-Email, carried in the `current_requester` contextvar),
    otherwise a mechanical identity for genuinely server-initiated commits.
    """
    from app.task_queue import current_requester

    await call_git_command("git", "add", "-A", cwd=clone_path)
    _, _, clean_rc = await call_git_command_with_output(
        "git", "diff", "--cached", "--quiet", cwd=clone_path
    )
    if clean_rc == 0:
        return False
    who = (author or "").strip() or (current_requester.get() or "").strip()
    ident = (
        ["-c", f"user.name={who}", "-c", f"user.email={who}"]
        if who
        else ["-c", "user.name=Bailey", "-c", "user.email=bailey@bitswan"]
    )
    _, err, rc = await call_git_command_with_output(
        "git", *ident, "commit", "-m", message, cwd=clone_path
    )
    if rc != 0:
        raise HTTPException(
            status_code=500, detail=f"Failed to commit in {clone_path}: {err.strip()}"
        )
    return True


async def ff_branch_to_ref(bp: str, branch: str, ref_or_sha: str) -> None:
    """Fast-forward one branch of a BP's bare repo to `ref_or_sha`, append-only.

    Verifies the target exists in the bare, checks `branch` is an ancestor (a
    true fast-forward), then advances the ref with a compare-and-swap
    ``update-ref`` (the expected old value guards against a concurrent
    advance). 409 when the target isn't a fast-forward or the branch moved
    concurrently.

    Used for ``main`` (copy → main sync, where clients can never push main) and
    for a parent copy's branch (experiment → parent merge-back).
    """
    bare = bp_bare_repo_path(bp)

    target_out, _, target_rc = await call_git_command_with_output(
        "git", "-C", bare, "rev-parse", "--verify", f"{ref_or_sha}^{{commit}}"
    )
    if target_rc != 0:
        raise HTTPException(
            status_code=404, detail=f"ref '{ref_or_sha}' not found in {bp}.git"
        )
    target = target_out.strip()

    old_out, _, old_rc = await call_git_command_with_output(
        "git", "-C", bare, "rev-parse", "--verify", f"refs/heads/{branch}"
    )
    if old_rc != 0:
        raise HTTPException(status_code=500, detail=f"{bp}.git has no {branch} branch")
    old = old_out.strip()

    _, _, ff_rc = await call_git_command_with_output(
        "git",
        "-C",
        bare,
        "merge-base",
        "--is-ancestor",
        f"refs/heads/{branch}",
        target,
    )
    if ff_rc != 0:
        raise HTTPException(
            status_code=409,
            detail=(
                f"'{ref_or_sha}' is not a fast-forward of {bp}'s {branch}. "
                f"Rebase onto the latest {branch} and push, then retry."
            ),
        )

    # Compare-and-swap: the trailing <oldvalue> makes update-ref fail if the
    # branch moved between the ancestry check and here.
    out, err, rc = await call_git_command_with_output(
        "git", "-C", bare, "update-ref", f"refs/heads/{branch}", target, old
    )
    if rc != 0:
        raise HTTPException(
            status_code=409,
            detail=(
                f"{bp}'s {branch} moved during the sync — retry: "
                f"{(err or out).strip()}"
            ),
        )


async def ff_main_to_ref(bp: str, ref_or_sha: str) -> None:
    """Fast-forward the BP repo's deploy-only ``main`` to `ref_or_sha`
    (thin wrapper over :func:`ff_branch_to_ref`)."""
    await ff_branch_to_ref(bp, "main", ref_or_sha)


async def publish_main_from_clone(clone_path: str, bp: str) -> None:
    """Publish the clone's HEAD as the BP repo's new ``main`` (fast-forward
    only). Used for main-scope commits (BP creation / scaffolding / waivers in
    the main copy): the pre-receive hook forbids pushing main directly, so the
    objects travel via a temp ref and the ref is advanced server-side."""
    head_out, _, head_rc = await call_git_command_with_output(
        "git", "rev-parse", "HEAD", cwd=clone_path
    )
    if head_rc != 0:
        raise HTTPException(
            status_code=500, detail=f"cannot resolve HEAD in {clone_path}"
        )
    head = head_out.strip()
    bare = bp_bare_repo_path(bp)
    tmp_ref = "refs/sync-tmp/publish-main"
    _, p_err, p_rc = await call_git_command_with_output(
        "git", "push", bare, f"HEAD:{tmp_ref}", cwd=clone_path
    )
    if p_rc != 0:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to publish objects to {bp}.git: {p_err.strip()}",
        )
    try:
        await ff_main_to_ref(bp, head)
    finally:
        await call_git_command_with_output(
            "git", "-C", bare, "update-ref", "-d", tmp_ref
        )
    await refresh_main_bp_checkout(bp)


async def publish_bp_clone(clone_path: str, bp: str, copy: str | None) -> None:
    """Publish a service-made commit (scaffold / rename / waiver).

    Main-scope commits must advance the deploy-only ``main`` server-side —
    before per-BP repos they were committed into the main checkout but never
    reached the bare, so the next main realign silently WIPED them. Copy-scope
    commits stay local and ride the copy until Sync & Deploy, exactly like the
    user's own edits."""
    if copy:
        return
    await publish_main_from_clone(clone_path, bp)


async def clone_bp_into_copy(
    copy_path: str, name: str, bp: str, base: str = "main", allow_empty: bool = False
) -> bool:
    """Materialize BP `bp` inside copy `name` as a clone of its bare repo on
    branch `name` (branch ``main`` itself when materializing the main copy).

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


async def refresh_main_bp_checkout(bp: str) -> None:
    """Align ``copies/main/<bp>`` with the BP repo's ``main`` tip.

    ``main`` is deploy-only (advances solely server-side), so an existing
    checkout is force-realigned (``reset --hard`` keeps untracked build
    artifacts, matching the old single-repo behavior). When the checkout does
    not exist yet but main HAS content — a BP just synced into main for the
    first time — clone it, which is what flips ``in_main`` in process
    discovery and enables main-scope live-dev."""
    main_dir = bp_clone_path(None, bp)
    bare = bp_bare_repo_path(bp)
    if os.path.isdir(os.path.join(main_dir, ".git")):
        tip = await fetch_main(main_dir, bp)
        out, err, rc = await call_git_command_with_output(
            "git", "reset", "--hard", tip, cwd=main_dir
        )
        if rc != 0:
            raise HTTPException(
                status_code=500,
                detail=(
                    f"{bp}'s main advanced, but the main checkout could not be "
                    f"realigned: {(err or out).strip()}"
                ),
            )
        return
    if not await bp_main_has_content(bp):
        return  # nothing on main yet (empty seed) — no checkout to create
    os.makedirs(os.path.dirname(main_dir), exist_ok=True)
    if not await call_git_command("git", "clone", bare, main_dir):
        raise HTTPException(
            status_code=500, detail=f"Failed to clone {bp}.git into the main copy"
        )
    await call_git_command(
        "git", "remote", "set-url", "origin", git_remote_url(bp), cwd=main_dir
    )


async def refresh_all_main_checkouts() -> None:
    """Startup self-heal: align every BP's main checkout (creating missing
    ones for main-carrying BPs)."""
    for bp in list_bp_repos():
        try:
            await refresh_main_bp_checkout(bp)
        except Exception as e:
            logger.warning("refresh_main_bp_checkout(%s) failed: %s", bp, e)


# ── root-owned tree removal (copy / BP delete) ──────────────────────────────
# Moved here from routes/copies.py so the delete orchestrators can share it.


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


async def remove_tree(path: str) -> bool:
    """Best-effort removal of a tree that may hold root-owned files: try the
    driver root-exec first, fall back to shutil (dev/test environments without
    a driver). Returns whether the path is gone."""
    if not os.path.exists(path):
        return True
    await _rm_rf_as_root_in_container(path)
    if os.path.exists(path):
        shutil.rmtree(path, ignore_errors=True)
    return not os.path.exists(path)


async def remove_bp_clone(copy: str | None, bp: str) -> bool:
    """Delete a BP's clone from a copy (BP delete). Missing clone = ok."""
    return await remove_tree(bp_clone_path(copy, bp))
