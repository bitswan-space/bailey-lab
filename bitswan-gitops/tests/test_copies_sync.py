"""Tests for copy → main sync in the per-BP-repo world: per-BP fast-forward,
whole-copy aggregation, conflict handling, divergence, rebase (pull), clone
materialization, and the per-commit diff endpoint.

The sync path runs real git against per-BP temp bare repos + a temp copies
dir, so these exercise the actual push / update-ref / rebase mechanics rather
than mocks.
"""

import asyncio
import os
import subprocess

import pytest

from app.routes import copies
from app.routes.copies import (
    SyncCopyRequest,
    get_all_bp_divergence,
    get_bp_divergence,
    get_commit_diff,
    rebase_copy,
    sync_copy,
)
from app.services import bp_git, git_server


def _git(*args, cwd=None, check=True):
    env = dict(os.environ)
    env.setdefault("GIT_AUTHOR_NAME", "t")
    env.setdefault("GIT_AUTHOR_EMAIL", "t@t")
    env.setdefault("GIT_COMMITTER_NAME", "t")
    env.setdefault("GIT_COMMITTER_EMAIL", "t@t")
    return subprocess.run(
        ["git", *args], cwd=cwd, env=env, capture_output=True, text=True, check=check
    )


def _commit(clone, rel, text, msg):
    path = os.path.join(clone, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)
    _git("add", "-A", cwd=clone)
    _git("commit", "-qm", msg, cwd=clone)


def _branch_subjects(bare, ref):
    out = _git("-C", bare, "log", "--format=%s", ref).stdout
    return [line for line in out.splitlines() if line]


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """Two provisioned per-BP bare repos (bpa, bpb) with content on main, and
    a `main` copy holding a checkout of each. Returns helpers + paths."""
    monkeypatch.setattr(git_server, "GIT_REPOS_DIR", str(tmp_path / "git"))
    monkeypatch.setattr(
        git_server, "HOOKS_SRC_DIR", str(tmp_path / "nonexistent-hooks")
    )
    copies_dir = tmp_path / "copies"
    copies_dir.mkdir()
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(copies_dir))
    monkeypatch.delenv("BITSWAN_GIT_REMOTE", raising=False)

    bares = {}

    def seed_bp(bp, rel, text):
        """Create the BP's bare repo and put initial content on its main via
        the same server-side publish the product uses."""
        bare = asyncio.run(git_server.ensure_bp_bare_repo(bp))
        bares[bp] = bare
        seed = tmp_path / f"seed-{bp}"
        _git("clone", "-q", bare, str(seed))
        _commit(str(seed), rel, text, f"seed {bp}")
        asyncio.run(bp_git.publish_main_from_clone(str(seed), bp))
        return bare

    seed_bp("bpa", "file.txt", "a0\n")
    seed_bp("bpb", "file.txt", "b0\n")

    def make_copy(name):
        """Materialize a copy the way create_copy does (per-BP clones on a new
        branch), using the product helper."""
        path = copies_dir / name
        path.mkdir()
        for bp in git_server.list_bp_repos():
            asyncio.run(copies._clone_bp_into_copy(str(path), name, bp))
        return str(path)

    return {
        "bares": bares,
        "copies_dir": str(copies_dir),
        "make_copy": make_copy,
        "tmp_path": tmp_path,
    }


def test_per_bp_sync_touches_only_that_bp(env):
    """A copy with changes in two BPs syncs ONLY the named BP's repo; the other
    BP's repo — and its pending commit — are untouched."""
    copy = env["make_copy"]("u1")
    _commit(os.path.join(copy, "bpa"), "file.txt", "a1\n", "bpa change")
    _commit(os.path.join(copy, "bpb"), "file.txt", "b1\n", "bpb change")

    res = asyncio.run(sync_copy("u1", SyncCopyRequest(deployer="dev@x", bp="bpa")))
    assert res.status == "success"

    bpa_bare, bpb_bare = env["bares"]["bpa"], env["bares"]["bpb"]
    # bpa's main got the change…
    assert "bpa change" in _branch_subjects(bpa_bare, "main")
    assert _git("-C", bpa_bare, "show", "main:file.txt").stdout == "a1\n"
    # …bpb's main did NOT (its commit stays pending in the copy's local clone
    # — it isn't even published to the bare until bpb itself syncs).
    assert "bpb change" not in _branch_subjects(bpb_bare, "main")
    assert _git("-C", bpb_bare, "show", "main:file.txt").stdout == "b0\n"
    bpb_clone_log = _git(
        "log", "--format=%s", cwd=os.path.join(copy, "bpb")
    ).stdout.splitlines()
    assert "bpb change" in bpb_clone_log

    # The main copy checkout was advanced too (drives in_main / live-dev).
    with open(os.path.join(env["copies_dir"], "main", "bpa", "file.txt")) as f:
        assert f.read() == "a1\n"
    # A deploy tag landed on bpa's repo only.
    assert _git("-C", bpa_bare, "tag", "-l", "deploy/*").stdout.strip()
    assert not _git("-C", bpb_bare, "tag", "-l", "deploy/*").stdout.strip()


def test_per_bp_sync_conflict_leaves_main_untouched(env):
    """When the BP's main has advanced divergently, sync returns needs_rebase
    and does NOT touch that repo's main."""
    u1 = env["make_copy"]("u1")
    u2 = env["make_copy"]("u2")
    _commit(os.path.join(u1, "bpa"), "file.txt", "first\n", "u1 bpa")
    _commit(os.path.join(u2, "bpa"), "file.txt", "second\n", "u2 bpa")

    r1 = asyncio.run(sync_copy("u1", SyncCopyRequest(deployer="d@x", bp="bpa")))
    assert r1.status == "success"

    bare = env["bares"]["bpa"]
    main_before = _git("-C", bare, "rev-parse", "main").stdout.strip()

    r2 = asyncio.run(sync_copy("u2", SyncCopyRequest(deployer="d@x", bp="bpa")))

    assert r2.status == "needs_rebase"
    # main untouched by the failed sync.
    assert _git("-C", bare, "rev-parse", "main").stdout.strip() == main_before
    # No temp refs left dangling.
    assert _git("-C", bare, "for-each-ref", "refs/sync-tmp").stdout.strip() == ""
    assert _git("-C", bare, "for-each-ref", "refs/pull-tmp").stdout.strip() == ""


def test_sync_redeploys_synced_bp_dev_stage(env, monkeypatch):
    """A successful per-BP sync redeploys that BP's dev stage from main, so the
    deployed dev stage tracks main (matches live-dev). The deploy task id is
    surfaced on the response."""
    copy = env["make_copy"]("u1")
    _commit(os.path.join(copy, "bpa"), "file.txt", "a1\n", "bpa change")

    calls = []

    async def _fake_dev_deploy(bp, deployer):
        calls.append((bp, deployer))
        return "task-123"

    monkeypatch.setattr(copies, "_spawn_dev_deploy", _fake_dev_deploy)

    res = asyncio.run(sync_copy("u1", SyncCopyRequest(deployer="dev@x", bp="bpa")))
    assert res.status == "success"
    # The synced BP's dev stage was (re)deployed, and only that BP.
    assert calls == [("bpa", "dev@x")]
    assert res.deploy_task_id == "task-123"


def test_sync_noop_still_checks_dev_deploy(env, monkeypatch):
    """Even with nothing to merge (noop), "Sync & Deploy" still asks to bring
    the dev stage up to main — the deployed dev stage may be behind. The
    staleness gate inside _spawn_dev_deploy decides whether it actually
    redeploys; here we assert the noop path no longer silently skips it."""
    env["make_copy"]("u1")  # no commits touching bpa

    calls = []

    async def _fake_dev_deploy(bp, deployer):
        calls.append((bp, deployer))
        return "task-9"

    monkeypatch.setattr(copies, "_spawn_dev_deploy", _fake_dev_deploy)

    res = asyncio.run(sync_copy("u1", SyncCopyRequest(deployer="dev@x", bp="bpa")))
    assert res.status == "success" and res.method == "noop"
    assert calls == [("bpa", "dev@x")]
    assert res.deploy_task_id == "task-9"


def test_bp_divergence_splits_this_bp_from_others(env):
    """Divergence reports THIS BP's clone separately from the copy's other
    clones — so a per-BP screen can say 'this BP is up to date' even when the
    copy as a whole is ahead/behind from other BPs' work."""
    copy = env["make_copy"]("u1")
    _commit(os.path.join(copy, "bpa"), "file.txt", "a1\n", "bpa change")
    _commit(os.path.join(copy, "bpb"), "file.txt", "b1\n", "bpb change")

    d = asyncio.run(get_bp_divergence("u1", bp="bpa"))
    assert d["ahead_bp"] == 1 and d["ahead_other"] == 1
    assert d["behind_bp"] == 0 and d["behind_other"] == 0

    # From bpb's vantage point the roles swap.
    d2 = asyncio.run(get_bp_divergence("u1", bp="bpb"))
    assert d2["ahead_bp"] == 1 and d2["ahead_other"] == 1


def test_whole_copy_sync_fast_forwards_every_bp(env):
    """Without a BP, every BP checked out in the copy syncs independently and
    the response aggregates the per-BP outcomes."""
    copy = env["make_copy"]("u1")
    _commit(os.path.join(copy, "bpa"), "file.txt", "a1\n", "bpa change")
    _commit(os.path.join(copy, "bpb"), "file.txt", "b1\n", "bpb change")

    res = asyncio.run(sync_copy("u1", SyncCopyRequest(deployer="dev@x")))
    assert res.status == "success"
    assert "bpa change" in _branch_subjects(env["bares"]["bpa"], "main")
    assert "bpb change" in _branch_subjects(env["bares"]["bpb"], "main")
    assert {r["bp"] for r in res.bp_results} == {"bpa", "bpb"}
    assert all(r["status"] == "success" for r in res.bp_results)


def test_whole_copy_sync_reports_partial_needs_rebase(env):
    """A conflict in ONE BP doesn't block the others: the clean BP still syncs
    and the response names the BP that needs the coding agent."""
    u1 = env["make_copy"]("u1")
    u2 = env["make_copy"]("u2")
    # u1 advances bpa's main so u2's bpa edit conflicts…
    _commit(os.path.join(u1, "bpa"), "file.txt", "first\n", "u1 bpa")
    assert (
        asyncio.run(sync_copy("u1", SyncCopyRequest(deployer="d@x", bp="bpa"))).status
        == "success"
    )
    # …while u2's bpb edit is clean.
    _commit(os.path.join(u2, "bpa"), "file.txt", "second\n", "u2 bpa")
    _commit(os.path.join(u2, "bpb"), "file.txt", "b1\n", "u2 bpb")

    res = asyncio.run(sync_copy("u2", SyncCopyRequest(deployer="d@x")))
    assert res.status == "needs_rebase"
    assert "bpa" in res.message and "bpb" in res.message
    by_bp = {r["bp"]: r["status"] for r in res.bp_results}
    assert by_bp["bpa"] == "needs_rebase"
    assert by_bp["bpb"] == "success"
    assert "u2 bpb" in _branch_subjects(env["bares"]["bpb"], "main")


def test_copy_created_bp_first_sync_lands_in_main(env):
    """A BP born in a copy (empty-seed repo) fast-forwards into main on its
    first sync, and the main copy gains its checkout (flips in_main)."""
    copy = env["make_copy"]("u1")
    asyncio.run(git_server.ensure_bp_bare_repo("bpc"))
    created = asyncio.run(
        copies._clone_bp_into_copy(copy, "u1", "bpc", allow_empty=True)
    )
    assert created is True
    _commit(os.path.join(copy, "bpc"), "process.toml", "id='c'\n", "scaffold bpc")

    res = asyncio.run(sync_copy("u1", SyncCopyRequest(deployer="d@x", bp="bpc")))
    assert res.status == "success"
    assert asyncio.run(git_server.bp_main_has_content("bpc")) is True
    # The main copy materialized the new BP's checkout.
    main_clone = os.path.join(env["copies_dir"], "main", "bpc")
    assert os.path.isdir(os.path.join(main_clone, ".git"))
    with open(os.path.join(main_clone, "process.toml")) as f:
        assert "c" in f.read()


def test_rebase_pulls_main_into_copy(env):
    """After another copy syncs a BP, a pull rebases this copy's clone onto the
    new main."""
    u1 = env["make_copy"]("u1")
    u2 = env["make_copy"]("u2")
    _commit(os.path.join(u1, "bpa"), "file.txt", "a1\n", "u1 bpa")
    assert (
        asyncio.run(sync_copy("u1", SyncCopyRequest(deployer="d@x", bp="bpa"))).status
        == "success"
    )

    res = asyncio.run(rebase_copy("u2", SyncCopyRequest(deployer="d@x")))
    assert res.status == "success"
    with open(os.path.join(u2, "bpa", "file.txt")) as f:
        assert f.read() == "a1\n"


def test_rebase_materializes_missing_bp_clone(env):
    """A main-carrying BP the copy lacks is materialized by a pull — that's how
    a copy gains a BP created elsewhere."""
    u1 = env["make_copy"]("u1")  # created BEFORE bpc exists

    # bpc is born in u2 and synced to main.
    u2 = env["make_copy"]("u2")
    asyncio.run(git_server.ensure_bp_bare_repo("bpc"))
    asyncio.run(copies._clone_bp_into_copy(u2, "u2", "bpc", allow_empty=True))
    _commit(os.path.join(u2, "bpc"), "process.toml", "id='c'\n", "scaffold bpc")
    assert (
        asyncio.run(sync_copy("u2", SyncCopyRequest(deployer="d@x", bp="bpc"))).status
        == "success"
    )

    assert not os.path.isdir(os.path.join(u1, "bpc"))
    res = asyncio.run(rebase_copy("u1", SyncCopyRequest(deployer="d@x")))
    assert res.status in ("success", "noop")
    clone = os.path.join(u1, "bpc")
    assert os.path.isdir(os.path.join(clone, ".git"))
    branch = _git("rev-parse", "--abbrev-ref", "HEAD", cwd=clone).stdout.strip()
    assert branch == "u1"
    with open(os.path.join(clone, "process.toml")) as f:
        assert "c" in f.read()


def test_divergence_all_reports_missing_bp_as_behind(env):
    """divergence-all flags a main-carrying BP the copy hasn't checked out as
    behind-only, so the UI can show 'pull to get it'."""
    u1 = env["make_copy"]("u1")

    u2 = env["make_copy"]("u2")
    asyncio.run(git_server.ensure_bp_bare_repo("bpc"))
    asyncio.run(copies._clone_bp_into_copy(u2, "u2", "bpc", allow_empty=True))
    _commit(os.path.join(u2, "bpc"), "process.toml", "id='c'\n", "scaffold bpc")
    assert (
        asyncio.run(sync_copy("u2", SyncCopyRequest(deployer="d@x", bp="bpc"))).status
        == "success"
    )

    d = asyncio.run(get_all_bp_divergence("u1"))
    assert "bpc" in d
    assert d["bpc"]["ahead"] == 0 and d["bpc"]["behind"] >= 1
    # In-step BPs don't appear.
    assert "bpa" not in d
    _ = u1  # fixture ordering only


def test_commit_diff_returns_patch(env):
    """The per-commit diff endpoint finds a commit in whichever BP clone knows
    it (and via ?bp= directly)."""
    copy = env["make_copy"]("u1")
    _commit(os.path.join(copy, "bpa"), "file.txt", "a1\n", "bpa change")
    sha = _git("-C", os.path.join(copy, "bpa"), "rev-parse", "HEAD").stdout.strip()

    out = asyncio.run(get_commit_diff("u1", sha))
    diff = out["diff"]
    assert "bpa change" in diff  # commit subject (git show --format=medium)
    assert "file.txt" in diff
    assert "+a1" in diff

    scoped = asyncio.run(get_commit_diff("u1", sha, bp="bpa"))
    assert "bpa change" in scoped["diff"]


def test_commit_diff_rejects_bad_sha(env):
    env["make_copy"]("u1")
    with pytest.raises(Exception):
        asyncio.run(get_commit_diff("u1", "not-a-sha"))
