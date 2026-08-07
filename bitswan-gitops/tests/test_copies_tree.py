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
        """An experiment is started ON one business process and carries only
        that one, so `bps` defaults to a single element — the same shape the
        dashboard sends. Pass an explicit list to exercise the rejections
        (none, or more than one)."""
        if bps is None:
            bps = ["bpa"]
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
        # Seeding a business process AFTER a copy exists is how that copy comes
        # to lack one — the case where a pull materialises it.
        "seed_bp": seed_bp,
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
    # WHICH business process the experiment is about is recorded EXPLICITLY —
    # every later guard reads it from here rather than looking at what the
    # directory happens to contain.
    assert meta["bp"] == "bpa"
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
    # The business process the experiment is on — the dashboard lists
    # experiments under it, and shows nothing under any other.
    assert exp_state["bp"] == "bpa"
    assert "bp_legacy" not in exp_state
    # A person's copy is workspace-wide, so it has no single business process.
    assert "bp" not in alice_state


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


def test_experiment_without_a_business_process_is_rejected(env):
    """An experiment is a side branch of ONE business process, so which one is
    not optional: without it the create would make a real but EMPTY copy the
    user can do nothing in, and the failure would surface as whatever they
    tried next."""
    env["user_copy"]("alice")
    with pytest.raises(HTTPException) as ei:
        env["experiment"]("exp-pricing-ab12", "alice", bps=[])
    assert ei.value.status_code == 400
    assert "exactly one" in ei.value.detail
    assert (
        bp_git.list_bp_clones(os.path.join(env["copies_dir"], "exp-pricing-ab12")) == []
    )


def test_experiment_on_more_than_one_business_process_is_rejected(env):
    """Each business process is its own repository. An "experiment" spanning
    two is two unrelated branches merged back and discarded together — which is
    the workspace-wide copy this rule exists to stop. Reject rather than
    silently keeping the first."""
    env["user_copy"]("alice")
    with pytest.raises(HTTPException) as ei:
        env["experiment"]("exp-pricing-ab12", "alice", bps=["bpa", "bpb"])
    assert ei.value.status_code == 400
    assert "exactly one business process" in ei.value.detail
    assert "bpa, bpb" in ei.value.detail


def test_experiment_records_only_its_own_business_process(env):
    """The experiment carries exactly the one process it was started on — not
    the parent's whole world."""
    alice = env["user_copy"]("alice")
    assert set(bp_git.list_bp_clones(alice)) == {"bpa", "bpb"}
    exp = env["experiment"]("exp-pricing-ab12", "alice", bps=["bpb"])
    assert bp_git.list_bp_clones(exp) == ["bpb"]
    assert json.loads(_read(os.path.join(exp, COPY_META_FILE)))["bp"] == "bpb"


def test_an_experiment_refuses_a_business_process_that_is_not_its_own(env):
    """THE rule. The business-process switcher calls `ensure` for whatever is
    selected, and inside an experiment that quietly grew it a second clone —
    live-seen: an experiment started on one process ended up holding three, so
    it was really a whole-workspace copy that merely began on one. It must
    refuse, and say where the work belongs."""
    alice = env["user_copy"]("alice")
    _commit(os.path.join(alice, "bpb"), "file.txt", "alice-committed\n", "alice work")
    exp = env["experiment"]("exp-pricing-ab12", "alice", bps=["bpa"])

    with pytest.raises(HTTPException) as ei:
        _as(OWNER, lambda: ensure_bp_in_copy("exp-pricing-ab12", "bpb"))
    assert ei.value.status_code == 409
    # Actionable: it names the experiment, the process it IS on, the process
    # asked for, and the copy to go to instead.
    for part in ("Try new pricing", "bpa", "bpb", "alice"):
        assert part in ei.value.detail
    # And nothing was created: the experiment still holds exactly its own.
    assert bp_git.list_bp_clones(exp) == ["bpa"]


def test_an_experiment_accepts_its_own_business_process_idempotently(env):
    """The switcher selecting the process the experiment IS on must still be a
    plain no-op, not a refusal."""
    env["user_copy"]("alice")
    env["experiment"]("exp-pricing-ab12", "alice", bps=["bpa"])
    res = _as(OWNER, lambda: ensure_bp_in_copy("exp-pricing-ab12", "bpa"))
    assert res == {"ok": True, "already": True, "copy": "exp-pricing-ab12", "bp": "bpa"}


def test_a_legacy_experiment_without_bp_is_handled_deterministically(env):
    """An experiment created before the rule records no `bp`. It is NOT guessed
    at — not from the directory's single clone, not from the name. It is
    reported as legacy in the listing (so the dashboard can group and label it
    rather than hide it), it keeps the clones it has, and it gains none."""
    alice = env["user_copy"]("alice")
    exp = env["experiment"]("exp-legacy-ab12", "alice", bps=["bpa"])
    # Rewrite the sidecar the way a pre-rule gitops wrote it.
    meta = json.loads(_read(os.path.join(exp, COPY_META_FILE)))
    del meta["bp"]
    copies.write_copy_meta(exp, meta)

    assert copies.experiment_bp(copies.read_copy_meta(exp)) is None
    # No guessing from the one clone that happens to be there.
    assert bp_git.list_bp_clones(exp) == ["bpa"]

    state = {c["name"]: c for c in asyncio.run(copies.refresh_copies())}[
        "exp-legacy-ab12"
    ]
    assert state["bp_legacy"] is True
    assert "bp" not in state

    # It gains nothing — including the process its parent has and it does not.
    _commit(os.path.join(alice, "bpb"), "file.txt", "alice\n", "alice work")
    with pytest.raises(HTTPException) as ei:
        _as(OWNER, lambda: ensure_bp_in_copy("exp-legacy-ab12", "bpb"))
    assert ei.value.status_code == 409
    assert "before experiments were per-business-process" in ei.value.detail
    assert bp_git.list_bp_clones(exp) == ["bpa"]


def test_a_new_business_process_cannot_be_born_in_an_experiment(env):
    """The other way a copy gains a clone. An experiment holds the one process
    it is about, so creating a brand-new one INTO it is refused for the same
    reason materializing an existing one is."""
    env["user_copy"]("alice")
    env["experiment"]("exp-pricing-ab12", "alice", bps=["bpa"])
    with pytest.raises(HTTPException) as ei:
        copies.assert_copy_can_hold_bp("exp-pricing-ab12", "brand-new")
    assert ei.value.status_code == 409
    assert "bpa" in ei.value.detail
    # A person's copy carries anything: that is what a copy IS.
    copies.assert_copy_can_hold_bp("alice", "brand-new")


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


def _advance_main(env, tmp_path, bp, texts, label="main moves"):
    """Publish `texts` as successive commits on `bp`'s main, as another person
    deploying would."""
    other = tmp_path / f"other-clone-{bp}-{len(texts)}-{label.replace(' ', '-')}"
    _git("clone", "-q", git_server.bp_bare_repo_path(bp), str(other))
    for t in texts:
        _commit(str(other), "file.txt", t, label)
    asyncio.run(bp_git.publish_main_from_clone(str(other), bp))


def test_behind_main_is_per_business_process_not_per_copy(env, tmp_path):
    """THE reading the Sync step and the Deploy gate both key off.

    "Behind main" is a fact about a BUSINESS PROCESS, not about a copy: each
    one is its own repository with its own main. As a copy-wide aggregate it
    put a Sync step in front of a user working on one process and then listed
    another process's commits as what would arrive (user-reported: "Why am I
    seeing those same changes in e2eflow1?"). So it is asked, and answered,
    per business process.
    """
    alice = env["user_copy"]("alice")

    fresh = asyncio.run(copies.get_bp_divergence("alice", bp="bpa"))
    assert (fresh["ahead_bp"], fresh["behind_bp"]) == (
        0,
        0,
    ), "a copy just made from main is not behind it"

    # Someone else publishes two commits to bpa's main. bpb is untouched.
    _advance_main(env, tmp_path, "bpa", ["a1\n", "a2\n"])

    on_a = asyncio.run(copies.get_bp_divergence("alice", bp="bpa"))
    on_b = asyncio.run(copies.get_bp_divergence("alice", bp="bpb"))

    # The process whose main moved is behind; the one that did not is NOT —
    # this is the whole point, and the aggregate could not express it.
    assert on_a["behind_bp"] == 2
    assert on_b["behind_bp"] == 0, (
        "a business process whose own main never moved must not be reported "
        "behind because a DIFFERENT one was"
    )
    # …and each one still sees the other's movement only in the `_other`
    # figures, which is what lets a screen say "other processes have work"
    # without mixing it into this one's counts.
    assert on_b["behind_other"] == 2
    assert on_a["behind_other"] == 0

    # Work of our own does not make us behind — that is `ahead`.
    _commit(os.path.join(alice, "bpb"), "mine.txt", "mine\n", "my work")
    again = asyncio.run(copies.get_bp_divergence("alice", bp="bpb"))
    assert (again["ahead_bp"], again["behind_bp"]) == (1, 0)


def test_sync_step_and_deploy_gate_cannot_contradict_each_other(env, tmp_path):
    """The Sync step and the Deploy gate are the same fact asked twice, so they
    are answered once — by this endpoint, for the business process on screen.

    Pinned as the pair the UI derives:
      Sync step visible   <=>  behind_bp > 0
      Deploy available    <=>  behind_bp == 0 (a publish must be a fast-forward)

    With one process behind and another current, the two must disagree ACROSS
    processes and agree WITHIN each one.
    """
    alice = env["user_copy"]("alice")
    # bpa: main has moved on (behind). bpb: our own unpublished work (ahead).
    _advance_main(env, tmp_path, "bpa", ["a1\n"])
    _commit(os.path.join(alice, "bpb"), "mine.txt", "mine\n", "my work")

    a = asyncio.run(copies.get_bp_divergence("alice", bp="bpa"))
    b = asyncio.run(copies.get_bp_divergence("alice", bp="bpb"))

    sync_visible = lambda d: d["behind_bp"] > 0  # noqa: E731
    deploy_available = lambda d: d["behind_bp"] == 0  # noqa: E731

    # bpa: Sync yes, Deploy blocked.
    assert sync_visible(a) and not deploy_available(a)
    # bpb: no Sync at all, Deploy available — even though the SAME copy is
    # behind on another process.
    assert not sync_visible(b) and deploy_available(b)
    assert b["ahead_bp"] == 1, "bpb has work to publish"

    # Never both, never neither — for either process.
    for d in (a, b):
        assert sync_visible(d) != deploy_available(d)


def test_pulling_scopes_to_one_business_process(env, tmp_path):
    """Sync pulls the business process the user is on, not the whole copy.

    The other processes in the copy are untouched — including ones whose main
    has also moved. They get pulled when the user is looking at them, which is
    when they are told about it."""
    alice = env["user_copy"]("alice")
    _advance_main(env, tmp_path, "bpa", ["a1\n"])
    _advance_main(env, tmp_path, "bpb", ["b1\n"])

    res = _as(OWNER, lambda: copies.rebase_copy("alice", SyncCopyRequest(bp="bpa")))
    assert res.status == "success"
    assert _read(os.path.join(alice, "bpa", "file.txt")) == "a1\n"
    # bpb was NOT pulled: it is still on the copy's own tip, still behind.
    assert _read(os.path.join(alice, "bpb", "file.txt")) == "b0\n"
    assert asyncio.run(copies.get_bp_divergence("alice", bp="bpa"))["behind_bp"] == 0
    assert asyncio.run(copies.get_bp_divergence("alice", bp="bpb"))["behind_bp"] == 1


# ── what a pull brings in ───────────────────────────────────────────────────


def test_incoming_reports_the_files_a_pull_changes_not_only_its_commits(env, tmp_path):
    """The Sync screen's data: the commits arriving AND their file effect.

    Commit subjects alone were what it had, and on a workspace where everyone
    edits the same file that is thirty identical lines and no answer to the
    question the screen exists for — "what actually changes?" (user-reported,
    with a screenshot of exactly that list). So the reading carries both.
    """
    env["user_copy"]("alice")
    _advance_main(env, tmp_path, "bpa", ["a1\n", "a2\n"])

    inc = asyncio.run(copies.get_incoming("alice", bp="bpa"))

    assert [c["subject"] for c in inc["commits"]] == ["main moves", "main moves"]
    assert inc["commits_truncated"] is False
    # Paths are copy-root-relative (`<bp>/…`), the same vocabulary /status and
    # every diff header in the app use — the file list is clickable and its
    # rows have to name something the diff endpoint accepts.
    assert [f["path"] for f in inc["files"]] == ["bpa/file.txt"]
    assert (inc["files"][0]["adds"], inc["files"][0]["dels"]) == (1, 1)
    assert inc["files"][0]["kind"] == "modified"

    diff = asyncio.run(copies.get_incoming_diff("alice", bp="bpa"))
    assert "+a2" in diff["diff"] and "-a0" in diff["diff"]
    assert "a/bpa/file.txt" in diff["diff"], "patch headers stay copy-root-relative"
    assert diff["truncated"] is False


def test_incoming_is_measured_from_the_merge_base_not_from_the_copys_tip(env, tmp_path):
    """A pull REPLAYS the copy's own commits on top of main, so the copy's work
    is not something the pull brings in — and must not be listed as arriving.

    Read as a two-dot diff (`HEAD..main`) the copy's own files show up inverted
    — its additions as deletions — which reads as "pulling will delete my
    work". It is measured from the merge base instead.
    """
    alice = env["user_copy"]("alice")
    _commit(os.path.join(alice, "bpa"), "mine.txt", "mine\n", "my own work")
    _advance_main(env, tmp_path, "bpa", ["a1\n"])

    inc = asyncio.run(copies.get_incoming("alice", bp="bpa"))

    assert [f["path"] for f in inc["files"]] == ["bpa/file.txt"]
    assert "bpa/mine.txt" not in [f["path"] for f in inc["files"]]
    assert [c["subject"] for c in inc["commits"]] == ["main moves"]
    diff = asyncio.run(copies.get_incoming_diff("alice", bp="bpa"))
    assert "mine.txt" not in diff["diff"]


def test_incoming_answers_for_a_process_the_copy_has_never_checked_out(env, tmp_path):
    """A business process somebody else created after this copy was made.

    The copy has no clone of it, so there is no working tree to ask — the
    answer comes from the bare repo, against the empty tree: the whole process
    arrives. The commit-only view this replaces returned 404 here, which is
    what the Sync screen showed for a business process that had just been
    created (bailey-lab #362 territory: the step existed, its content did not).
    """
    env["user_copy"]("alice")
    env["seed_bp"]("bpc", "new.txt", "c0\n")

    # Precondition: the divergence reading — which is what puts the Sync step
    # on screen — already says this process is behind.
    assert asyncio.run(copies.get_bp_divergence("alice", bp="bpc"))["behind_bp"] > 0

    inc = asyncio.run(copies.get_incoming("alice", bp="bpc"))

    assert [f["path"] for f in inc["files"]] == ["bpc/new.txt"]
    assert inc["files"][0]["kind"] == "added"
    # Its whole history arrives, seed commit included — that IS the pull.
    assert [c["subject"] for c in inc["commits"]] == [
        "seed bpc",
        "Initialize business process bpc",
    ]
    diff = asyncio.run(copies.get_incoming_diff("alice", bp="bpc"))
    assert "+c0" in diff["diff"]


def test_incoming_diff_scopes_to_one_file_and_rejects_another_process(env, tmp_path):
    """Clicking a row in the file list asks for that row's diff — and only a
    path inside the business process being pulled is a row in that list."""
    env["user_copy"]("alice")
    _advance_main(env, tmp_path, "bpa", ["a1\n"])
    _advance_main(env, tmp_path, "bpb", ["b1\n"])

    one = asyncio.run(copies.get_incoming_diff("alice", bp="bpa", path="bpa/file.txt"))
    assert "+a1" in one["diff"]

    with pytest.raises(HTTPException) as ei:
        asyncio.run(copies.get_incoming_diff("alice", bp="bpa", path="bpb/file.txt"))
    assert ei.value.status_code == 400

    with pytest.raises(HTTPException) as ei:
        asyncio.run(
            copies.get_incoming_diff("alice", bp="bpa", path="../../etc/passwd")
        )
    assert ei.value.status_code == 400


def test_incoming_is_empty_when_there_is_nothing_to_pull(env):
    """The Sync step should not exist at all here — but when it is opened
    anyway (a reload on a stale link), "nothing arrives" is an answer, not an
    error."""
    env["user_copy"]("alice")

    inc = asyncio.run(copies.get_incoming("alice", bp="bpa"))
    assert inc["commits"] == [] and inc["files"] == []
    assert asyncio.run(copies.get_incoming_diff("alice", bp="bpa"))["diff"] == ""


def test_ensure_bp_in_experiment_materializes_from_the_parent(env):
    """An experiment's world is its PARENT's, not main's: when its own clone
    has to be (re)materialized it comes from the parent's branch, including
    work that never reached main."""
    alice = env["user_copy"]("alice")
    # A business process whose parent branch has work main has never seen.
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

    exp = env["experiment"]("exp-pricing-ab12", "alice", bps=["bpc"])
    clone = os.path.join(exp, "bpc")
    assert "parent" in _read(os.path.join(clone, "process.toml"))
    assert (
        _git("rev-parse", "--abbrev-ref", "HEAD", cwd=clone).stdout.strip()
        == "exp-pricing-ab12"
    )
    # The experiment is on bpc and holds nothing else — not even the processes
    # its parent carries.
    assert bp_git.list_bp_clones(exp) == ["bpc"]


def _make_legacy(exp_path):
    """Turn an experiment into a LEGACY one: drop the recorded `bp`, exactly as
    an experiment created before experiments were per-business-process looks on
    disk. Those keep their historical whole-directory scope (nothing else can
    be honest about them — which process they were about was never written
    down), and that scope is what the tests below pin."""
    meta = json.loads(_read(os.path.join(exp_path, COPY_META_FILE)))
    meta.pop("bp", None)
    copies.write_copy_meta(exp_path, meta)


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
    # The merge covers the ONE business process the experiment is on, and
    # nothing else in the workspace.
    assert [(r["bp"], r["status"]) for r in res.bp_results] == [("bpa", "success")]


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


def test_merge_publishes_a_bp_that_exists_only_in_a_legacy_experiment(env):
    """A business process can only be inside an experiment and not inside its
    parent on a LEGACY experiment — the per-process rule refuses both routes
    that could put one there (materialize, and create-into-a-copy). Legacy
    experiments still have to merge back cleanly, so the publish-wholesale path
    stays, scoped to exactly the copies it can still apply to."""
    alice = env["user_copy"]("alice")
    exp = env["experiment"]("exp-pricing-ab12", "alice")
    _make_legacy(exp)
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
    """The whole-directory shape, on the only copies that can still have one:
    a legacy experiment (see `_make_legacy`)."""
    alice = env["user_copy"]("alice")
    exp = env["experiment"]("exp-pricing-ab12", "alice")
    _make_legacy(exp)
    asyncio.run(copies._clone_bp_into_copy(exp, "exp-pricing-ab12", "bpb", "alice"))
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


# ── scope: every copy-wide read is the experiment's ONE business process ────


def test_experiment_divergence_and_status_cover_only_its_own_bp(env, tmp_path):
    """A copy-wide read on an experiment answers for the process it is about
    and no other. Before the rule these iterated the directory, so an
    experiment that had grown clones reported ahead/behind/changed files for
    business processes the user had never opted into — and, worse, counted
    processes it did NOT carry as "behind main", offering a pull that would
    have materialized them."""
    env["user_copy"]("alice")
    exp = env["experiment"]("exp-pricing-ab12", "alice", bps=["bpa"])
    _commit(os.path.join(exp, "bpa"), "file.txt", "exp\n", "exp work")

    # Main moves ahead on the OTHER business process — nothing to do with this
    # experiment, and it must not show up anywhere in its figures.
    other = tmp_path / "other-clone"
    _git("clone", "-q", git_server.bp_bare_repo_path("bpb"), str(other))
    _commit(str(other), "file.txt", "b1\n", "main moves on bpb")
    asyncio.run(bp_git.publish_main_from_clone(str(other), "bpb"))

    assert copies.copy_scope_bps(exp) == ["bpa"]
    assert asyncio.run(copies.get_all_bp_divergence("exp-pricing-ab12")).keys() == {
        "bpa"
    }
    # The experiment is not behind on anything: bpb is not its business.
    exp_div = asyncio.run(copies.get_bp_divergence("exp-pricing-ab12", bp="bpa"))
    assert (exp_div["behind_bp"], exp_div["behind_other"]) == (0, 0)
    changed = asyncio.run(copies.get_copy_status("exp-pricing-ab12"))["changed"]
    assert {c["path"].split("/")[0] for c in changed} == {"bpa"}
    # …while the parent copy, which IS workspace-wide, does see bpb move — but
    # only when you ask about bpb.
    assert asyncio.run(copies.get_bp_divergence("alice", bp="bpb"))["behind_bp"] == 1
    assert asyncio.run(copies.get_bp_divergence("alice", bp="bpa"))["behind_bp"] == 0


def test_experiment_divergence_reports_no_other_business_processes(env):
    """The Deploy/divergence screen's "other business processes" figures are
    always zero in an experiment: it HAS no others."""
    env["user_copy"]("alice")
    exp = env["experiment"]("exp-pricing-ab12", "alice", bps=["bpa"])
    _commit(os.path.join(exp, "bpa"), "file.txt", "exp\n", "exp work")

    d = asyncio.run(copies.get_bp_divergence("exp-pricing-ab12", bp="bpa"))
    assert d["ahead_bp"] == 1
    assert d["ahead_other"] == 0 and d["behind_other"] == 0


def test_pulling_main_into_an_experiment_cannot_materialize_other_bps(env):
    """`/rebase` without a `bp` materializes every business process main
    carries — that is how a PERSON's copy gains one somebody else created. In
    an experiment it would be a second clone by another name."""
    env["user_copy"]("alice")
    exp = env["experiment"]("exp-pricing-ab12", "alice", bps=["bpa"])

    res = _as(OWNER, lambda: copies.rebase_copy("exp-pricing-ab12"))
    assert res.status == "noop"
    assert bp_git.list_bp_clones(exp) == ["bpa"]

    with pytest.raises(HTTPException) as ei:
        _as(
            OWNER,
            lambda: copies.rebase_copy("exp-pricing-ab12", SyncCopyRequest(bp="bpb")),
        )
    assert ei.value.status_code == 409
    assert bp_git.list_bp_clones(exp) == ["bpa"]


def test_merge_to_parent_refuses_a_bp_that_is_not_the_experiments(env):
    env["user_copy"]("alice")
    env["experiment"]("exp-pricing-ab12", "alice", bps=["bpa"])
    with pytest.raises(HTTPException) as ei:
        _as(
            OWNER,
            lambda: merge_copy_to_parent("exp-pricing-ab12", SyncCopyRequest(bp="bpb")),
        )
    assert ei.value.status_code == 409
    assert "bpa" in ei.value.detail


# ── adopt: take a version wholesale, without losing the old one ─────────────


def _adopt(copy, **kw):
    from app.routes.copies import AdoptRequest

    return lambda: copies.adopt_version(copy, AdoptRequest(**kw))


def test_adopting_an_experiment_parks_my_work_and_consumes_the_experiment(
    env, delete_env
):
    """ "Use this version without merging": the experiment BECOMES my copy.

    Two things must both be true afterwards, and the second is the one that
    makes the button safe to press: my copy holds the experiment's content, and
    the work my copy had is not gone — it is an experiment of its own.
    """
    alice = env["user_copy"]("alice")
    _commit(os.path.join(alice, "bpa"), "file.txt", "alice-work\n", "alice work")
    exp = env["experiment"]("exp-try-ab12", "alice", bps=["bpa"])
    _commit(os.path.join(exp, "bpa"), "file.txt", "experiment-work\n", "exp work")
    # …and my copy moves on again AFTER the experiment branched, so there is
    # genuinely something the experiment does not contain.
    _commit(os.path.join(alice, "bpa"), "later.txt", "later\n", "alice later")

    res = _as(
        OWNER,
        _adopt(
            "alice",
            bp="bpa",
            source="experiment",
            experiment="exp-try-ab12",
            park_name="exp-my-previous-bpa-cd34",
            park_title="My previous Compost work — 2026-08-07 14:32",
        ),
    )

    assert res.adopted == "experiment"
    # My copy is now the experiment, byte for byte.
    assert _read(os.path.join(alice, "bpa", "file.txt")) == "experiment-work\n"
    assert not os.path.exists(os.path.join(alice, "bpa", "later.txt"))
    # My previous work was parked, and is REACHABLE — the whole point.
    assert res.parked == {
        "name": "exp-my-previous-bpa-cd34",
        "title": "My previous Compost work — 2026-08-07 14:32",
    }
    parked = os.path.join(env["copies_dir"], "exp-my-previous-bpa-cd34")
    assert _read(os.path.join(parked, "bpa", "later.txt")) == "later\n"
    parked_meta = json.loads(_read(os.path.join(parked, COPY_META_FILE)))
    assert parked_meta["kind"] == "experiment"
    assert parked_meta["parent"] == "alice"
    assert parked_meta["bp"] == "bpa"
    assert parked_meta["owner"] == OWNER
    # The adopted experiment is consumed — it IS my copy now, so keeping it
    # would leave two copies claiming to be the same thing.
    assert res.teardown_task_id
    assert delete_env and delete_env[-1][0] == "exp-try-ab12"


def test_adopting_parks_nothing_when_there_is_nothing_to_lose(env, delete_env):
    """An experiment branched from my copy and moved on: everything of mine is
    already in it. Parking would create an experiment that duplicates the
    source — clutter, and a toast that claims to have saved something it
    didn't."""
    alice = env["user_copy"]("alice")
    _commit(os.path.join(alice, "bpa"), "file.txt", "alice-work\n", "alice work")
    exp = env["experiment"]("exp-try-ab12", "alice", bps=["bpa"])
    _commit(os.path.join(exp, "bpa"), "file.txt", "experiment-work\n", "exp work")

    res = _as(
        OWNER,
        _adopt("alice", bp="bpa", source="experiment", experiment="exp-try-ab12"),
    )

    assert res.parked is None
    assert "Nothing needed saving" in res.message
    assert _read(os.path.join(alice, "bpa", "file.txt")) == "experiment-work\n"
    assert not os.path.exists(
        os.path.join(env["copies_dir"], "exp-my-previous-bpa-cd34")
    )


def test_adopting_main_parks_my_work_and_takes_main_as_it_stands(env, tmp_path):
    """ "Edit the main version without merging my changes": the opposite of a
    pull. A pull replays my work on top of main; this takes main as it stands
    and keeps mine to one side."""
    alice = env["user_copy"]("alice")
    _commit(os.path.join(alice, "bpa"), "file.txt", "alice-work\n", "alice work")
    _advance_main(env, tmp_path, "bpa", ["main-work\n"])

    res = _as(
        OWNER,
        _adopt(
            "alice",
            bp="bpa",
            source="main",
            park_name="exp-my-previous-bpa-cd34",
            park_title="My previous Compost work — 2026-08-07 14:32",
        ),
    )

    assert res.adopted == "main"
    assert res.teardown_task_id is None, "main is not consumed by being adopted"
    assert _read(os.path.join(alice, "bpa", "file.txt")) == "main-work\n"
    # Level with main afterwards: this is how it differs from a pull, which
    # would have left me one commit ahead.
    div = asyncio.run(copies.get_bp_divergence("alice", bp="bpa"))
    assert (div["ahead_bp"], div["behind_bp"]) == (0, 0)
    parked = os.path.join(env["copies_dir"], "exp-my-previous-bpa-cd34")
    assert _read(os.path.join(parked, "bpa", "file.txt")) == "alice-work\n"


def test_adopting_touches_only_the_one_business_process(env, tmp_path):
    """Everything here is per business process. The copy's OTHER processes are
    not part of the question and must not move."""
    alice = env["user_copy"]("alice")
    _commit(os.path.join(alice, "bpb"), "file.txt", "my-bpb-work\n", "alice bpb")
    bpb_tip = _head(os.path.join(alice, "bpb"))
    _advance_main(env, tmp_path, "bpa", ["main-work\n"])
    _advance_main(env, tmp_path, "bpb", ["main-bpb\n"])

    _as(OWNER, _adopt("alice", bp="bpa", source="main"))

    assert _read(os.path.join(alice, "bpa", "file.txt")) == "main-work\n"
    # bpb is exactly where it was — same tip, same content, still behind main.
    assert _head(os.path.join(alice, "bpb")) == bpb_tip
    assert _read(os.path.join(alice, "bpb", "file.txt")) == "my-bpb-work\n"
    assert asyncio.run(copies.get_bp_divergence("alice", bp="bpb"))["behind_bp"] == 1


def test_adopting_commits_uncommitted_work_on_both_sides(env):
    """What the user SEES is what moves: uncommitted edits in the experiment are
    adopted, and uncommitted edits in my copy are parked rather than destroyed
    by the reset."""
    alice = env["user_copy"]("alice")
    exp = env["experiment"]("exp-try-ab12", "alice", bps=["bpa"])
    _write(os.path.join(exp, "bpa"), "file.txt", "experiment-draft\n")
    _write(os.path.join(alice, "bpa"), "mine.txt", "my-draft\n")

    res = _as(
        OWNER,
        _adopt(
            "alice",
            bp="bpa",
            source="experiment",
            experiment="exp-try-ab12",
            park_name="exp-my-previous-bpa-cd34",
            park_title="My previous work",
        ),
    )

    assert _read(os.path.join(alice, "bpa", "file.txt")) == "experiment-draft\n"
    assert not os.path.exists(os.path.join(alice, "bpa", "mine.txt"))
    assert res.parked is not None
    parked = os.path.join(env["copies_dir"], "exp-my-previous-bpa-cd34")
    assert _read(os.path.join(parked, "bpa", "mine.txt")) == "my-draft\n"


def test_a_failed_adopt_leaves_the_parked_work_and_says_so(env, monkeypatch):
    """The one thing this must never do is leave the user with neither version.
    If the adopt fails after parking, the parked experiment still exists and the
    error names it."""
    alice = env["user_copy"]("alice")
    _commit(os.path.join(alice, "bpa"), "file.txt", "alice-work\n", "alice work")
    exp = env["experiment"]("exp-try-ab12", "alice", bps=["bpa"])
    _commit(os.path.join(exp, "bpa"), "file.txt", "experiment-work\n", "exp work")
    _commit(os.path.join(alice, "bpa"), "later.txt", "later\n", "alice later")

    exp_tip = _head(os.path.join(exp, "bpa"))
    real = copies.call_git_command_with_output

    async def _fail_the_ref_move(*args, **kwargs):
        # ONLY the adopt's ref move: `refs/heads/alice` -> the experiment tip.
        # Both of the other update-refs in this flow look similar and must
        # still work — publishing the experiment's own branch before reading
        # its tip, and publishing MY tip before the parked experiment branches
        # off it. The question here is what happens when the park SUCCEEDED and
        # the adopt did not.
        if "update-ref" in args and "refs/heads/alice" in args and exp_tip in args:
            return "", "disk on fire", 1
        return await real(*args, **kwargs)

    monkeypatch.setattr(copies, "call_git_command_with_output", _fail_the_ref_move)

    with pytest.raises(HTTPException) as ei:
        _as(
            OWNER,
            _adopt(
                "alice",
                bp="bpa",
                source="experiment",
                experiment="exp-try-ab12",
                park_name="exp-my-previous-bpa-cd34",
                park_title="My previous work",
                bp_label="Compost",
            ),
        )

    assert ei.value.status_code == 500
    assert "your previous work on Compost is safe" in ei.value.detail
    assert "My previous work" in ei.value.detail
    # And it really is there.
    parked = os.path.join(env["copies_dir"], "exp-my-previous-bpa-cd34")
    assert _read(os.path.join(parked, "bpa", "later.txt")) == "later\n"
    # Nothing was adopted: my copy is untouched, and so is the experiment.
    assert _read(os.path.join(alice, "bpa", "file.txt")) == "alice-work\n"
    assert os.path.isdir(os.path.join(env["copies_dir"], "exp-try-ab12"))


def test_adopting_requires_the_owner_and_refuses_an_experiment_target(env):
    env["user_copy"]("alice")
    env["experiment"]("exp-try-ab12", "alice", bps=["bpa"])

    # Somebody else's copy is not theirs to overwrite.
    with pytest.raises(HTTPException) as ei:
        _as(OTHER, _adopt("alice", bp="bpa", source="main"))
    assert ei.value.status_code == 403

    # A version is adopted INTO a person's copy, never into an experiment.
    with pytest.raises(HTTPException) as ei:
        _as(OWNER, _adopt("exp-try-ab12", bp="bpa", source="main"))
    assert ei.value.status_code == 400
    assert "is an experiment" in ei.value.detail


def test_adopting_refuses_an_experiment_that_is_not_mine_or_not_on_this_bp(env):
    env["user_copy"]("alice")
    env["user_copy"]("bob", owner=OTHER)
    env["experiment"]("exp-bobs-ab12", "bob", owner=OTHER, bps=["bpa"])
    env["experiment"]("exp-mine-cd34", "alice", bps=["bpb"])

    # Not my experiment (owner guard fires first).
    with pytest.raises(HTTPException) as ei:
        _as(
            OWNER,
            _adopt("alice", bp="bpa", source="experiment", experiment="exp-bobs-ab12"),
        )
    assert ei.value.status_code == 403

    # My experiment, but on a different business process.
    with pytest.raises(HTTPException) as ei:
        _as(
            OWNER,
            _adopt("alice", bp="bpa", source="experiment", experiment="exp-mine-cd34"),
        )
    assert ei.value.status_code == 409
    assert "bpb" in ei.value.detail


def test_adopting_refuses_to_overwrite_work_without_somewhere_to_put_it(env, tmp_path):
    """park_name/park_title are not decoration: without them there is nowhere
    for the work to go, so the answer is a 400 that says how much is at stake —
    never a silent overwrite."""
    alice = env["user_copy"]("alice")
    _commit(os.path.join(alice, "bpa"), "file.txt", "alice-work\n", "alice work")
    _advance_main(env, tmp_path, "bpa", ["main-work\n"])

    with pytest.raises(HTTPException) as ei:
        _as(OWNER, _adopt("alice", bp="bpa", source="main"))
    assert ei.value.status_code == 400
    assert "must be parked" in ei.value.detail
    assert _read(os.path.join(alice, "bpa", "file.txt")) == "alice-work\n"


def _tree(repo, ref="HEAD"):
    """The TREE a ref points at — what the files actually are, independent of
    history. Two commits with the same tree hold byte-identical content."""
    if os.path.isdir(os.path.join(repo, ".git")):
        return _git("rev-parse", f"{ref}^{{tree}}", cwd=repo).stdout.strip()
    return _git("-C", repo, "rev-parse", f"{ref}^{{tree}}").stdout.strip()


def _ahead_behind(clone, bare):
    """(ahead, behind) of a clone against its repo's main, read from git."""
    _git("fetch", "-q", bare, "main", cwd=clone)
    out = _git("rev-list", "--left-right", "--count", "FETCH_HEAD...HEAD", cwd=clone)
    behind, ahead = out.stdout.split()
    return int(ahead), int(behind)


@pytest.fixture()
def deployed(monkeypatch, tmp_path):
    """The DEPLOYMENT RECORDS — the only non-git thing the commit sources read.

    A live dict the test fills in as `deployed[(bp, stage)] = [sha, …]` once it
    knows the shas, newest first. Git itself is never mocked in these tests;
    this stands in for bitswan.yaml's audit log, which would need a whole
    deployed workspace to exist for real — but it answers in the SHAPE the real
    `bp_history` answers in (`{"history": [...]}`, entries carrying `source`
    and `deployed_at`), because reading it wrongly is exactly the sort of bug a
    stub can hide.
    """
    records: dict[tuple[str, str], list[str]] = {}

    class _Svc:
        gitops_dir = str(tmp_path)
        workspace_name = "ws"

        async def bp_history(self, bp, stage, limit=200):
            history = [
                {
                    "commit": f"audit-{c[:7]}",
                    "source_commit": c,
                    "deployed_at": "2026-08-01T09:15:00+00:00",
                    "deployed_by": OWNER,
                    "status": "deployed",
                    "source": "deploy",
                    "members": {},
                }
                for c in records.get((bp, stage), [])
            ]
            # The audit timeline also carries things that are NOT deployments.
            history.append(
                {
                    "commit": "audit-firewall",
                    "source_commit": None,
                    "deployed_at": "2026-08-01T08:00:00+00:00",
                    "deployed_by": OWNER,
                    "status": "firewall",
                    "source": "firewall",
                    "members": {},
                }
            )
            return {
                "bp": bp,
                "stage": stage,
                "current": history[0]["commit"] if records.get((bp, stage)) else None,
                "history": history,
            }

    import app.dependencies as deps

    monkeypatch.setattr(deps, "get_automation_service", lambda: _Svc())
    return records


def test_adopting_leaves_the_copy_on_top_of_main_ready_to_deploy(
    env, tmp_path, deployed
):
    """THE INVARIANT: after any adopt, your copy is main plus your own changes.

    Never behind. Adopting an older version by moving the branch backwards
    would have made a hotpatch unpublishable until you had synced first; a
    restore commit on top of main makes the very next Deploy a fast-forward.
    Asserted on git state: the tree is the target's, the counts are 1/0, and the
    publish really does fast-forward."""
    alice = env["user_copy"]("alice")
    clone = os.path.join(alice, "bpa")
    bare = env["bares"]["bpa"]
    # A version that WAS deployed, then main moved on past it.
    _commit(clone, "file.txt", "v1\n", "v1")
    asyncio.run(bp_git.publish_main_from_clone(clone, "bpa"))
    old_deployed = _head(clone)
    deployed[("bpa", "production")] = [old_deployed]
    _advance_main(env, tmp_path, "bpa", ["v2\n"], label="main moves past it")
    _as(OWNER, lambda: copies.rebase_copy("alice", SyncCopyRequest(bp="bpa")))
    assert _ahead_behind(clone, bare) == (0, 0)

    res = _as(
        OWNER,
        _adopt("alice", bp="bpa", source="commit", commit=old_deployed),
    )

    assert res.method == "restore"
    # The CONTENT is the old version…
    assert _read(os.path.join(clone, "file.txt")) == "v1\n"
    assert _tree(clone) == _tree(bare, old_deployed)
    # …and the ANCESTRY is main's: exactly one commit ahead, nothing behind.
    assert _ahead_behind(clone, bare) == (1, 0)
    # So publishing it is a plain fast-forward, with no Sync in between.
    sync = _as(
        OWNER, lambda: sync_copy("alice", SyncCopyRequest(deployer=OWNER, bp="bpa"))
    )
    assert sync.status == "success" and sync.method == "fast-forward"
    assert _read(os.path.join(env["copies_dir"], "main", "bpa", "file.txt")) == "v1\n"


def test_a_restore_deletes_files_main_added_and_restores_files_main_removed(
    env, tmp_path, deployed
):
    """A restore is the whole TREE, not an overlay. Files main gained since the
    target must go, and files main dropped must come back — a checkout of paths
    alone would leave the first kind behind."""
    alice = env["user_copy"]("alice")
    clone = os.path.join(alice, "bpa")
    _commit(clone, "keep.txt", "keep\n", "add keep")
    _commit(clone, "gone-later.txt", "here\n", "add one main will delete")
    asyncio.run(bp_git.publish_main_from_clone(clone, "bpa"))
    target = _head(clone)
    deployed[("bpa", "production")] = [target]

    # main: delete one file, add another.
    other = tmp_path / "mover"
    _git("clone", "-q", env["bares"]["bpa"], str(other))
    os.remove(os.path.join(str(other), "gone-later.txt"))
    _commit(str(other), "added-later.txt", "new\n", "main moves on")
    asyncio.run(bp_git.publish_main_from_clone(str(other), "bpa"))
    _as(OWNER, lambda: copies.rebase_copy("alice", SyncCopyRequest(bp="bpa")))
    assert os.path.exists(os.path.join(clone, "added-later.txt"))
    assert not os.path.exists(os.path.join(clone, "gone-later.txt"))

    _as(OWNER, _adopt("alice", bp="bpa", source="commit", commit=target))

    assert not os.path.exists(os.path.join(clone, "added-later.txt")), (
        "a file main added after the target must be gone — the restore is the "
        "target's whole tree"
    )
    assert _read(os.path.join(clone, "gone-later.txt")) == "here\n"
    assert _tree(clone) == _tree(env["bares"]["bpa"], target)


def test_adopting_a_version_main_already_has_commits_nothing(env, deployed):
    """No empty commit that claims to have restored something."""
    alice = env["user_copy"]("alice")
    clone = os.path.join(alice, "bpa")
    _commit(clone, "file.txt", "v1\n", "v1")
    asyncio.run(bp_git.publish_main_from_clone(clone, "bpa"))
    target = _head(clone)
    deployed[("bpa", "production")] = [target]
    before = _head(clone)

    res = _as(OWNER, _adopt("alice", bp="bpa", source="commit", commit=target))

    assert res.method == "already-main"
    assert _head(clone) == before, "no commit was added"
    assert _ahead_behind(clone, env["bares"]["bpa"]) == (0, 0)


def test_adopting_the_same_version_twice_adds_nothing_the_second_time(
    env, tmp_path, deployed
):
    """Idempotent: pressing it again must not pile up identical restore
    commits."""
    alice = env["user_copy"]("alice")
    clone = os.path.join(alice, "bpa")
    _commit(clone, "file.txt", "v1\n", "v1")
    asyncio.run(bp_git.publish_main_from_clone(clone, "bpa"))
    target = _head(clone)
    deployed[("bpa", "production")] = [target]
    _advance_main(env, tmp_path, "bpa", ["v2\n"])
    _as(OWNER, lambda: copies.rebase_copy("alice", SyncCopyRequest(bp="bpa")))

    first = _as(OWNER, _adopt("alice", bp="bpa", source="commit", commit=target))
    tip_after_first = _head(clone)
    second = _as(OWNER, _adopt("alice", bp="bpa", source="commit", commit=target))

    assert first.method == "restore"
    assert (
        second.method == "unchanged"
    ), "the second press found the copy already holding exactly that version"
    assert _tree(clone) == _tree(env["bares"]["bpa"], target)
    # Still exactly one commit ahead of main — not two.
    assert _ahead_behind(clone, env["bares"]["bpa"]) == (1, 0)
    assert _head(clone) == tip_after_first, "the repeat added no commit"


def test_adopting_a_descendant_experiment_keeps_its_own_commits(env):
    """When the source already contains main, taking it IS a fast-forward — so
    the experiment's individual commits survive rather than being flattened
    into one restore."""
    alice = env["user_copy"]("alice")
    exp = env["experiment"]("exp-try-ab12", "alice", bps=["bpa"])
    _commit(os.path.join(exp, "bpa"), "a.txt", "one\n", "exp commit one")
    _commit(os.path.join(exp, "bpa"), "b.txt", "two\n", "exp commit two")
    exp_tip = _head(os.path.join(exp, "bpa"))

    res = _as(
        OWNER,
        _adopt("alice", bp="bpa", source="experiment", experiment="exp-try-ab12"),
    )

    assert res.method == "fast-forward"
    clone = os.path.join(alice, "bpa")
    assert _head(clone) == exp_tip, "the experiment's own tip became my copy's"
    subjects = _git("log", "--format=%s", "-3", cwd=clone).stdout.split("\n")
    assert "exp commit two" in subjects and "exp commit one" in subjects
    assert _ahead_behind(clone, env["bares"]["bpa"]) == (2, 0)


def test_adopting_a_diverged_experiment_restores_it_on_top_of_main(env, tmp_path):
    """When main has moved on since the experiment branched, there is no
    fast-forward to be had — so ONE restore commit carries the experiment's tree
    on top of main, and the copy is still 1 ahead / 0 behind."""
    alice = env["user_copy"]("alice")
    exp = env["experiment"]("exp-try-ab12", "alice", bps=["bpa"])
    _commit(os.path.join(exp, "bpa"), "file.txt", "experiment\n", "exp work")
    exp_tip = _head(os.path.join(exp, "bpa"))
    _advance_main(env, tmp_path, "bpa", ["main-moved\n"])
    _as(OWNER, lambda: copies.rebase_copy("alice", SyncCopyRequest(bp="bpa")))

    res = _as(
        OWNER,
        _adopt("alice", bp="bpa", source="experiment", experiment="exp-try-ab12"),
    )

    assert res.method == "restore"
    clone = os.path.join(alice, "bpa")
    assert _read(os.path.join(clone, "file.txt")) == "experiment\n"
    assert _tree(clone) == _tree(env["bares"]["bpa"], exp_tip)
    assert _ahead_behind(clone, env["bares"]["bpa"]) == (1, 0)


def test_adopting_touches_no_other_business_processs_refs(env, tmp_path, deployed):
    """Per business process means per REPOSITORY: nothing in another BP's bare
    may move."""
    alice = env["user_copy"]("alice")
    _commit(os.path.join(alice, "bpa"), "file.txt", "v1\n", "v1")
    asyncio.run(bp_git.publish_main_from_clone(os.path.join(alice, "bpa"), "bpa"))
    target = _head(os.path.join(alice, "bpa"))
    deployed[("bpa", "production")] = [target]
    _advance_main(env, tmp_path, "bpa", ["v2\n"])
    _as(OWNER, lambda: copies.rebase_copy("alice", SyncCopyRequest(bp="bpa")))

    before = _git(
        "-C", env["bares"]["bpb"], "for-each-ref", "--format=%(refname) %(objectname)"
    ).stdout

    _as(OWNER, _adopt("alice", bp="bpa", source="commit", commit=target))

    after = _git(
        "-C", env["bares"]["bpb"], "for-each-ref", "--format=%(refname) %(objectname)"
    ).stdout
    assert before == after, "another business process's refs moved"


def test_only_a_version_this_workspace_deployed_can_be_adopted(
    env, tmp_path, monkeypatch, deployed
):
    """This endpoint moves a person's branch onto whatever it is handed, so it
    must not accept an arbitrary sha: not an unknown one, and not one from a
    DIFFERENT business process."""
    alice = env["user_copy"]("alice")
    _commit(os.path.join(alice, "bpa"), "file.txt", "v1\n", "v1")
    asyncio.run(bp_git.publish_main_from_clone(os.path.join(alice, "bpa"), "bpa"))
    deployed_a = _head(os.path.join(alice, "bpa"))
    _commit(os.path.join(alice, "bpb"), "file.txt", "b1\n", "b1")
    asyncio.run(bp_git.publish_main_from_clone(os.path.join(alice, "bpb"), "bpb"))
    deployed_b = _head(os.path.join(alice, "bpb"))
    _advance_main(env, tmp_path, "bpa", ["v2\n"])
    _as(OWNER, lambda: copies.rebase_copy("alice", SyncCopyRequest(bp="bpa")))
    tip_before = _head(os.path.join(alice, "bpa"))

    # Each business process's records name only its OWN deployments.
    deployed[("bpa", "production")] = [deployed_a]
    deployed[("bpb", "production")] = [deployed_b]

    # A sha nobody ever deployed.
    with pytest.raises(HTTPException) as ei:
        _as(OWNER, _adopt("alice", bp="bpa", source="commit", commit="0" * 40))
    assert ei.value.status_code == 404

    # A real deployed sha — of ANOTHER business process.
    with pytest.raises(HTTPException) as ei:
        _as(OWNER, _adopt("alice", bp="bpa", source="commit", commit=deployed_b))
    assert ei.value.status_code == 404

    # Not even a sha.
    with pytest.raises(HTTPException) as ei:
        _as(OWNER, _adopt("alice", bp="bpa", source="commit", commit="HEAD~1"))
    assert ei.value.status_code == 400

    # Nothing moved through any of that.
    assert _head(os.path.join(alice, "bpa")) == tip_before
    # …and the one that IS on record works.
    res = _as(OWNER, _adopt("alice", bp="bpa", source="commit", commit=deployed_a))
    assert res.method == "restore"


def test_adopting_materializes_a_business_process_the_copy_does_not_carry(
    env, tmp_path, deployed
):
    """A copy need not already hold the business process. Nothing is at risk in
    a copy that has never had it, so nothing is parked — and the result still
    obeys the invariant."""
    alice = env["user_copy"]("alice")
    clone = os.path.join(alice, "bpa")
    _commit(clone, "file.txt", "v1\n", "v1")
    asyncio.run(bp_git.publish_main_from_clone(clone, "bpa"))
    target = _head(clone)
    deployed[("bpa", "production")] = [target]
    _advance_main(env, tmp_path, "bpa", ["v2\n"])
    # …and the copy loses its checkout entirely (a fresh colleague's copy, or a
    # clone dir that was cleaned up).
    subprocess.run(["rm", "-rf", clone], check=True)

    res = _as(OWNER, _adopt("alice", bp="bpa", source="commit", commit=target))

    assert res.parked is None
    assert _read(os.path.join(clone, "file.txt")) == "v1\n"
    assert _ahead_behind(clone, env["bares"]["bpa"]) == (1, 0)


def test_adopting_never_touches_another_persons_copy(env, tmp_path, deployed):
    """A copy is one person's environment. Adopting into mine is invisible to
    everyone else until I Deploy."""
    alice = env["user_copy"]("alice")
    bob = env["user_copy"]("bob", owner=OTHER)
    _commit(os.path.join(bob, "bpa"), "bobs.txt", "bob\n", "bob works")
    bob_tip = _head(os.path.join(bob, "bpa"))
    bob_ref = _head(env["bares"]["bpa"], "refs/heads/bob")
    _commit(os.path.join(alice, "bpa"), "file.txt", "v1\n", "v1")
    asyncio.run(bp_git.publish_main_from_clone(os.path.join(alice, "bpa"), "bpa"))
    target = _head(os.path.join(alice, "bpa"))
    deployed[("bpa", "production")] = [target]
    _advance_main(env, tmp_path, "bpa", ["v2\n"])
    _as(OWNER, lambda: copies.rebase_copy("alice", SyncCopyRequest(bp="bpa")))

    _as(OWNER, _adopt("alice", bp="bpa", source="commit", commit=target))

    assert _head(os.path.join(bob, "bpa")) == bob_tip
    assert _head(env["bares"]["bpa"], "refs/heads/bob") == bob_ref
    assert _read(os.path.join(bob, "bpa", "bobs.txt")) == "bob\n"


def test_adopting_refuses_a_source_it_does_not_know(env):
    env["user_copy"]("alice")
    with pytest.raises(HTTPException) as ei:
        _as(OWNER, _adopt("alice", bp="bpa", source="whatever"))
    assert ei.value.status_code == 400
    assert "Invalid source" in ei.value.detail


def test_adopting_an_experiment_that_deleted_a_file_deletes_it_here_too(env):
    """The adopt is the experiment's whole tree, deletions included — otherwise
    "use this version" quietly means "use this version plus whatever of mine it
    removed"."""
    alice = env["user_copy"]("alice")
    _commit(os.path.join(alice, "bpa"), "doomed.txt", "here\n", "add doomed")
    exp = env["experiment"]("exp-try-ab12", "alice", bps=["bpa"])
    os.remove(os.path.join(exp, "bpa", "doomed.txt"))
    _git("add", "-A", cwd=os.path.join(exp, "bpa"))
    _git("commit", "-qm", "the experiment removes it", cwd=os.path.join(exp, "bpa"))

    _as(
        OWNER,
        _adopt("alice", bp="bpa", source="experiment", experiment="exp-try-ab12"),
    )

    assert not os.path.exists(os.path.join(alice, "bpa", "doomed.txt"))


# ── reverting the dev stage ─────────────────────────────────────────────────
#
# Dev deploys from main, so "put dev back" is a change to MAIN — made the only
# way main ever changes, by one new commit on top. The tests below are about
# that being true, and about the consequence being real: everybody else's copy
# goes one behind and carries the revert on their next Sync.


def _revert_dev(bp, **kw):
    from app.routes.copies import RevertDevRequest

    return lambda: copies.revert_dev_to_version(bp, RevertDevRequest(**kw))


def _main_tip(env, bp):
    return _head(env["bares"][bp], "refs/heads/main")


def test_reverting_dev_moves_main_forward_and_rewrites_nothing(env, tmp_path, deployed):
    """FORWARD-ONLY. The version that broke stays in the history, reachable —
    a revert that rewrote main would take it away from everyone who has it."""
    alice = env["user_copy"]("alice")
    clone = os.path.join(alice, "bpa")
    _commit(clone, "file.txt", "good\n", "the good version")
    asyncio.run(bp_git.publish_main_from_clone(clone, "bpa"))
    good = _main_tip(env, "bpa")
    deployed[("bpa", "dev")] = [good]
    _advance_main(env, tmp_path, "bpa", ["broken\n"], label="the deploy that broke it")
    broken = _main_tip(env, "bpa")

    res = _as(OWNER, _revert_dev("bpa", commit=good, bp_label="Compost"))

    assert res.method == "restore"
    new_main = _main_tip(env, "bpa")
    # One new commit, on top of the broken one — nothing rewritten.
    assert (
        _git("-C", env["bares"]["bpa"], "rev-list", "--count", f"{broken}..{new_main}")
        .stdout.strip()
        .strip()
        == "1"
    )
    assert (
        _git(
            "-C",
            env["bares"]["bpa"],
            "merge-base",
            "--is-ancestor",
            broken,
            new_main,
            check=False,
        ).returncode
        == 0
    ), "the version that broke it is still reachable from main"
    # …and main's content is the good version again, byte for byte.
    assert _tree(env["bares"]["bpa"], new_main) == _tree(env["bares"]["bpa"], good)
    assert _read(os.path.join(env["copies_dir"], "main", "bpa", "file.txt")) == "good\n"


def test_the_revert_commit_names_the_process_the_date_and_the_version(
    env, tmp_path, deployed
):
    """Everyone else meets this commit in their Sync list, so it has to say what
    happened in words — the business process by its DISPLAY NAME, when the
    version was deployed, and which version it was."""
    alice = env["user_copy"]("alice")
    clone = os.path.join(alice, "bpa")
    _commit(clone, "file.txt", "good\n", "the good version")
    asyncio.run(bp_git.publish_main_from_clone(clone, "bpa"))
    good = _main_tip(env, "bpa")
    deployed[("bpa", "dev")] = [good]
    _advance_main(env, tmp_path, "bpa", ["broken\n"])

    res = _as(
        OWNER, _revert_dev("bpa", commit=good, bp_label="Compost", deployer=OWNER)
    )

    assert res.subject == (
        f"Revert Compost to the version deployed to dev on 2026-08-01 ({good[:7]})"
    )
    subject = _git(
        "-C", env["bares"]["bpa"], "log", "-1", "--format=%s", "refs/heads/main"
    ).stdout.strip()
    assert subject == res.subject
    author = _git(
        "-C", env["bares"]["bpa"], "log", "-1", "--format=%ae", "refs/heads/main"
    ).stdout.strip()
    assert author == OWNER, "a revert is attributed to the person who pressed it"


def test_a_dev_revert_puts_everyone_else_one_behind_and_their_sync_carries_it(
    env, tmp_path, deployed
):
    """THE CONSEQUENCE, and it is intended: dev is shared. After a revert every
    other copy is exactly one commit behind on that business process, and
    pulling brings the revert in with their own unpublished work replayed on
    top."""
    alice = env["user_copy"]("alice")
    bob = env["user_copy"]("bob", owner=OTHER)
    clone = os.path.join(alice, "bpa")
    _commit(clone, "file.txt", "good\n", "the good version")
    asyncio.run(bp_git.publish_main_from_clone(clone, "bpa"))
    good = _main_tip(env, "bpa")
    deployed[("bpa", "dev")] = [good]
    _advance_main(env, tmp_path, "bpa", ["broken\n"])
    _as(OTHER, lambda: copies.rebase_copy("bob", SyncCopyRequest(bp="bpa")))
    _commit(os.path.join(bob, "bpa"), "bobs.txt", "bob\n", "bob's own work")
    assert _ahead_behind(os.path.join(bob, "bpa"), env["bares"]["bpa"]) == (1, 0)

    _as(OWNER, _revert_dev("bpa", commit=good, bp_label="Compost"))

    assert _ahead_behind(os.path.join(bob, "bpa"), env["bares"]["bpa"]) == (1, 1)

    _as(
        OTHER,
        lambda: copies.rebase_copy("bob", SyncCopyRequest(bp="bpa", deployer=OTHER)),
    )
    assert _read(os.path.join(bob, "bpa", "file.txt")) == "good\n", "the revert arrived"
    assert _read(os.path.join(bob, "bpa", "bobs.txt")) == "bob\n", "his work survived"
    assert _ahead_behind(os.path.join(bob, "bpa"), env["bares"]["bpa"]) == (1, 0)


def test_reverting_dev_twice_adds_no_second_commit(env, tmp_path, deployed):
    """Idempotent. Dev already runs exactly this, so there is nothing to say."""
    alice = env["user_copy"]("alice")
    clone = os.path.join(alice, "bpa")
    _commit(clone, "file.txt", "good\n", "the good version")
    asyncio.run(bp_git.publish_main_from_clone(clone, "bpa"))
    good = _main_tip(env, "bpa")
    deployed[("bpa", "dev")] = [good]
    _advance_main(env, tmp_path, "bpa", ["broken\n"])

    _as(OWNER, _revert_dev("bpa", commit=good))
    after_first = _main_tip(env, "bpa")
    second = _as(OWNER, _revert_dev("bpa", commit=good))

    assert second.method == "already-main"
    assert _main_tip(env, "bpa") == after_first, "the repeat added no commit"


def test_only_a_version_dev_itself_ran_can_be_reverted_to(env, tmp_path, deployed):
    """Dev only. Staging and production go back by promote and rollback, which
    are gated differently — they must not be reachable through this door. And,
    as everywhere, an arbitrary sha is not a version."""
    alice = env["user_copy"]("alice")
    _commit(os.path.join(alice, "bpa"), "file.txt", "v1\n", "v1")
    asyncio.run(bp_git.publish_main_from_clone(os.path.join(alice, "bpa"), "bpa"))
    v1 = _main_tip(env, "bpa")
    _commit(os.path.join(alice, "bpb"), "file.txt", "b1\n", "b1")
    asyncio.run(bp_git.publish_main_from_clone(os.path.join(alice, "bpb"), "bpb"))
    b1 = _main_tip(env, "bpb")
    _advance_main(env, tmp_path, "bpa", ["v2\n"])
    before = _main_tip(env, "bpa")

    # Deployed — but to PRODUCTION, never to dev.
    deployed[("bpa", "production")] = [v1]
    deployed[("bpb", "dev")] = [b1]

    for commit, code in ((v1, 404), (b1, 404), ("0" * 40, 404), ("HEAD~1", 400)):
        with pytest.raises(HTTPException) as ei:
            _as(OWNER, _revert_dev("bpa", commit=commit))
        assert ei.value.status_code == code, commit
    assert "dev" in ei.value.detail or "commit id" in ei.value.detail
    assert _main_tip(env, "bpa") == before, "nothing moved through any of that"


def test_a_dev_revert_that_cannot_reproduce_the_version_changes_nothing(
    env, tmp_path, deployed, monkeypatch
):
    """Fail loudly, and leave main exactly where it was — a half-applied revert
    is a version nobody chose."""
    alice = env["user_copy"]("alice")
    clone = os.path.join(alice, "bpa")
    _commit(clone, "file.txt", "good\n", "the good version")
    asyncio.run(bp_git.publish_main_from_clone(clone, "bpa"))
    good = _main_tip(env, "bpa")
    deployed[("bpa", "dev")] = [good]
    _advance_main(env, tmp_path, "bpa", ["broken\n"])
    before = _main_tip(env, "bpa")

    real = copies.call_git_command_with_output

    async def _break_the_commit(*args, **kwargs):
        if "commit" in args and "-m" in args:
            return "", "disk on fire", 1
        return await real(*args, **kwargs)

    monkeypatch.setattr(copies, "call_git_command_with_output", _break_the_commit)

    with pytest.raises(HTTPException) as ei:
        _as(OWNER, _revert_dev("bpa", commit=good))
    assert ei.value.status_code == 500
    monkeypatch.undo()
    assert _main_tip(env, "bpa") == before
    assert (
        _read(os.path.join(env["copies_dir"], "main", "bpa", "file.txt")) == "broken\n"
    ), "main's checkout was put back too"


# ── publishing over main ────────────────────────────────────────────────────
#
# The second way out of a blocked Deploy. A specifically designed REBASE, not a
# snapshot: my commits are replayed onto main's tip and survive individually,
# main's own commits stay reachable underneath, and main's untouched additions
# are kept. The alternative — "make main exactly my version" — is the same
# restore-commit helper the adopts use, and it is a separate, explicit choice.


def _deploy_over(copy, **kw):
    from app.routes.copies import DeployOverMainRequest

    return lambda: copies.deploy_over_main(copy, DeployOverMainRequest(**kw))


def _main_and_mine_diverge(env, tmp_path, alice):
    """alice edits `shared.txt` her way; main edits the same line the other way
    AND adds a file alice never touched. The classic blocked Deploy."""
    clone = os.path.join(alice, "bpa")
    _commit(clone, "shared.txt", "base\n", "the shared file")
    asyncio.run(bp_git.publish_main_from_clone(clone, "bpa"))
    _commit(clone, "shared.txt", "MINE\n", "I change the shared file")
    _commit(clone, "mine-only.txt", "mine\n", "and add one of my own")

    other = tmp_path / "colleague"
    _git("clone", "-q", env["bares"]["bpa"], str(other))
    _commit(str(other), "shared.txt", "THEIRS\n", "a colleague changes the same line")
    _commit(str(other), "theirs-only.txt", "theirs\n", "and adds a file of their own")
    asyncio.run(bp_git.publish_main_from_clone(str(other), "bpa"))
    return clone


def test_publishing_over_main_resolves_conflicts_in_my_favour_not_mains(env, tmp_path):
    """WHOSE SIDE WINS, and the git incantation for it is the opposite of the
    intuition.

    A rebase checks out the UPSTREAM and replays your commits onto it, so
    during the replay "ours" is MAIN and "theirs" is the commit being replayed —
    mine. `-X ours` would therefore have published main's version of every
    conflicting line under a button that promised the opposite, and nothing
    but the file content would have shown it. This test is the proof: the
    conflicting line ends up as MINE, and specifically not as main's.
    """
    alice = env["user_copy"]("alice")
    _main_and_mine_diverge(env, tmp_path, alice)

    res = _as(OWNER, _deploy_over("alice", bp="bpa", mode="rebase", deployer=OWNER))

    assert res.status == "success" and res.method == "rebase"
    published = _git("-C", env["bares"]["bpa"], "show", "main:shared.txt").stdout
    assert published == "MINE\n"
    assert published != "THEIRS\n"


def test_publishing_over_main_keeps_what_main_added_and_i_never_touched(env, tmp_path):
    """ "Overwriting main" means my version wins where we both touched
    something — NOT that a colleague's unrelated file disappears. The dialog
    says so, so it had better be true."""
    alice = env["user_copy"]("alice")
    clone = _main_and_mine_diverge(env, tmp_path, alice)

    _as(OWNER, _deploy_over("alice", bp="bpa", mode="rebase", deployer=OWNER))

    assert (
        _git("-C", env["bares"]["bpa"], "show", "main:theirs-only.txt").stdout
        == "theirs\n"
    )
    assert _read(os.path.join(clone, "theirs-only.txt")) == "theirs\n"
    assert _read(os.path.join(clone, "mine-only.txt")) == "mine\n"


def test_publishing_over_main_keeps_my_commits_individually(env, tmp_path):
    """A rebase, not a squash. Discarding history nobody asked to discard is
    not something to do on a user's behalf, so each of my commits arrives on
    main as itself."""
    alice = env["user_copy"]("alice")
    _main_and_mine_diverge(env, tmp_path, alice)

    res = _as(OWNER, _deploy_over("alice", bp="bpa", mode="rebase", deployer=OWNER))

    subjects = [c["subject"] for c in res.replayed]
    assert subjects == [
        "and add one of my own",
        "I change the shared file",
    ], "both of my commits, each still itself"
    on_main = _git(
        "-C", env["bares"]["bpa"], "log", "-2", "--format=%s", "refs/heads/main"
    ).stdout.split("\n")
    assert on_main[:2] == subjects


def test_publishing_over_main_leaves_mains_own_commits_reachable(env, tmp_path):
    """Forward-only, like everything else that touches main: the colleague's
    commits are underneath mine, not gone."""
    alice = env["user_copy"]("alice")
    _main_and_mine_diverge(env, tmp_path, alice)
    main_before = _main_tip(env, "bpa")

    _as(OWNER, _deploy_over("alice", bp="bpa", mode="rebase", deployer=OWNER))

    assert (
        _git(
            "-C",
            env["bares"]["bpa"],
            "merge-base",
            "--is-ancestor",
            main_before,
            "refs/heads/main",
            check=False,
        ).returncode
        == 0
    )


def test_publishing_over_main_leaves_my_copy_level_with_main(env, tmp_path):
    """Afterwards there is nothing left to do: 0 ahead, 0 behind."""
    alice = env["user_copy"]("alice")
    clone = _main_and_mine_diverge(env, tmp_path, alice)

    _as(OWNER, _deploy_over("alice", bp="bpa", mode="rebase", deployer=OWNER))

    assert _ahead_behind(clone, env["bares"]["bpa"]) == (0, 0)
    assert _head(clone) == _main_tip(env, "bpa")
    assert _head(env["bares"]["bpa"], "refs/heads/alice") == _main_tip(env, "bpa")


def test_publishing_over_main_names_who_it_supersedes(env, tmp_path):
    """The confirm dialog is built from this: short sha, subject, and AUTHOR,
    because the commits being gone over are colleagues' work and a button that
    hides that cannot be consented to."""
    alice = env["user_copy"]("alice")
    _main_and_mine_diverge(env, tmp_path, alice)

    preview = asyncio.run(copies.get_deploy_over_main_preview("alice", bp="bpa"))

    assert preview["blocked"] is True
    assert [c["subject"] for c in preview["superseded"]] == [
        "and adds a file of their own",
        "a colleague changes the same line",
    ]
    assert all(c["author"] for c in preview["superseded"])
    assert [c["subject"] for c in preview["mine"]] == [
        "and add one of my own",
        "I change the shared file",
    ]
    assert preview["main"] == _main_tip(env, "bpa")


def test_publishing_over_main_refuses_when_main_moved_since_the_dialog(env, tmp_path):
    """The dialog named specific commits and their authors. If main moved after
    that, the user consented to superseding a different set of people's work —
    so this is a 409 and nothing is changed."""
    alice = env["user_copy"]("alice")
    clone = _main_and_mine_diverge(env, tmp_path, alice)
    stale = _head(clone)  # emphatically not main's tip
    before = _main_tip(env, "bpa")

    with pytest.raises(HTTPException) as ei:
        _as(
            OWNER,
            _deploy_over("alice", bp="bpa", mode="rebase", expected_main=stale),
        )

    assert ei.value.status_code == 409
    assert _main_tip(env, "bpa") == before
    assert _head(clone) == stale


def test_a_conflict_no_rule_can_decide_changes_nothing_at_all(env, tmp_path):
    """ "My side wins" is not an answer when one side DELETED the file and the
    other edited it — there is no hunk to prefer. So it aborts, changes nothing
    anywhere, and hands off to the coding agent exactly as a blocked Sync
    does."""
    alice = env["user_copy"]("alice")
    clone = os.path.join(alice, "bpa")
    _commit(clone, "shared.txt", "base\n", "the shared file")
    asyncio.run(bp_git.publish_main_from_clone(clone, "bpa"))
    _git("rm", "-q", "shared.txt", cwd=clone)
    _git("commit", "-qm", "I delete it", cwd=clone)
    mine_before = _head(clone)
    alice_ref_before = _head(env["bares"]["bpa"], "refs/heads/alice")

    other = tmp_path / "colleague"
    _git("clone", "-q", env["bares"]["bpa"], str(other))
    _commit(str(other), "shared.txt", "THEIRS\n", "a colleague edits it")
    asyncio.run(bp_git.publish_main_from_clone(str(other), "bpa"))
    main_before = _main_tip(env, "bpa")

    res = _as(OWNER, _deploy_over("alice", bp="bpa", mode="rebase", deployer=OWNER))

    assert res.status == "needs_rebase"
    assert "coding agent" in res.message
    assert _head(clone) == mine_before, "my copy is untouched"
    assert _main_tip(env, "bpa") == main_before, "main is untouched"
    assert _head(env["bares"]["bpa"], "refs/heads/alice") == alice_ref_before
    assert not os.path.isdir(os.path.join(clone, ".git", "rebase-merge"))
    assert not os.path.exists(os.path.join(clone, "shared.txt"))


def test_making_main_exactly_my_version_reproduces_my_tree_byte_for_byte(env, tmp_path):
    """The other option in the dialog, and it means what it says: main ends up
    holding exactly what my copy held — the colleague's untouched additions
    included in the loss."""
    alice = env["user_copy"]("alice")
    clone = _main_and_mine_diverge(env, tmp_path, alice)
    my_tree_before = _tree(clone)

    res = _as(OWNER, _deploy_over("alice", bp="bpa", mode="exact", deployer=OWNER))

    assert res.method == "exact"
    assert _tree(env["bares"]["bpa"], "refs/heads/main") == my_tree_before
    assert not os.path.exists(os.path.join(clone, "theirs-only.txt"))
    assert _ahead_behind(clone, env["bares"]["bpa"]) == (0, 0)
    # Still forward-only: one commit on top of what main had.
    assert (
        _git(
            "-C",
            env["bares"]["bpa"],
            "rev-list",
            "--count",
            f"{res.superseded[0]['sha']}..refs/heads/main",
        ).stdout.strip()
        == "1"
    )


def test_publishing_over_main_twice_is_an_ordinary_deploy_the_second_time(
    env, tmp_path
):
    """Nothing left to supersede, so it stops being the dangerous button and
    behaves as Deploy does."""
    alice = env["user_copy"]("alice")
    _main_and_mine_diverge(env, tmp_path, alice)
    _as(OWNER, _deploy_over("alice", bp="bpa", mode="rebase", deployer=OWNER))
    main_after_first = _main_tip(env, "bpa")

    second = _as(OWNER, _deploy_over("alice", bp="bpa", mode="rebase", deployer=OWNER))

    assert second.status == "success"
    assert second.method == "noop"
    assert second.superseded == []
    assert _main_tip(env, "bpa") == main_after_first


def test_publishing_over_main_requires_the_owner_and_refuses_an_experiment(env):
    env["user_copy"]("alice")
    env["experiment"]("exp-try-ab12", "alice", bps=["bpa"])

    with pytest.raises(HTTPException) as ei:
        _as(OTHER, _deploy_over("alice", bp="bpa"))
    assert ei.value.status_code == 403

    with pytest.raises(HTTPException) as ei:
        _as(OWNER, _deploy_over("exp-try-ab12", bp="bpa"))
    assert ei.value.status_code == 400
    assert "Experiments merge back" in ei.value.detail

    with pytest.raises(HTTPException) as ei:
        _as(OWNER, _deploy_over("alice", bp="bpa", mode="squash"))
    assert ei.value.status_code == 400
    assert "Invalid mode" in ei.value.detail


def test_publishing_over_main_touches_no_other_business_process(env, tmp_path):
    alice = env["user_copy"]("alice")
    _commit(os.path.join(alice, "bpb"), "file.txt", "my-bpb\n", "alice bpb")
    before = _git(
        "-C", env["bares"]["bpb"], "for-each-ref", "--format=%(refname) %(objectname)"
    ).stdout
    _main_and_mine_diverge(env, tmp_path, alice)

    _as(OWNER, _deploy_over("alice", bp="bpa", mode="rebase", deployer=OWNER))

    after = _git(
        "-C", env["bares"]["bpb"], "for-each-ref", "--format=%(refname) %(objectname)"
    ).stdout
    assert before == after


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
