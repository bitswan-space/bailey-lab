"""Tests for the canonical bare repo + fast-forward-only git server.

Covers provisioning (`ensure_bare_repo`) and the append-only guarantee of the
`pre-receive` hook (ff accepted, force-push / delete rejected, new branch
allowed), plus the copies-aware relative_path parsing in
`derive_bp_and_copy`.
"""

import asyncio
import os
import subprocess

import pytest

from app.services import git_server
from app.services.bp_databases import derive_bp_and_copy


def _git(*args, cwd=None, check=True):
    env = dict(os.environ)
    env.setdefault("GIT_AUTHOR_NAME", "t")
    env.setdefault("GIT_AUTHOR_EMAIL", "t@t")
    env.setdefault("GIT_COMMITTER_NAME", "t")
    env.setdefault("GIT_COMMITTER_EMAIL", "t@t")
    return subprocess.run(
        ["git", *args], cwd=cwd, env=env, capture_output=True, text=True, check=check
    )


@pytest.fixture()
def bare_repo(tmp_path, monkeypatch):
    # GIT_REPOS_DIR / HOOKS_SRC_DIR are module-level constants read at import,
    # so patch the attributes directly rather than the environment.
    monkeypatch.setattr(git_server, "GIT_REPOS_DIR", str(tmp_path / "git"))
    # Force the inline-hook fallback (the shipped hook path won't exist in CI).
    monkeypatch.setattr(
        git_server, "HOOKS_SRC_DIR", str(tmp_path / "nonexistent-hooks")
    )
    repo = asyncio.run(git_server.ensure_bare_repo())
    return repo


def test_ensure_bare_repo_provisions_hook_and_config(bare_repo):
    assert os.path.isdir(os.path.join(bare_repo, "objects"))
    hook = os.path.join(bare_repo, "hooks", "pre-receive")
    assert os.path.isfile(hook)
    assert os.access(hook, os.X_OK)
    cfg = _git(
        "-C", bare_repo, "config", "--get", "receive.denyNonFastForwards"
    ).stdout.strip()
    assert cfg == "true"


def test_fast_forward_only_enforcement(bare_repo, tmp_path):
    work = tmp_path / "work"
    _git("clone", bare_repo, str(work))

    (work / "a.txt").write_text("a")
    _git("add", "-A", cwd=work)
    _git("commit", "-qm", "c1", cwd=work)

    # Creating `main` (the one-time workspace seed) is allowed.
    assert (
        _git("push", "origin", "HEAD:refs/heads/main", cwd=work, check=False).returncode
        == 0
    )

    # `main` is deploy-only: a direct push to the EXISTING main is rejected,
    # even a fast-forward — main is advanced server-side by the gated deploy.
    (work / "b.txt").write_text("b")
    _git("add", "-A", cwd=work)
    _git("commit", "-qm", "c2", cwd=work)
    blocked = _git("push", "origin", "HEAD:refs/heads/main", cwd=work, check=False)
    assert blocked.returncode != 0
    assert "deploy-only" in (blocked.stderr + blocked.stdout).lower()

    # Copy branches are normal append-only branches. Creation is allowed.
    assert (
        _git(
            "push", "origin", "HEAD:refs/heads/feature1", cwd=work, check=False
        ).returncode
        == 0
    )

    # Fast-forward on a copy branch is allowed.
    (work / "c.txt").write_text("c")
    _git("add", "-A", cwd=work)
    _git("commit", "-qm", "c3", cwd=work)
    assert (
        _git(
            "push", "origin", "HEAD:refs/heads/feature1", cwd=work, check=False
        ).returncode
        == 0
    )

    # History rewrite + force-push on a copy branch is rejected.
    _git("commit", "-q", "--amend", "-m", "c3-rewritten", cwd=work)
    forced = _git(
        "push", "-f", "origin", "HEAD:refs/heads/feature1", cwd=work, check=False
    )
    assert forced.returncode != 0
    assert "fast-forward" in (forced.stderr + forced.stdout).lower()

    # Branch deletion is rejected.
    deleted = _git("push", "origin", "--delete", "feature1", cwd=work, check=False)
    assert deleted.returncode != 0


def test_derive_bp_and_copy_parsing():
    # main copy -> no copy context (stays unprefixed, like legacy main)
    assert derive_bp_and_copy("copies/main/Test/backend") == ("test", "")
    # non-main copy -> copy context is the copy name
    assert derive_bp_and_copy("copies/feature1/Test/backend") == (
        "test",
        "feature1",
    )
    # top-level automation (no BP segment)
    assert derive_bp_and_copy("copies/main/solo") == ("", "")
