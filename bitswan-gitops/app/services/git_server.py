"""Provisioning for the workspace's canonical bare git repo.

The workspace has one canonical bare repo (`repo.git`) that the embedded
smart-HTTP server (``app/routes/git_http.py``) exposes. Coding agents and the
editor each keep their own independent *copy* (a normal ``git clone``) whose
``origin`` points back here, and push/pull with plain git. History is kept
append-only by the ``pre-receive`` hook installed here (plus native
``receive.deny*`` config as belt-and-suspenders), so already-committed history
can never be rewritten.

Seeding the repo with initial history is done by the daemon at workspace init
(it owns the source history); this module only guarantees the bare repo and its
fast-forward-only guard exist, idempotently.
"""

import logging
import os
import shutil

from app.utils import call_git_command, call_git_command_with_output

logger = logging.getLogger(__name__)

# Directory (inside the gitops container) that holds the bare repo. The daemon
# mounts the workspace's `repo.git` volume subpath here.
GIT_REPOS_DIR = os.environ.get("BITSWAN_GIT_REPOS_DIR", "/git")
REPO_NAME = "repo.git"

# Where the shipped pre-receive hook lives in the image (see Dockerfile).
HOOKS_SRC_DIR = os.environ.get("BITSWAN_GIT_HOOKS_DIR", "/opt/bitswan/git-hooks")


def bare_repo_path() -> str:
    """Absolute path to the canonical bare repo inside the container."""
    return os.path.join(GIT_REPOS_DIR, REPO_NAME)


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
            "is_zero() { case \"$1\" in *[!0]*) return 1 ;; *) return 0 ;; esac }\n"
            "while read -r oldrev newrev refname; do\n"
            '  if is_zero "$newrev"; then\n'
            '    echo "remote: rejected $refname: deleting refs is not allowed" >&2; exit 1\n'
            "  fi\n"
            '  if is_zero "$oldrev"; then continue; fi\n'
            '  if ! git merge-base --is-ancestor "$oldrev" "$newrev"; then\n'
            '    echo "remote: rejected $refname: non-fast-forward update is not allowed" >&2; exit 1\n'
            "  fi\n"
            "done\n"
            "exit 0\n"
        )
        with open(dst, "w") as f:
            f.write(dst_content)
    os.chmod(dst, 0o755)


async def ensure_bare_repo() -> str:
    """Ensure the canonical bare repo exists and is fast-forward-only.

    Idempotent: safe to call on every startup. Returns the repo path.
    """
    repo_path = bare_repo_path()
    os.makedirs(GIT_REPOS_DIR, exist_ok=True)

    if not os.path.isdir(os.path.join(repo_path, "objects")):
        logger.info("Initializing canonical bare repo at %s", repo_path)
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
    return repo_path
