"""Provisioning for the workspace's per-business-process bare git repos.

Every business process (BP) has its OWN canonical bare repo
(``<bp>.git`` under ``BITSWAN_GIT_REPOS_DIR``) that the embedded smart-HTTP
server (``app/routes/git_http.py``) exposes. Coding agents and the editor keep
independent clones per BP (at ``copies/<copy>/<bp>``) whose ``origin`` points
back here, and push/pull with plain git. History is kept append-only by the
``pre-receive`` hook installed here (plus native ``receive.deny*`` config as
belt-and-suspenders), so already-committed history can never be rewritten, and
``main`` is deploy-only (advanced server-side by gitops, never by a push).

A fresh BP repo's ``main`` is seeded with an EMPTY root commit, so:
- a copy branch can always fork from ``origin/main`` (no orphan-branch cases),
- the first sync of a copy-created BP is a plain fast-forward of main,
- "the BP has content on main" has a crisp test: ``ls-tree main`` is non-empty.

Repos are created on demand when a BP is created; ``ensure_all_bp_repos()``
refreshes hooks/config on every startup.
"""

import logging
import os
import re
import shutil

from app.utils import call_git_command, call_git_command_with_output

logger = logging.getLogger(__name__)

# Directory (inside the gitops container) that holds the per-BP bare repos. The
# daemon mounts the workspace's `git-repos` volume subpath here.
GIT_REPOS_DIR = os.environ.get("BITSWAN_GIT_REPOS_DIR", "/git")

# Where the shipped pre-receive hook lives in the image (see Dockerfile).
HOOKS_SRC_DIR = os.environ.get("BITSWAN_GIT_HOOKS_DIR", "/opt/bitswan/git-hooks")

# BP directory names double as bare-repo file names (`<bp>.git`) and as git
# positional args. Must start alphanumeric (rules out hidden names, `.`/`..`
# and option injection); no path separators.
_BP_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

# Mechanical committer identity for server-side commits (seed commit); the
# human actor, when there is one, is recorded in commit subjects elsewhere.
_GIT_IDENT = ["-c", "user.name=Bailey", "-c", "user.email=bailey@bitswan"]


def validate_bp_name(bp: str) -> None:
    """Raise ValueError unless `bp` is a safe BP/repo name."""
    if not bp or not _BP_NAME_RE.match(bp):
        raise ValueError(f"invalid business process name: {bp!r}")


def bp_repo_name(bp: str) -> str:
    """Bare-repo directory name for a BP."""
    validate_bp_name(bp)
    return f"{bp}.git"


def bp_bare_repo_path(bp: str) -> str:
    """Absolute path to a BP's canonical bare repo inside the container.

    Validates the name and confirms the resolved path stays inside
    GIT_REPOS_DIR (defense in depth on top of the name regex).
    """
    base = os.path.realpath(GIT_REPOS_DIR)
    candidate = os.path.realpath(os.path.join(base, bp_repo_name(bp)))
    if os.path.dirname(candidate) != base:
        raise ValueError(f"invalid business process name: {bp!r}")
    return candidate


def list_bp_repos() -> list[str]:
    """Names of every BP that has a bare repo (initialized `<bp>.git` dirs)."""
    if not os.path.isdir(GIT_REPOS_DIR):
        return []
    out: list[str] = []
    for entry in sorted(os.listdir(GIT_REPOS_DIR)):
        if not entry.endswith(".git"):
            continue
        name = entry[: -len(".git")]
        if not _BP_NAME_RE.match(name):
            continue
        if os.path.isdir(os.path.join(GIT_REPOS_DIR, entry, "objects")):
            out.append(name)
    return out


def _install_pre_receive_hook(repo_path: str) -> None:
    """Install (or refresh) the fast-forward-only pre-receive hook."""
    hooks_dir = os.path.join(repo_path, "hooks")
    os.makedirs(hooks_dir, exist_ok=True)
    dst = os.path.join(hooks_dir, "pre-receive")
    src = os.path.join(HOOKS_SRC_DIR, "pre-receive")
    if os.path.isfile(src):
        shutil.copyfile(src, dst)
    else:
        # Fallback: write the hook inline so provisioning never depends on the
        # image layout. Keep in sync with bitswan-gitops/git-hooks/pre-receive.
        dst_content = (
            "#!/bin/sh\n"
            "set -eu\n"
            'is_zero() { case "$1" in *[!0]*) return 1 ;; *) return 0 ;; esac }\n'
            "while read -r oldrev newrev refname; do\n"
            '  if is_zero "$newrev"; then\n'
            '    echo "remote: rejected $refname: deleting refs is not allowed" >&2; exit 1\n'
            "  fi\n"
            '  if is_zero "$oldrev"; then continue; fi\n'
            '  if [ "$refname" = "refs/heads/main" ]; then\n'
            '    echo "remote: rejected $refname: main is deploy-only — push your copy branch and deploy it from the dashboard" >&2; exit 1\n'
            "  fi\n"
            '  if ! git merge-base --is-ancestor "$oldrev" "$newrev"; then\n'
            '    echo "remote: rejected $refname: non-fast-forward update is not allowed" >&2; exit 1\n'
            "  fi\n"
            "done\n"
            "exit 0\n"
        )
        with open(dst, "w") as f:
            f.write(dst_content)
    os.chmod(dst, 0o755)


def _ident_for(author: str | None) -> list[str]:
    """`-c user.name/email` git args attributing a commit to `author` (an email)
    when given, else the request's gate-verified identity (X-Forwarded-Email,
    carried in the `current_requester` contextvar), else the mechanical Bailey
    identity for genuinely server-initiated commits."""
    from app.task_queue import current_requester

    who = (author or "").strip() or (current_requester.get() or "").strip()
    if who:
        return ["-c", f"user.name={who}", "-c", f"user.email={who}"]
    return list(_GIT_IDENT)


async def _seed_empty_main(repo_path: str, bp: str, author: str | None = None) -> None:
    """Point refs/heads/main at an empty root commit (idempotent).

    The empty seed makes every downstream flow uniform: copy branches fork
    from origin/main, and the first real sync is a plain fast-forward. `author`
    (an email) is recorded as the seed commit's identity — the creating user —
    when given.
    """
    _, _, rc = await call_git_command_with_output(
        "git", "-C", repo_path, "rev-parse", "--verify", "refs/heads/main"
    )
    if rc == 0:
        return  # main already exists
    tree_out, tree_err, tree_rc = await call_git_command_with_output(
        "git", "-C", repo_path, "hash-object", "-t", "tree", "-w", "/dev/null"
    )
    if tree_rc != 0:
        raise RuntimeError(f"failed to write empty tree in {repo_path}: {tree_err}")
    commit_out, commit_err, commit_rc = await call_git_command_with_output(
        "git",
        "-C",
        repo_path,
        *_ident_for(author),
        "commit-tree",
        tree_out.strip(),
        "-m",
        f"Initialize business process {bp}",
    )
    if commit_rc != 0:
        raise RuntimeError(f"failed to create seed commit in {repo_path}: {commit_err}")
    await call_git_command_with_output(
        "git", "-C", repo_path, "update-ref", "refs/heads/main", commit_out.strip()
    )


async def ensure_bp_bare_repo(bp: str, author: str | None = None) -> str:
    """Ensure a BP's canonical bare repo exists and is fast-forward-only.

    Idempotent: safe to call on every startup and on every BP create.
    Returns the repo path.
    """
    repo_path = bp_bare_repo_path(bp)
    os.makedirs(GIT_REPOS_DIR, exist_ok=True)

    if not os.path.isdir(os.path.join(repo_path, "objects")):
        logger.info("Initializing bare repo for BP '%s' at %s", bp, repo_path)
        ok = await call_git_command(
            "git", "init", "--bare", "--initial-branch=main", repo_path
        )
        if not ok:
            # Older git without --initial-branch: fall back.
            await call_git_command("git", "init", "--bare", repo_path)

    # Smart-HTTP push + append-only guards. These are idempotent.
    await call_git_command_with_output(
        "git", "-C", repo_path, "config", "http.receivepack", "true"
    )
    await call_git_command_with_output(
        "git", "-C", repo_path, "config", "receive.denyNonFastForwards", "true"
    )
    await call_git_command_with_output(
        "git", "-C", repo_path, "config", "receive.denyDeletes", "true"
    )

    _install_pre_receive_hook(repo_path)
    await _seed_empty_main(repo_path, bp, author)
    return repo_path


async def delete_copy_branch(bp: str, copy: str) -> bool:
    """Delete a copy's branch in a BP's bare repo, server-side.

    `receive.denyDeletes` and the pre-receive hook only bind PUSHES
    (receive-pack); a filesystem `update-ref -d` bypasses them by design —
    this is the only sanctioned way a copy branch ever disappears (copy
    delete). Returns True when the ref was deleted, False when the repo or
    ref didn't exist (idempotent)."""
    validate_bp_name(bp)
    if not copy or not _BP_NAME_RE.match(copy) or copy == "main":
        raise ValueError(f"invalid copy name: {copy!r}")
    repo_path = bp_bare_repo_path(bp)
    if not os.path.isdir(os.path.join(repo_path, "objects")):
        return False
    # Existence check first: some git versions exit 0 when -d'ing a missing
    # ref, so rc alone can't distinguish "deleted" from "was never there".
    _, _, rc = await call_git_command_with_output(
        "git", "-C", repo_path, "show-ref", "--verify", "-q", f"refs/heads/{copy}"
    )
    if rc != 0:
        return False
    _, _, rc = await call_git_command_with_output(
        "git", "-C", repo_path, "update-ref", "-d", f"refs/heads/{copy}"
    )
    return rc == 0


def delete_bp_bare_repo(bp: str) -> bool:
    """Remove a BP's canonical bare repo entirely (BP delete, last destructive
    step — after this nothing can re-materialize the BP). Missing repo = no-op.
    """
    repo_path = bp_bare_repo_path(bp)
    if not os.path.isdir(repo_path):
        return False
    shutil.rmtree(repo_path)
    return True


async def ensure_all_bp_repos() -> None:
    """Refresh config/hooks (and any missing seed commit) on every existing BP
    repo — the startup counterpart of per-BP creation. Also makes sure the
    repos dir itself exists so first-BP creation never races a missing mount
    point."""
    os.makedirs(GIT_REPOS_DIR, exist_ok=True)
    for bp in list_bp_repos():
        try:
            await ensure_bp_bare_repo(bp)
        except Exception as e:
            logger.warning("ensure_bp_bare_repo(%s) failed: %s", bp, e)


async def bp_main_has_content(bp: str) -> bool:
    """True when the BP's main branch carries real content (not just the empty
    seed commit). Drives eager-cloning into new copies, main-copy
    materialization, and the `in_main` flag."""
    repo_path = bp_bare_repo_path(bp)
    out, _, rc = await call_git_command_with_output(
        "git", "-C", repo_path, "ls-tree", "main"
    )
    return rc == 0 and bool(out.strip())


async def bp_name_is_taken(bp: str) -> bool:
    """True when this business-process name already belongs to something.

    A business process is ONE repo for the whole workspace — the name is
    workspace-wide, not per copy. So the name is taken if main carries content
    OR if any copy branch exists, which is the case for a business process that
    was created inside someone's copy or experiment and has not been deployed to
    main yet. Checking only main let a second person create a business process
    with the same name, landing two unrelated histories in one repo.

    An empty seed with no branches at all is NOT taken — that is the leftover of
    a failed earlier attempt, which creation deliberately reuses.
    """
    if await bp_main_has_content(bp):
        return True
    out, _, rc = await call_git_command_with_output(
        "git",
        "-C",
        bp_bare_repo_path(bp),
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/",
    )
    if rc != 0:
        return False
    return any(
        ref.strip() and ref.strip() != "refs/heads/main" for ref in out.splitlines()
    )
