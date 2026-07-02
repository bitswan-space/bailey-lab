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

    ``BITSWAN_GIT_REMOTE`` is the BASE URL (``http://<ws>-gitops:8079/git``);
    tolerate the legacy single-repo value (`.../git/repo.git`) during rollout
    by stripping the repo suffix.
    """
    base = os.environ.get("BITSWAN_GIT_REMOTE", "")
    if base.endswith("/repo.git"):
        base = base[: -len("/repo.git")]
    if not base:
        ws = os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace")
        base = f"http://{ws}-gitops:8079/git"
    return f"{base.rstrip('/')}/{bp}.git"


async def fetch_main(clone_path: str, bp: str) -> None:
    """Refresh the clone's view of the BP repo's main from the LOCAL bare
    (filesystem — gitops can't authenticate to its own smart-HTTP origin).
    FETCH_HEAD then points at the current main."""
    await call_git_command(
        "git", "fetch", bp_bare_repo_path(bp), "main", cwd=clone_path
    )


async def commit_in_bp_clone(
    clone_path: str, message: str, author: str | None = None
) -> bool:
    """Stage everything in the BP clone and commit if anything changed.

    Returns True when a commit was created. `author` (an email) is recorded as
    the commit identity when given; otherwise a mechanical identity.
    """
    await call_git_command("git", "add", "-A", cwd=clone_path)
    _, _, clean_rc = await call_git_command_with_output(
        "git", "diff", "--cached", "--quiet", cwd=clone_path
    )
    if clean_rc == 0:
        return False
    who = (author or "").strip()
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


async def ff_main_to_ref(bp: str, ref_or_sha: str) -> None:
    """Fast-forward the BP repo's ``main`` to `ref_or_sha`, append-only.

    Verifies the target exists in the bare, checks main is an ancestor (a true
    fast-forward), then advances the ref with a compare-and-swap ``update-ref``
    (the expected old value guards against a concurrent advance). 409 when the
    target isn't a fast-forward or main moved concurrently.
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
        "git", "-C", bare, "rev-parse", "--verify", "refs/heads/main"
    )
    if old_rc != 0:
        raise HTTPException(status_code=500, detail=f"{bp}.git has no main branch")
    old = old_out.strip()

    _, _, ff_rc = await call_git_command_with_output(
        "git", "-C", bare, "merge-base", "--is-ancestor", "refs/heads/main", target
    )
    if ff_rc != 0:
        raise HTTPException(
            status_code=409,
            detail=(
                f"'{ref_or_sha}' is not a fast-forward of {bp}'s main. Rebase "
                "onto the latest main and push, then retry."
            ),
        )

    # Compare-and-swap: the trailing <oldvalue> makes update-ref fail if main
    # moved between the ancestry check and here.
    out, err, rc = await call_git_command_with_output(
        "git", "-C", bare, "update-ref", "refs/heads/main", target, old
    )
    if rc != 0:
        raise HTTPException(
            status_code=409,
            detail=(
                f"{bp}'s main moved during the sync — retry: " f"{(err or out).strip()}"
            ),
        )


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
        await call_git_command("git", "fetch", bare, "main", cwd=main_dir)
        out, err, rc = await call_git_command_with_output(
            "git", "reset", "--hard", "FETCH_HEAD", cwd=main_dir
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
