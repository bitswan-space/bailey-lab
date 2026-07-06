"""Tests for business-process creation in the per-BP-repo world.

Creation makes the BP its OWN git repo + a clone in the target scope, commits
the scaffold, and — for the main scope — publishes it to the repo's
deploy-only main (previously a main-scope scaffold was committed into the
main checkout but never reached the bare, so the next realign silently wiped
it). Copy-scope creation rides the copy until Sync & Deploy.
"""

import asyncio
import os
import subprocess

import pytest

from app.routes.copies import SyncCopyRequest, sync_copy
from app.services import bp_git, git_server
from app.services.process_service import ProcessService


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
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(git_server, "GIT_REPOS_DIR", str(tmp_path / "git"))
    monkeypatch.setattr(
        git_server, "HOOKS_SRC_DIR", str(tmp_path / "nonexistent-hooks")
    )
    copies_dir = tmp_path / "copies"
    copies_dir.mkdir()
    (copies_dir / "main").mkdir()
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(copies_dir))
    monkeypatch.delenv("BITSWAN_GIT_REMOTE", raising=False)
    # template_service._commit uses --author but relies on the ambient
    # committer identity (the gitops container configures one); provide it.
    monkeypatch.setenv("GIT_COMMITTER_NAME", "t")
    monkeypatch.setenv("GIT_COMMITTER_EMAIL", "t@t")
    return {"copies_dir": str(copies_dir), "svc": ProcessService()}


def test_create_in_main_publishes_bare_main(env):
    svc = env["svc"]
    entry = asyncio.run(svc.create_business_process("orders"))
    assert entry["name"] == "orders" and entry["in_main"] is True

    # The BP has its own repo and the scaffold reached its deploy-only main —
    # not just the checkout (the old latent bug).
    bare = git_server.bp_bare_repo_path("orders")
    assert os.path.isdir(os.path.join(bare, "objects"))
    assert asyncio.run(git_server.bp_main_has_content("orders")) is True
    names = _git("-C", bare, "ls-tree", "--name-only", "main").stdout.split()
    assert "process.toml" in names and "README.md" in names

    # The main checkout is a clone of the BP repo, clean and aligned.
    clone = os.path.join(env["copies_dir"], "main", "orders")
    assert os.path.isdir(os.path.join(clone, ".git"))
    assert _git("status", "--porcelain", cwd=clone).stdout.strip() == ""


def test_create_in_copy_rides_until_sync(env):
    svc = env["svc"]
    copy_dir = os.path.join(env["copies_dir"], "u1")
    os.makedirs(copy_dir)

    entry = asyncio.run(svc.create_business_process("orders", copy="u1"))
    assert entry["in_main"] is False and entry["copies"] == ["u1"]

    # Repo exists, but main is still the empty seed (nothing published yet).
    assert asyncio.run(git_server.bp_main_has_content("orders")) is False
    clone = os.path.join(copy_dir, "orders")
    branch = _git("rev-parse", "--abbrev-ref", "HEAD", cwd=clone).stdout.strip()
    assert branch == "u1"

    # First sync fast-forwards main from the seed and materializes the main
    # checkout (flips in_main in discovery).
    res = asyncio.run(sync_copy("u1", SyncCopyRequest(deployer="d@x", bp="orders")))
    assert res.status == "success"
    assert asyncio.run(git_server.bp_main_has_content("orders")) is True
    assert os.path.isdir(os.path.join(env["copies_dir"], "main", "orders", ".git"))


def test_create_duplicate_rejected(env):
    svc = env["svc"]
    asyncio.run(svc.create_business_process("orders"))
    with pytest.raises(FileExistsError):
        asyncio.run(svc.create_business_process("orders"))


def test_waiver_write_publishes_main_scope(env):
    """A main-scope CVE waiver is committed in the BP clone AND advances the
    repo's main (it would otherwise be wiped by the next realign)."""
    from app.services import cve_waivers

    svc = env["svc"]
    asyncio.run(svc.create_business_process("orders"))
    asyncio.run(
        cve_waivers.set_waiver(
            "orders", None, "libx", "CVE-2024-1", "accepted", "a@b", "Jan 1, 2026"
        )
    )
    bare = git_server.bp_bare_repo_path("orders")
    names = _git("-C", bare, "ls-tree", "--name-only", "main").stdout.split()
    assert "cve-waivers.yaml" in names
    # And the copy-scope variant stays local until sync.
    copy_dir = os.path.join(env["copies_dir"], "u1")
    os.makedirs(copy_dir)
    asyncio.run(bp_git.clone_bp_into_copy(copy_dir, "u1", "orders"))
    asyncio.run(
        cve_waivers.set_waiver(
            "orders", "u1", "liby", "CVE-2024-2", "accepted", "a@b", "Jan 1, 2026"
        )
    )
    main_names = _git("-C", bare, "ls-tree", "--name-only", "main").stdout
    content = _git("-C", bare, "show", "main:cve-waivers.yaml").stdout
    assert "CVE-2024-2" not in content
    assert "cve-waivers.yaml" in main_names
