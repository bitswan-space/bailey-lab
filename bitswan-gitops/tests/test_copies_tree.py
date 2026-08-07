"""Tests for the copy TREE: per-user copies, their experiments, and the
merge-back / discard / sync rules that hold the tree together.

A copy's kind, owner and parent are EXPLICIT metadata (`.copy.json`) — never
inferred from its name — and everything here exercises the real git mechanics
(per-BP temp bare repos + a temp copies dir), as test_copies_sync.py does, so
the branch/ref/rebase behavior is genuine rather than mocked.
"""

import asyncio
import json
import os
import subprocess

import pytest
from fastapi import HTTPException

from app.routes import copies
from app.routes.copies import (
    COPY_META_FILE,
    CreateCopyRequest,
    SyncCopyRequest,
    delete_copy_route,
    ensure_bp_in_copy,
    get_merge_to_parent_preview,
    merge_copy_to_parent,
    sync_copy,
)
from app.services import bp_delete, bp_git, git_server
from app.task_queue import current_requester

OWNER = "alice@x"
OTHER = "mallory@x"


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


def _write(clone, rel, text):
    """An uncommitted working-tree edit — how the dashboard writes files."""
    path = os.path.join(clone, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def _read(path):
    with open(path) as f:
        return f.read()


def _head(clone_or_bare, ref="HEAD"):
    if os.path.isdir(os.path.join(clone_or_bare, ".git")):
        return _git("rev-parse", ref, cwd=clone_or_bare).stdout.strip()
    return _git("-C", clone_or_bare, "rev-parse", ref).stdout.strip()


def _as(email, make_coro):
    """Run a route as a gate-verified requester (the contextvar the ASGI
    middleware sets from X-Forwarded-Email)."""
    token = current_requester.set(email)
    try:
        return asyncio.run(make_coro())
    finally:
        current_requester.reset(token)


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """Two per-BP bare repos (bpa, bpb) with content on main, plus helpers that
    create copies/experiments through the REAL create route (so metadata,
    parent WIP publishing and branch bases are exercised)."""
    monkeypatch.setattr(git_server, "GIT_REPOS_DIR", str(tmp_path / "git"))
    monkeypatch.setattr(
        git_server, "HOOKS_SRC_DIR", str(tmp_path / "nonexistent-hooks")
    )
    copies_dir = tmp_path / "copies"
    copies_dir.mkdir()
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(copies_dir))
    monkeypatch.delenv("BITSWAN_GIT_REMOTE", raising=False)

    # Copy creation auto-starts live-dev; that's out of scope here.
    async def _no_deploy(**kwargs):
        return {}

    monkeypatch.setattr(copies, "spawn_set_deploy", _no_deploy)

    bares = {}

    def seed_bp(bp, rel, text):
        bare = asyncio.run(git_server.ensure_bp_bare_repo(bp))
        bares[bp] = bare
        seed = tmp_path / f"seed-{bp}"
        _git("clone", "-q", bare, str(seed))
        _commit(str(seed), rel, text, f"seed {bp}")
        asyncio.run(bp_git.publish_main_from_clone(str(seed), bp))
        return bare

    seed_bp("bpa", "file.txt", "a0\n")
    seed_bp("bpb", "file.txt", "b0\n")

    def user_copy(name, owner=OWNER):
        _as(
            owner,
            lambda: copies.create_copy(
                CreateCopyRequest(branch_name=name, kind="user", owner=owner)
            ),
        )
        return str(copies_dir / name)

    def experiment(name, parent, owner=OWNER, title="Try new pricing", bps=None):
        """`bps` defaults to everything the parent carries, so tests that
        exercise merge mechanics get real clones. Production passes just the
        business process the user is on; pass `bps=[]` to exercise that."""
        if bps is None:
            bps = bp_git.list_bp_clones(str(copies_dir / parent))
        _as(
            owner,
            lambda: copies.create_copy(
                CreateCopyRequest(
                    branch_name=name,
                    kind="experiment",
                    parent=parent,
                    owner=owner,
                    title=title,
                    bps=bps,
                )
            ),
        )
        return str(copies_dir / name)

    return {
        "bares": bares,
        "copies_dir": str(copies_dir),
        "tmp_path": tmp_path,
        "user_copy": user_copy,
        "experiment": experiment,
    }


# ── create ──────────────────────────────────────────────────────────────────


def test_experiment_branches_from_parent_tip_including_uncommitted_work(env):
    """An experiment starts from what its parent looks like RIGHT NOW: the
    parent's uncommitted edits are committed and published first, so the new
    branch carries them."""
    alice = env["user_copy"]("alice")
    _commit(os.path.join(alice, "bpa"), "file.txt", "alice-committed\n", "alice work")
    _write(os.path.join(alice, "bpa"), "wip.txt", "alice-wip\n")  # never committed

    exp = env["experiment"]("exp-pricing-ab12", "alice")

    assert _read(os.path.join(exp, "bpa", "file.txt")) == "alice-committed\n"
    assert _read(os.path.join(exp, "bpa", "wip.txt")) == "alice-wip\n"
    # The parent's WIP became a real commit on the parent's branch, in the bare.
    bare = env["bares"]["bpa"]
    assert _head(bare, "refs/heads/alice") == _head(os.path.join(alice, "bpa"))
    assert _head(bare, "refs/heads/exp-pricing-ab12") == _head(bare, "refs/heads/alice")
    # …and main is untouched by any of it.
    assert _git("-C", bare, "show", "main:file.txt").stdout == "a0\n"


def test_experiment_writes_metadata_sidecar(env):
    env["user_copy"]("alice")
    exp = env["experiment"]("exp-pricing-ab12", "alice", title="Try new pricing")

    meta = json.loads(_read(os.path.join(exp, COPY_META_FILE)))
    assert meta["version"] == 1
    assert meta["kind"] == "experiment"
    assert meta["owner"] == OWNER
    assert meta["parent"] == "alice"
    assert meta["title"] == "Try new pricing"
    assert meta["created_at"]
    # The sidecar is a dot-file: invisible to the BP scan.
    assert "bpa" in bp_git.list_bp_clones(exp)
    assert COPY_META_FILE not in bp_git.list_bp_clones(exp)


def test_experiment_creation_does_not_auto_deploy_live_dev(env, monkeypatch):
    """A person's copy is their whole working environment, so everything in it
    comes up. An experiment is a side branch off ONE business process: bringing
    up a live-dev for every BP would run containers nobody asked for (and tear
    them all down again on discard). The BP the user opens is woken lazily."""
    spawned = []

    async def _record(**kwargs):
        spawned.append(kwargs["label"])
        return {}

    monkeypatch.setattr(copies, "spawn_set_deploy", _record)

    env["user_copy"]("alice")
    assert spawned == ["copy:alice"]

    env["experiment"]("exp-pricing-ab12", "alice")
    assert spawned == ["copy:alice"]


def test_nested_experiment_is_rejected(env):
    """The tree is single-level: an experiment can't parent an experiment."""
    env["user_copy"]("alice")
    env["experiment"]("exp-one-ab12", "alice")

    with pytest.raises(HTTPException) as ei:
        env["experiment"]("exp-two-cd34", "exp-one-ab12")
    assert ei.value.status_code == 400
    assert "experiment" in ei.value.detail
    assert not os.path.exists(os.path.join(env["copies_dir"], "exp-two-cd34"))


def test_experiment_without_existing_parent_is_rejected(env):
    with pytest.raises(HTTPException) as ei:
        env["experiment"]("exp-orphan-ab12", "nobody")
    assert 400 <= ei.value.status_code < 500

    with pytest.raises(HTTPException) as ei2:
        _as(
            OWNER,
            lambda: copies.create_copy(
                CreateCopyRequest(
                    branch_name="exp-noparent-ab12", kind="experiment", owner=OWNER
                )
            ),
        )
    assert 400 <= ei2.value.status_code < 500


def test_copy_name_with_deployment_separator_is_rejected(env):
    """`-copy-` inside a copy name would make deployment ids ambiguous."""
    with pytest.raises(HTTPException) as ei:
        _as(
            OWNER,
            lambda: copies.create_copy(
                CreateCopyRequest(
                    branch_name="exp-copy-thing", kind="user", owner=OWNER
                )
            ),
        )
    assert ei.value.status_code == 400
    assert "-copy-" in ei.value.detail


def test_over_long_copy_name_is_rejected(env):
    """Copy names must leave room for `copy_<name>_bp_<bp>` under the 63-char
    truncation in bp_databases.copy_bp_resource_names."""
    with pytest.raises(HTTPException) as ei:
        _as(
            OWNER,
            lambda: copies.create_copy(
                CreateCopyRequest(branch_name="e" * 60, kind="user", owner=OWNER)
            ),
        )
    assert ei.value.status_code == 400
    assert "characters" in ei.value.detail


def test_email_slug_length_copy_name_is_accepted(env):
    """Regression: real user copies are named from email slugs and routinely
    run ~30 chars (e.g. `timothy-hobbs-libertyaces-com`). A speculative
    future-BP reserve in the length budget once rejected every one of them,
    silently breaking /api/me's copy auto-create — the budget must be
    measured against the BPs that actually exist."""
    name = "petra-ownerova-timssandbox2-bswn-io"  # 35 chars, like a long email slug
    result = _as(
        OWNER,
        lambda: copies.create_copy(
            CreateCopyRequest(branch_name=name, kind="user", owner=OWNER)
        ),
    )
    assert result["name"] == name


def test_copy_wire_state_carries_kind_owner_parent(env):
    """The snapshot the dashboard consumes carries the tree fields."""
    env["user_copy"]("alice")
    exp = env["experiment"]("exp-pricing-ab12", "alice", title="Try new pricing")
    _commit(os.path.join(exp, "bpa"), "file.txt", "exp\n", "exp work")

    listing = {c["name"]: c for c in asyncio.run(copies.refresh_copies())}

    alice_state = listing["alice"]
    assert alice_state["kind"] == "user"
    assert alice_state["owner"] == OWNER
    assert alice_state["parent"] is None

    exp_state = listing["exp-pricing-ab12"]
    assert exp_state["kind"] == "experiment"
    assert exp_state["owner"] == OWNER
    assert exp_state["parent"] == "alice"
    assert exp_state["title"] == "Try new pricing"


def test_copy_listing_carries_no_divergence_and_runs_no_git(env, monkeypatch):
    """The listing is filesystem metadata ONLY.

    Every divergence figure used to be computed here for every copy AND every
    business process inside it — a `git fetch` per pair, re-run on every git
    event, which took over a minute on a real workspace and made the counter it
    fed stale for exactly as long. The UI asks about one copy at a time, so
    those questions moved to on-demand endpoints. This test is the guard: if
    anything reintroduces per-copy git work in the scan, it fails.
    """
    env["user_copy"]("alice")
    exp = env["experiment"]("exp-pricing-ab12", "alice", title="Try new pricing")
    _commit(os.path.join(exp, "bpa"), "file.txt", "exp\n", "exp work")

    def _no_git(*args, **kwargs):
        raise AssertionError(f"the copy listing must run no git commands: {args}")

    monkeypatch.setattr(copies, "call_git_command", _no_git)
    monkeypatch.setattr(copies, "call_git_command_with_output", _no_git)

    listing = asyncio.run(copies.refresh_copies())

    assert listing, "expected the copies to be listed"
    for state in listing:
        for absent in (
            "ahead",
            "behind",
            "synced",
            "has_changes",
            "commit_hash",
            "commit_message",
            "parent_ahead",
            "parent_behind",
        ):
            assert (
                absent not in state
            ), f"{state['name']} still carries {absent!r} in the listing"


def test_experiment_clones_only_the_business_processes_asked_for(env):
    """Starting an experiment is O(1) in the workspace's business processes.

    It used to clone EVERY business process from the parent — a full git clone
    and working tree each — plus a WIP commit and push per BP to publish the
    parent's tip. On a 20-BP workspace that took over two minutes for work the
    user never asked for; an experiment is a side branch off the one business
    process being tried out.
    """
    alice = env["user_copy"]("alice")
    _write(os.path.join(alice, "bpa"), "wip.txt", "alice-wip\n")
    # Uncommitted work in a business process the experiment is NOT about.
    _write(os.path.join(alice, "bpb"), "wip.txt", "untouched\n")
    bare_b = env["bares"]["bpb"]
    bpb_before = _head(bare_b, "refs/heads/alice")

    exp = env["experiment"]("exp-pricing-ab12", "alice", bps=["bpa"])

    assert bp_git.list_bp_clones(exp) == ["bpa"], "only the asked-for BP is cloned"
    # …and it still starts from the parent's CURRENT state, uncommitted work
    # included, which is the whole point of publishing the tip first.
    assert _read(os.path.join(exp, "bpa", "wip.txt")) == "alice-wip\n"
    # The parent's OTHER business process was left alone: no WIP commit, no push,
    # and its branch in the bare did not move.
    assert _head(bare_b, "refs/heads/alice") == bpb_before
    assert (
        _git(
            "-C",
            bare_b,
            "rev-parse",
            "--verify",
            "--quiet",
            "refs/heads/exp-pricing-ab12",
            check=False,
        ).returncode
        != 0
    ), "a skipped business process gets no experiment branch until it is opened"


def test_a_bp_name_used_only_inside_a_copy_is_still_taken(env):
    """Business-process names are workspace-wide: one repo per process.

    The create guard used to ask only whether MAIN carried content, so a
    business process created inside someone's copy or experiment — and not yet
    deployed to main — left its name apparently free. A second person creating
    that name would land two unrelated histories in the same repo.
    """
    from app.services.git_server import bp_main_has_content, bp_name_is_taken

    alice = env["user_copy"]("alice")

    # A brand-new repo with nothing in it: the leftover of a failed attempt,
    # which creation deliberately reuses. Not taken.
    asyncio.run(git_server.ensure_bp_bare_repo("bpfresh"))
    assert asyncio.run(bp_name_is_taken("bpfresh")) is False

    # A business process that exists ONLY on a copy's branch.
    asyncio.run(copies._clone_bp_into_copy(alice, "alice", "bpfresh", allow_empty=True))
    _commit(os.path.join(alice, "bpfresh"), "process.toml", "id='f'\n", "scaffold")
    asyncio.run(
        copies.call_git_command(
            "git",
            "push",
            git_server.bp_bare_repo_path("bpfresh"),
            "HEAD:refs/heads/alice",
            cwd=os.path.join(alice, "bpfresh"),
        )
    )

    assert (
        asyncio.run(bp_main_has_content("bpfresh")) is False
    ), "precondition: nothing on main"
    assert (
        asyncio.run(bp_name_is_taken("bpfresh")) is True
    ), "a name living only on a copy branch must still be taken"


def test_name_budget_is_published_and_matches_what_create_enforces(env):
    """The copy-name length limit is workspace-dependent, so it is published.

    It is derived from the LONGEST business-process slug (the limit really comes
    from `copy_<name>_bp_<bp>` being truncated at 63 chars), so it shrinks when
    someone creates a long-named business process. The dashboard generates
    experiment names from titles and used to carry its own hard-coded 40 — right
    on workspaces with short business-process names, wrong on others, where
    "Start a new experiment" then 400ed. Whoever generates a name must read the
    budget from here, so the two can never disagree.
    """
    published = asyncio.run(copies.get_copy_name_budget())["max_length"]
    assert isinstance(published, int)

    # A name exactly at the budget is accepted; one character more is not.
    at_budget = ("e" * published)[:published]
    _as(
        OWNER,
        lambda: copies.create_copy(
            CreateCopyRequest(branch_name=at_budget, kind="user", owner=OWNER)
        ),
    )

    with pytest.raises(HTTPException) as ei:
        _as(
            OWNER,
            lambda: copies.create_copy(
                CreateCopyRequest(
                    branch_name="e" * (published + 1), kind="user", owner=OWNER
                )
            ),
        )
    assert ei.value.status_code == 400
    assert str(published) in ei.value.detail

    # A longer business-process name shrinks the budget — which is exactly why
    # nobody may hard-code it.
    asyncio.run(git_server.ensure_bp_bare_repo("a-very-long-business-process-name"))
    shrunk = asyncio.run(copies.get_copy_name_budget())["max_length"]
    assert shrunk < published


def test_experiment_defaults_to_cloning_nothing(env):
    """No `bps` means nothing is materialised up front; the business process the
    user opens is materialised then, from the parent."""
    env["user_copy"]("alice")
    exp = env["experiment"]("exp-pricing-ab12", "alice", bps=[])
    assert bp_git.list_bp_clones(exp) == []


def test_opening_a_bp_in_an_experiment_takes_the_parents_current_state(env):
    """The lazy path must give the same starting point the eager one did —
    including the parent's uncommitted edits."""
    alice = env["user_copy"]("alice")
    _commit(os.path.join(alice, "bpb"), "file.txt", "alice-committed\n", "alice work")
    _write(os.path.join(alice, "bpb"), "wip.txt", "alice-wip\n")

    exp = env["experiment"]("exp-pricing-ab12", "alice", bps=["bpa"])
    assert "bpb" not in bp_git.list_bp_clones(exp)

    res = _as(OWNER, lambda: ensure_bp_in_copy("exp-pricing-ab12", "bpb"))
    assert res["already"] is False
    assert _read(os.path.join(exp, "bpb", "file.txt")) == "alice-committed\n"
    assert _read(os.path.join(exp, "bpb", "wip.txt")) == "alice-wip\n"


def test_experiment_on_a_bp_the_parent_lacks_is_rejected(env):
    """Fail loudly rather than silently branching off main: an experiment's
    world is its parent's."""
    env["user_copy"]("alice")
    asyncio.run(git_server.ensure_bp_bare_repo("bpz"))

    with pytest.raises(HTTPException) as ei:
        env["experiment"]("exp-pricing-ab12", "alice", bps=["bpz"])
    assert ei.value.status_code == 400
    assert "bpz" in ei.value.detail
    assert "alice" in ei.value.detail
    # Nothing was cloned into the rejected experiment. (The directory itself is
    # torn down by `_rm_rf_as_root_in_container`, which needs a real container
    # and so no-ops here.)
    assert (
        bp_git.list_bp_clones(os.path.join(env["copies_dir"], "exp-pricing-ab12")) == []
    )


def test_behind_endpoint_reports_only_what_main_carries(env, tmp_path):
    """`/{name}/behind` is the on-demand answer that gates the Sync step.

    It replaced the `behind` figure the listing used to precompute for every
    copy, so it has to be right for the two cases the UI turns on: nothing to
    pull, and main moving ahead in one business process.
    """
    alice = env["user_copy"]("alice")

    fresh = asyncio.run(copies.get_copy_behind("alice"))
    assert fresh == {
        "behind": 0,
        "bps": {},
    }, "a copy just made from main is not behind it"

    # Someone else publishes two commits to bpa's main.
    other = tmp_path / "other-clone"
    _git("clone", "-q", git_server.bp_bare_repo_path("bpa"), str(other))
    _commit(str(other), "file.txt", "a1\n", "main moves")
    _commit(str(other), "file.txt", "a2\n", "main moves again")
    asyncio.run(bp_git.publish_main_from_clone(str(other), "bpa"))

    after = asyncio.run(copies.get_copy_behind("alice"))
    assert after == {
        "behind": 2,
        "bps": {"bpa": 2},
    }, "only the business process whose main moved is behind"

    # Work of our own does not make us behind — that is `ahead`.
    _commit(os.path.join(alice, "bpb"), "mine.txt", "mine\n", "my work")
    assert asyncio.run(copies.get_copy_behind("alice"))["bps"] == {"bpa": 2}


def test_ensure_bp_in_experiment_materializes_from_the_parent(env):
    """Inside an experiment, a BP is materialized from the PARENT's branch —
    the experiment's world is its parent's, not main's."""
    alice = env["user_copy"]("alice")
    exp = env["experiment"]("exp-pricing-ab12", "alice")

    # A BP the experiment does not carry, whose parent branch has work that
    # never reached main.
    asyncio.run(git_server.ensure_bp_bare_repo("bpc"))
    asyncio.run(copies._clone_bp_into_copy(alice, "alice", "bpc", allow_empty=True))
    _commit(os.path.join(alice, "bpc"), "process.toml", "id='parent'\n", "alice bpc")
    _git(
        "push",
        "-q",
        env_bare(env, "bpc"),
        "HEAD:refs/heads/alice",
        cwd=os.path.join(alice, "bpc"),
    )

    res = asyncio.run(ensure_bp_in_copy("exp-pricing-ab12", "bpc"))
    assert res["already"] is False
    clone = os.path.join(exp, "bpc")
    assert "parent" in _read(os.path.join(clone, "process.toml"))
    assert (
        _git("rev-parse", "--abbrev-ref", "HEAD", cwd=clone).stdout.strip()
        == "exp-pricing-ab12"
    )


def env_bare(env, bp):
    return git_server.bp_bare_repo_path(bp)


# ── merge back into the parent ──────────────────────────────────────────────


def test_merge_to_parent_fast_forwards_parent_and_leaves_main_alone(env):
    alice = env["user_copy"]("alice")
    exp = env["experiment"]("exp-pricing-ab12", "alice")
    _commit(os.path.join(exp, "bpa"), "file.txt", "exp1\n", "exp bpa")

    bare = env["bares"]["bpa"]
    main_before = _head(bare, "refs/heads/main")

    res = _as(OWNER, lambda: merge_copy_to_parent("exp-pricing-ab12"))

    assert res.status == "success"
    assert _read(os.path.join(alice, "bpa", "file.txt")) == "exp1\n"
    # Parent clone AND the parent's branch in the bare advanced to the exp tip.
    assert _head(os.path.join(alice, "bpa")) == _head(bare, "refs/heads/alice")
    assert _head(bare, "refs/heads/alice") == _head(bare, "refs/heads/exp-pricing-ab12")
    # main is untouched and got no deploy tag: this is copy → copy.
    assert _head(bare, "refs/heads/main") == main_before
    assert not _git("-C", bare, "tag", "-l", "deploy/*").stdout.strip()
    by_bp = {r["bp"]: r["status"] for r in res.bp_results}
    assert by_bp["bpa"] == "success" and by_bp["bpb"] == "noop"


def test_merge_to_parent_rebases_when_the_parent_moved_on(env):
    """Divergent but non-conflicting: the EXPERIMENT is replayed on top of the
    parent, then merged fast-forward — the parent's history is never rewritten."""
    alice = env["user_copy"]("alice")
    exp = env["experiment"]("exp-pricing-ab12", "alice")
    _commit(os.path.join(exp, "bpa"), "exp.txt", "from-exp\n", "exp bpa")
    _commit(os.path.join(alice, "bpa"), "parent.txt", "from-parent\n", "alice bpa")
    parent_commit = _head(os.path.join(alice, "bpa"))

    res = _as(OWNER, lambda: merge_copy_to_parent("exp-pricing-ab12"))

    assert res.status == "success"
    alice_bpa = os.path.join(alice, "bpa")
    assert _read(os.path.join(alice_bpa, "exp.txt")) == "from-exp\n"
    assert _read(os.path.join(alice_bpa, "parent.txt")) == "from-parent\n"
    # The parent's own commit is still an ancestor (fast-forward, no rewrite).
    assert (
        _git(
            "merge-base",
            "--is-ancestor",
            parent_commit,
            "HEAD",
            cwd=alice_bpa,
            check=False,
        ).returncode
        == 0
    )


def test_merge_to_parent_conflict_leaves_the_parent_untouched(env):
    """A conflict aborts on the EXPERIMENT's side; the parent is byte-identical
    and the caller gets needs_rebase to hand off to the coding agent."""
    alice = env["user_copy"]("alice")
    exp = env["experiment"]("exp-pricing-ab12", "alice")
    _commit(os.path.join(exp, "bpa"), "file.txt", "exp-version\n", "exp bpa")
    _commit(os.path.join(alice, "bpa"), "file.txt", "parent-version\n", "alice bpa")

    alice_bpa = os.path.join(alice, "bpa")
    parent_head = _head(alice_bpa)
    bare = env["bares"]["bpa"]
    parent_branch = _head(bare, "refs/heads/alice")

    res = _as(OWNER, lambda: merge_copy_to_parent("exp-pricing-ab12"))

    assert res.status == "needs_rebase"
    assert _read(os.path.join(alice_bpa, "file.txt")) == "parent-version\n"
    assert _head(alice_bpa) == parent_head
    # Only the parent's own (already committed) work was published — the merge
    # itself moved nothing, and the experiment's tip never entered the parent.
    assert _head(bare, "refs/heads/alice") == parent_head
    assert parent_branch != parent_head  # the parent's own commit did get pushed
    exp_tip = _head(bare, "refs/heads/exp-pricing-ab12")
    assert (
        _git(
            "-C", bare, "merge-base", "--is-ancestor", exp_tip, parent_head, check=False
        ).returncode
        != 0
    )
    # The experiment survived intact: its clone is not mid-rebase.
    assert not os.path.exists(os.path.join(exp, "bpa", ".git", "rebase-merge"))
    assert _read(os.path.join(exp, "bpa", "file.txt")) == "exp-version\n"


def test_merge_to_parent_noop_when_nothing_changed(env):
    env["user_copy"]("alice")
    env["experiment"]("exp-pricing-ab12", "alice")

    res = _as(OWNER, lambda: merge_copy_to_parent("exp-pricing-ab12"))
    assert res.status == "noop"
    assert all(r["status"] == "noop" for r in res.bp_results)


def test_merge_publishes_a_bp_that_exists_only_in_the_experiment(env):
    alice = env["user_copy"]("alice")
    exp = env["experiment"]("exp-pricing-ab12", "alice")
    asyncio.run(git_server.ensure_bp_bare_repo("bpc"))
    asyncio.run(
        copies._clone_bp_into_copy(exp, "exp-pricing-ab12", "bpc", allow_empty=True)
    )
    _commit(os.path.join(exp, "bpc"), "process.toml", "id='c'\n", "scaffold bpc")

    res = _as(OWNER, lambda: merge_copy_to_parent("exp-pricing-ab12"))
    assert res.status == "success"

    parent_clone = os.path.join(alice, "bpc")
    assert os.path.isdir(os.path.join(parent_clone, ".git"))
    assert "id='c'" in _read(os.path.join(parent_clone, "process.toml"))
    assert (
        _git("rev-parse", "--abbrev-ref", "HEAD", cwd=parent_clone).stdout.strip()
        == "alice"
    )
    bare = git_server.bp_bare_repo_path("bpc")
    assert _head(bare, "refs/heads/alice") == _head(bare, "refs/heads/exp-pricing-ab12")
    # bpc never reached main.
    assert asyncio.run(git_server.bp_main_has_content("bpc")) is False


def test_merge_preview_is_quiet_once_the_work_is_in_the_parent(env):
    """The banner's "is there anything to merge" signal is measured against the
    PARENT, never main: an experiment inherits its parent's whole divergence
    from main, so a main-based signal never goes quiet and the merge button
    stays lit on an already-merged experiment (every press a noop)."""
    alice = env["user_copy"]("alice")
    # The parent itself is ahead of main — the divergence an experiment inherits.
    _commit(os.path.join(alice, "bpa"), "file.txt", "alice-1\n", "alice work")
    exp = env["experiment"]("exp-pricing-ab12", "alice")

    assert _as(OWNER, lambda: get_merge_to_parent_preview("exp-pricing-ab12")) == {
        "parent": "alice",
        "ahead": 0,
        "behind": 0,
        "uncommitted": [],
        "new_bps": [],
    }

    # An uncommitted edit IS something to merge (the merge commits it first).
    _write(os.path.join(exp, "bpa"), "file.txt", "exp-edit\n")
    pre = _as(OWNER, lambda: get_merge_to_parent_preview("exp-pricing-ab12"))
    assert pre["uncommitted"] == ["bpa/file.txt"]

    # …and once merged, it is quiet again.
    assert _as(OWNER, lambda: merge_copy_to_parent("exp-pricing-ab12")).status == (
        "success"
    )
    post = _as(OWNER, lambda: get_merge_to_parent_preview("exp-pricing-ab12"))
    assert (post["ahead"], post["uncommitted"], post["new_bps"]) == (0, [], [])


def test_merge_preview_counts_commits_and_bps_the_parent_lacks(env):
    alice = env["user_copy"]("alice")
    exp = env["experiment"]("exp-pricing-ab12", "alice")
    _commit(os.path.join(exp, "bpa"), "file.txt", "exp-1\n", "exp work")
    # A BP born inside the experiment: the merge publishes it wholesale.
    asyncio.run(git_server.ensure_bp_bare_repo("bpc"))
    asyncio.run(
        copies._clone_bp_into_copy(exp, "exp-pricing-ab12", "bpc", allow_empty=True)
    )
    _commit(os.path.join(exp, "bpc"), "process.toml", "id='c'\n", "scaffold bpc")
    # The parent moved on too — that's `behind`, not something to merge.
    _commit(os.path.join(alice, "bpb"), "file.txt", "alice-b\n", "alice work")
    asyncio.run(copies._publish_copy_bp_tip(alice, "alice", "bpb", OWNER))

    pre = _as(OWNER, lambda: get_merge_to_parent_preview("exp-pricing-ab12"))
    assert pre["ahead"] == 1
    assert pre["behind"] == 1
    assert pre["new_bps"] == ["bpc"]


def test_merge_preview_rejects_a_non_experiment(env):
    env["user_copy"]("alice")
    with pytest.raises(HTTPException) as ei:
        _as(OWNER, lambda: get_merge_to_parent_preview("alice"))
    assert ei.value.status_code == 400


def test_merge_to_parent_rejects_a_non_experiment(env):
    env["user_copy"]("alice")
    with pytest.raises(HTTPException) as ei:
        _as(OWNER, lambda: merge_copy_to_parent("alice"))
    assert ei.value.status_code == 400
    assert ei.value.detail == "Only experiments can be merged into a parent copy"


def test_merge_to_parent_rejects_a_non_owner(env):
    env["user_copy"]("alice")
    env["experiment"]("exp-pricing-ab12", "alice")
    with pytest.raises(HTTPException) as ei:
        _as(OTHER, lambda: merge_copy_to_parent("exp-pricing-ab12"))
    assert ei.value.status_code == 403


# ── sync guard ──────────────────────────────────────────────────────────────


def test_experiments_cannot_sync_to_main(env):
    env["user_copy"]("alice")
    exp = env["experiment"]("exp-pricing-ab12", "alice")
    _commit(os.path.join(exp, "bpa"), "file.txt", "exp\n", "exp bpa")

    with pytest.raises(HTTPException) as ei:
        _as(
            OWNER,
            lambda: sync_copy("exp-pricing-ab12", SyncCopyRequest(deployer=OWNER)),
        )
    assert ei.value.status_code == 400
    assert ei.value.detail == "Experiments merge back into their parent copy"
    # main really is untouched.
    assert _git("-C", env["bares"]["bpa"], "show", "main:file.txt").stdout == "a0\n"


# ── discard (DELETE) guards ─────────────────────────────────────────────────


@pytest.fixture()
def delete_env(env, tmp_path, monkeypatch):
    """The delete route's collaborators, stubbed down to the guards: a service
    with an empty bitswan.yaml and a recorded teardown."""
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))

    class _Svc:
        gitops_dir = str(tmp_path)
        workspace_name = "ws"

    import app.dependencies as deps

    monkeypatch.setattr(deps, "get_automation_service", lambda: _Svc())

    calls: list[tuple] = []

    async def _fake_delete(name, deleted_by, service):
        calls.append((name, deleted_by))
        return {"status": "success", "results": {}}

    monkeypatch.setattr(bp_delete, "delete_copy", _fake_delete)
    return calls


def test_delete_refuses_a_user_copy(env, delete_env):
    env["user_copy"]("alice")
    with pytest.raises(HTTPException) as ei:
        _as(OWNER, lambda: delete_copy_route("alice"))
    assert ei.value.status_code == 400
    assert ei.value.detail == "Only experiments can be deleted"
    assert delete_env == []


def test_delete_refuses_a_legacy_copy_without_metadata(env, delete_env):
    """A copy created before the tree existed carries no metadata — undeletable
    through the API (operator surface only)."""
    path = os.path.join(env["copies_dir"], "legacy")
    _as(
        None,
        lambda: copies.create_copy(CreateCopyRequest(branch_name="legacy")),
    )
    assert not os.path.exists(os.path.join(path, COPY_META_FILE))
    with pytest.raises(HTTPException) as ei:
        _as(OWNER, lambda: delete_copy_route("legacy"))
    assert ei.value.status_code == 400
    assert delete_env == []


def test_delete_refuses_a_non_owner(env, delete_env):
    env["user_copy"]("alice")
    env["experiment"]("exp-pricing-ab12", "alice")
    with pytest.raises(HTTPException) as ei:
        _as(OTHER, lambda: delete_copy_route("exp-pricing-ab12"))
    assert ei.value.status_code == 403
    assert delete_env == []


def test_delete_of_own_experiment_passes_the_guards(env, delete_env):
    env["user_copy"]("alice")
    env["experiment"]("exp-pricing-ab12", "alice")

    res = _as(OWNER, lambda: delete_copy_route("exp-pricing-ab12"))
    assert res["status"] == "pending" and res["task_id"]
    assert res["copy"] == "exp-pricing-ab12"


def test_delete_404s_when_nothing_remains(env, delete_env):
    with pytest.raises(HTTPException) as ei:
        _as(OWNER, lambda: delete_copy_route("exp-ghost-ab12"))
    assert ei.value.status_code == 404


def test_experiment_can_start_from_a_parent_whose_history_was_rebased(env):
    """Pulling main into a copy REBASES it, rewriting its history — so the copy
    clone stops being a fast-forward of the branch the bare still holds. A plain
    push then fails non-fast-forward, and starting an experiment broke on
    exactly the copies that had most recently pulled (live-seen). The copy owns
    its own branch, so publishing must move the ref rather than fast-forward it.
    """
    alice = env["user_copy"]("alice")
    clone = os.path.join(alice, "bpa")
    _commit(clone, "file.txt", "alice-1\n", "alice work")
    # Publish once so the bare carries this history…
    asyncio.run(copies._publish_copy_bp_tip(alice, "alice", "bpa", OWNER))
    published = _head(env["bares"]["bpa"], "refs/heads/alice")
    # …then rewrite it, exactly as a pull-from-main rebase does.
    _git("reset", "--hard", "HEAD~1", cwd=clone)
    _commit(clone, "file.txt", "alice-rebased\n", "alice work, rebased onto main")
    rewritten = _head(clone)
    assert rewritten != published

    exp = env["experiment"]("exp-after-rebase-ab12", "alice")

    # The bare followed the rewrite, and the experiment branched from it.
    assert _head(env["bares"]["bpa"], "refs/heads/alice") == rewritten
    assert _read(os.path.join(exp, "bpa", "file.txt")) == "alice-rebased\n"
    # No temp ref left behind.
    refs = _git("-C", env["bares"]["bpa"], "for-each-ref", "--format=%(refname)").stdout
    assert "publish-tmp" not in refs
