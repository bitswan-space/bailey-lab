"""Tests for the per-BP bare repos + fast-forward-only git server.

Covers provisioning (`ensure_bp_bare_repo`: config, hook, empty seed commit),
the append-only guarantee of the `pre-receive` hook (ff accepted, force-push /
delete / main-push rejected), repo discovery + name validation, the smart-HTTP
path validation, and the copies-aware relative_path parsing in
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
def repos_dir(tmp_path, monkeypatch):
    # GIT_REPOS_DIR / HOOKS_SRC_DIR are module-level constants read at import,
    # so patch the attributes directly rather than the environment.
    monkeypatch.setattr(git_server, "GIT_REPOS_DIR", str(tmp_path / "git"))
    # Force the inline-hook fallback (the shipped hook path won't exist in CI).
    monkeypatch.setattr(
        git_server, "HOOKS_SRC_DIR", str(tmp_path / "nonexistent-hooks")
    )
    return str(tmp_path / "git")


def test_ensure_bp_bare_repo_provisions_hook_config_and_seed(repos_dir):
    repo = asyncio.run(git_server.ensure_bp_bare_repo("bpa"))
    assert repo == os.path.join(repos_dir, "bpa.git")
    assert os.path.isdir(os.path.join(repo, "objects"))
    hook = os.path.join(repo, "hooks", "pre-receive")
    assert os.path.isfile(hook)
    assert os.access(hook, os.X_OK)
    cfg = _git(
        "-C", repo, "config", "--get", "receive.denyNonFastForwards"
    ).stdout.strip()
    assert cfg == "true"
    # main exists and points at the EMPTY seed commit.
    assert _git(
        "-C", repo, "rev-parse", "--verify", "refs/heads/main", check=False
    ).stdout.strip()
    assert _git("-C", repo, "ls-tree", "main").stdout.strip() == ""
    assert asyncio.run(git_server.bp_main_has_content("bpa")) is False

    # Idempotent: a second ensure neither re-seeds nor errors.
    seed_sha = _git("-C", repo, "rev-parse", "main").stdout.strip()
    asyncio.run(git_server.ensure_bp_bare_repo("bpa"))
    assert _git("-C", repo, "rev-parse", "main").stdout.strip() == seed_sha


def test_list_bp_repos_and_ensure_all(repos_dir):
    asyncio.run(git_server.ensure_bp_bare_repo("bpa"))
    asyncio.run(git_server.ensure_bp_bare_repo("bpb"))
    assert git_server.list_bp_repos() == ["bpa", "bpb"]
    # ensure_all refreshes without error and discovers both.
    asyncio.run(git_server.ensure_all_bp_repos())
    assert git_server.list_bp_repos() == ["bpa", "bpb"]


def test_bp_name_validation(repos_dir):
    for bad in ("", ".", "..", "../x", "a/b", "-lead", ".hidden"):
        with pytest.raises(ValueError):
            git_server.bp_bare_repo_path(bad)


def test_fast_forward_only_enforcement_per_repo(repos_dir, tmp_path):
    repo = asyncio.run(git_server.ensure_bp_bare_repo("bpa"))
    work = tmp_path / "work"
    _git("clone", repo, str(work))
    _git("checkout", "-qb", "feature1", "origin/main", cwd=work)

    (work / "a.txt").write_text("a")
    _git("add", "-A", cwd=work)
    _git("commit", "-qm", "c1", cwd=work)

    # `main` is deploy-only: it always exists (the seed commit), so ANY direct
    # push to it is rejected — main is advanced server-side by the gated sync.
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

    # A second BP repo is fully independent: its main is still the seed.
    other = asyncio.run(git_server.ensure_bp_bare_repo("bpb"))
    assert _git("-C", other, "ls-tree", "main").stdout.strip() == ""


def test_bp_main_has_content_flips_after_server_side_advance(repos_dir, tmp_path):
    repo = asyncio.run(git_server.ensure_bp_bare_repo("bpa"))
    work = tmp_path / "w"
    _git("clone", repo, str(work))
    (work / "f.txt").write_text("x")
    _git("add", "-A", cwd=work)
    _git("commit", "-qm", "content", cwd=work)
    _git("push", "origin", "HEAD:refs/heads/u1", cwd=work)
    # Server-side ff of main (how gitops advances it — bypasses the hook).
    _git("-C", repo, "update-ref", "refs/heads/main", "refs/heads/u1")
    assert asyncio.run(git_server.bp_main_has_content("bpa")) is True


def test_git_http_path_validation():
    from app.routes.git_http import _valid_git_path

    assert _valid_git_path("bpa.git/info/refs")
    assert _valid_git_path("bpa.git/git-upload-pack")
    assert _valid_git_path("my-bp_2.x.git/objects/info/packs")
    assert not _valid_git_path("bpa/info/refs")  # no .git suffix
    assert not _valid_git_path("../etc.git/info/refs")
    assert not _valid_git_path("bpa.git/../other.git/info/refs")
    assert not _valid_git_path(".hidden.git/info/refs")
    assert not _valid_git_path("")
    assert not _valid_git_path("bpa.git//info/refs")


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
