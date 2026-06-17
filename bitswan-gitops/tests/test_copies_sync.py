"""Tests for copy → main sync: whole-copy fast-forward, per-BP commit filtering
(cherry-pick + auto-rebase), conflict handling, and the per-commit diff endpoint.

The sync path runs real git against a temp bare repo + temp copies dir, so these
exercise the actual cherry-pick / rebase / update-ref mechanics rather than
mocks.
"""

import asyncio
import os
import subprocess

import pytest

from app.services import git_server
from app.routes import copies
from app.routes.copies import SyncCopyRequest, get_commit_diff, sync_copy


def _git(*args, cwd=None, check=True):
    env = dict(os.environ)
    env.setdefault("GIT_AUTHOR_NAME", "t")
    env.setdefault("GIT_AUTHOR_EMAIL", "t@t")
    env.setdefault("GIT_COMMITTER_NAME", "t")
    env.setdefault("GIT_COMMITTER_EMAIL", "t@t")
    return subprocess.run(
        ["git", *args], cwd=cwd, env=env, capture_output=True, text=True, check=check
    )


def _commit(work, rel, text, msg):
    path = os.path.join(work, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)
    _git("add", "-A", cwd=work)
    _git("commit", "-qm", msg, cwd=work)


def _main_tree(bare):
    """Top-level entries on the bare repo's main branch."""
    out = _git("-C", bare, "ls-tree", "--name-only", "main").stdout
    return set(out.split())


def _branch_subjects(bare, ref):
    out = _git("-C", bare, "log", "--format=%s", ref).stdout
    return [l for l in out.splitlines() if l]


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """A provisioned bare repo + a `main` copy, with two BPs (bpa, bpb) seeded
    on main. Returns helpers + paths."""
    monkeypatch.setattr(git_server, "GIT_REPOS_DIR", str(tmp_path / "git"))
    monkeypatch.setattr(
        git_server, "HOOKS_SRC_DIR", str(tmp_path / "nonexistent-hooks")
    )
    copies_dir = tmp_path / "copies"
    copies_dir.mkdir()
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(copies_dir))

    bare = asyncio.run(git_server.ensure_bare_repo())

    # Seed main with two BPs from a throwaway checkout.
    seed = tmp_path / "seed"
    _git("clone", "-q", bare, str(seed))
    _commit(str(seed), "bpa/file.txt", "a0\n", "seed bpa")
    _commit(str(seed), "bpb/file.txt", "b0\n", "seed bpb")
    _git("push", "-q", "origin", "HEAD:refs/heads/main", cwd=str(seed))

    # The gitops-maintained `main` copy (scanners + ff target).
    _git("clone", "-q", "--branch", "main", bare, str(copies_dir / "main"))

    def make_copy(name):
        path = copies_dir / name
        _git("clone", "-q", "--branch", "main", bare, str(path))
        _git("checkout", "-q", "-b", name, cwd=str(path))
        return str(path)

    return {
        "bare": bare,
        "copies_dir": str(copies_dir),
        "make_copy": make_copy,
        "tmp_path": tmp_path,
    }


def test_per_bp_sync_merges_only_that_bp(env):
    """A copy with commits touching two BPs syncs ONLY the named BP into main;
    the other BP's commit stays behind on the (rebased) copy."""
    copy = env["make_copy"]("u1")
    _commit(copy, "bpa/file.txt", "a1\n", "bpa change")
    _commit(copy, "bpb/file.txt", "b1\n", "bpb change")

    res = asyncio.run(sync_copy("u1", SyncCopyRequest(deployer="dev@x", bp="bpa")))
    assert res.status == "success"

    bare = env["bare"]
    # main got the bpa change but NOT the bpb change.
    subjects = _branch_subjects(bare, "main")
    assert "bpa change" in subjects
    assert "bpb change" not in subjects
    assert _git("-C", bare, "show", "main:bpa/file.txt").stdout == "a1\n"
    assert _git("-C", bare, "show", "main:bpb/file.txt").stdout == "b0\n"

    # The copy was rebased onto the new main: the new main is now an ancestor of
    # the copy, and the copy's ONLY un-merged commit is the bpb change (the bpa
    # commit is in main, not duplicated on the copy).
    assert (
        _git(
            "-C", bare, "merge-base", "--is-ancestor", "main", "u1", check=False
        ).returncode
        == 0
    )
    ahead = _branch_subjects(bare, "main..u1")
    assert ahead == ["bpb change"]
    # The main copy checkout was advanced too (drives in_main / live-dev).
    main_copy = os.path.join(env["copies_dir"], "main")
    with open(os.path.join(main_copy, "bpa", "file.txt")) as f:
        assert f.read() == "a1\n"


def test_per_bp_sync_conflict_leaves_main_untouched(env):
    """When the BP's commits don't cherry-pick cleanly onto main, sync returns
    needs_rebase and does NOT advance main."""
    # Both copies branch from the ORIGINAL main, then change the same bpa line
    # divergently. u2 is created BEFORE u1 syncs so it doesn't pick up u1's
    # change — that's what makes the later cherry-pick conflict.
    u1 = env["make_copy"]("u1")
    u2 = env["make_copy"]("u2")
    _commit(u1, "bpa/file.txt", "first\n", "u1 bpa")
    _commit(u2, "bpa/file.txt", "second\n", "u2 bpa")

    r1 = asyncio.run(sync_copy("u1", SyncCopyRequest(deployer="d@x", bp="bpa")))
    assert r1.status == "success"

    bare = env["bare"]
    main_before = _git("-C", bare, "rev-parse", "main").stdout.strip()

    r2 = asyncio.run(sync_copy("u2", SyncCopyRequest(deployer="d@x", bp="bpa")))

    assert r2.status == "needs_rebase"
    # main untouched by the failed sync.
    assert _git("-C", bare, "rev-parse", "main").stdout.strip() == main_before
    # No temp ref left dangling.
    refs = _git("-C", bare, "for-each-ref", "refs/sync-tmp").stdout.strip()
    assert refs == ""


def test_whole_copy_sync_fast_forwards(env):
    """Without a BP, a copy that is purely ahead fast-forwards main wholesale."""
    copy = env["make_copy"]("u1")
    _commit(copy, "bpa/file.txt", "a1\n", "bpa change")
    _commit(copy, "bpb/file.txt", "b1\n", "bpb change")

    res = asyncio.run(sync_copy("u1", SyncCopyRequest(deployer="dev@x")))
    assert res.status == "success"
    subjects = _branch_subjects(env["bare"], "main")
    assert "bpa change" in subjects and "bpb change" in subjects


def test_commit_diff_returns_patch(env):
    """The per-commit diff endpoint returns the patch a commit introduced."""
    copy = env["make_copy"]("u1")
    _commit(copy, "bpa/file.txt", "a1\n", "bpa change")
    sha = _git("-C", copy, "rev-parse", "HEAD").stdout.strip()

    out = asyncio.run(get_commit_diff("u1", sha))
    diff = out["diff"]
    assert "bpa change" in diff  # commit subject (git show --format=medium)
    assert "bpa/file.txt" in diff
    assert "+a1" in diff


def test_commit_diff_rejects_bad_sha(env):
    env["make_copy"]("u1")
    with pytest.raises(Exception):
        asyncio.run(get_commit_diff("u1", "not-a-sha"))
