import asyncio
import os
import stat
import subprocess

import pytest

from app.services import bp_git, git_server
from app.services import workspace_git_remote as remote_cfg
from app.services import workspace_mirror as mirror
from app.task_queue import TaskQueue, current_requester
from app.utils import ensure_bp_state_repo


def _git(*args, cwd=None, check=True):
    env = dict(os.environ)
    env.setdefault("GIT_AUTHOR_NAME", "t")
    env.setdefault("GIT_AUTHOR_EMAIL", "t@t")
    env.setdefault("GIT_COMMITTER_NAME", "t")
    env.setdefault("GIT_COMMITTER_EMAIL", "t@t")
    return subprocess.run(
        ["git", *args], cwd=cwd, env=env, capture_output=True, text=True, check=check
    )


def _out(*args, cwd=None):
    return _git(*args, cwd=cwd).stdout.strip()


def _commit(clone, rel, text, msg):
    path = os.path.join(clone, rel)
    os.makedirs(os.path.dirname(path) or clone, exist_ok=True)
    with open(path, "w") as f:
        f.write(text)
    _git("add", "-A", cwd=clone)
    _git("commit", "-qm", msg, cwd=clone)
    return _out("rev-parse", "HEAD", cwd=clone)


class Workspace:
    def __init__(self, tmp_path):
        self.tmp_path = tmp_path
        self.gitops_dir = str(tmp_path / "gitops")
        self.secrets_dir = str(tmp_path / "secrets")
        self.remote = str(tmp_path / "remote.git")
        _git("init", "-q", "--bare", "--initial-branch=main", self.remote)
        self.remote_url = f"file://{self.remote}"
        self.stage_commits: dict[tuple[str, str], str] = {}
        self.clones: dict[str, str] = {}

    def stage_commit(self, bp, stage):
        return self.stage_commits.get((bp, stage))

    def seed_bp(self, bp, text="v0\n", with_state=True):
        bare = asyncio.run(git_server.ensure_bp_bare_repo(bp))
        clone = str(self.tmp_path / f"clone-{bp}")
        _git("clone", "-q", bare, clone)
        sha = _commit(clone, "main.py", text, f"seed {bp}")
        asyncio.run(bp_git.publish_main_from_clone(clone, bp))
        self.clones[bp] = clone
        if with_state:
            self.write_state(bp, f"business_processes:\n  {bp}: {{}}\n")
        return sha

    def advance_bp(self, bp, text, msg="update"):
        clone = self.clones[bp]
        sha = _commit(clone, "main.py", text, msg)
        asyncio.run(bp_git.publish_main_from_clone(clone, bp))
        return sha

    def write_state(self, bp, yaml_text):
        asyncio.run(ensure_bp_state_repo(self.gitops_dir, bp))
        state = os.path.join(self.gitops_dir, "bp", bp)
        with open(os.path.join(state, "bitswan.yaml"), "w") as f:
            f.write(yaml_text)
        _git("add", "-A", cwd=state)
        _git("commit", "-qm", f"deploy {bp}", cwd=state)
        return _out("rev-parse", "HEAD", cwd=state)

    def push_copy_branch(self, bp, copy, text):
        bare = git_server.bp_bare_repo_path(bp)
        work = str(self.tmp_path / f"copy-{copy}-{bp}")
        _git("clone", "-q", bare, work)
        _git("checkout", "-qb", copy, cwd=work)
        sha = _commit(work, "main.py", text, f"{copy} work on {bp}")
        _git("push", "-q", bare, f"HEAD:refs/heads/{copy}", cwd=work)
        return sha

    def tag_deploy(self, bp, ts, subject):
        bare = git_server.bp_bare_repo_path(bp)
        _git(
            "-c",
            "user.name=Bailey",
            "-c",
            "user.email=bailey@bitswan",
            "-C",
            bare,
            "tag",
            "-a",
            "-f",
            f"deploy/{ts}",
            "-m",
            subject,
            "refs/heads/main",
        )

    def sync(self, requester=None, trigger="test"):
        return asyncio.run(
            mirror.sync_mirror(
                gitops_dir=self.gitops_dir,
                stage_commit=self.stage_commit,
                requester=requester,
                trigger=trigger,
            )
        )

    def push(self, requester=None, trigger="test"):
        synced = self.sync(requester, trigger)
        return synced, asyncio.run(
            mirror.push_mirror(
                self.remote_url, {}, synced["heads"], synced["deletions"]
            )
        )

    def mirror_out(self, *args):
        return _out("-C", mirror.mirror_path(), *args)

    def remote_out(self, *args):
        return _out("-C", self.remote, *args)


@pytest.fixture()
def ws(tmp_path, monkeypatch):
    monkeypatch.setattr(git_server, "GIT_REPOS_DIR", str(tmp_path / "git"))
    monkeypatch.setattr(
        git_server, "HOOKS_SRC_DIR", str(tmp_path / "nonexistent-hooks")
    )
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(tmp_path / "copies"))
    monkeypatch.delenv("BITSWAN_GIT_REMOTE", raising=False)
    monkeypatch.setattr(remote_cfg, "ALLOW_LOCAL_REMOTES", True)
    mirror.reset_for_tests()
    w = Workspace(tmp_path)
    w.seed_bp("bpa", "a0\n")
    w.seed_bp("bpb", "b0\n")
    yield w
    mirror.reset_for_tests()


def test_mirror_repo_is_bare_hidden_from_bp_listing_and_not_pushable(ws):
    asyncio.run(mirror.ensure_mirror_repo())
    assert os.path.isdir(os.path.join(mirror.mirror_path(), "objects"))
    assert git_server.list_bp_repos() == ["bpa", "bpb"]
    assert ws.mirror_out("config", "http.receivepack") == "false"


def test_dev_branch_holds_one_folder_per_bp_from_main(ws):
    ws.sync()
    assert ws.mirror_out("ls-tree", "--name-only", "dev").split() == ["bpa", "bpb"]
    assert ws.mirror_out("show", "dev:bpa/main.py") == "a0"
    assert ws.mirror_out("show", "dev:bpb/main.py") == "b0"


def test_seed_only_bp_is_left_out_until_it_has_content(ws):
    asyncio.run(git_server.ensure_bp_bare_repo("empty"))
    ws.sync()
    assert ws.mirror_out("ls-tree", "--name-only", "dev").split() == ["bpa", "bpb"]


def test_staging_uses_the_recorded_stage_commit_not_main(ws):
    old = ws.advance_bp("bpa", "a1\n")
    ws.stage_commits[("bpa", "staging")] = old
    ws.advance_bp("bpa", "a2\n")
    ws.sync()
    assert ws.mirror_out("show", "dev:bpa/main.py") == "a2"
    assert ws.mirror_out("show", "staging:bpa/main.py") == "a1"
    assert ws.mirror_out("ls-tree", "--name-only", "staging").split() == ["bpa"]
    assert (
        _git(
            "-C",
            mirror.mirror_path(),
            "rev-parse",
            "--verify",
            "-q",
            "refs/heads/production",
            check=False,
        ).returncode
        != 0
    )


def test_composite_parents_keep_bp_history_reachable(ws):
    ws.sync()
    main_a = _out("-C", git_server.bp_bare_repo_path("bpa"), "rev-parse", "main")
    main_b = _out("-C", git_server.bp_bare_repo_path("bpb"), "rev-parse", "main")
    reachable = ws.mirror_out("rev-list", "dev").split()
    assert main_a in reachable and main_b in reachable

    first = ws.mirror_out("rev-parse", "dev")
    new_a = ws.advance_bp("bpa", "a1\n")
    ws.sync()
    second = ws.mirror_out("rev-parse", "dev")
    parents = ws.mirror_out("log", "-1", "--format=%P", second).split()
    assert parents == [first, new_a]
    assert (
        ws.mirror_out("log", "-1", "--format=%s", second)
        == "Mirror dev: bpa → " + new_a[:7] + " (+1 unchanged)"
    )


def test_nothing_changes_when_the_tree_is_unchanged(ws):
    ws.sync()
    before = ws.mirror_out("rev-parse", "dev")
    ws.sync()
    assert ws.mirror_out("rev-parse", "dev") == before


def test_gitops_branch_holds_each_bp_manifest_repo(ws):
    state_a = ws.write_state(
        "bpa", "business_processes:\n  bpa:\n    dev: {git_commit: abc}\n"
    )
    ws.sync()
    assert ws.mirror_out("ls-tree", "--name-only", "gitops").split() == ["bpa", "bpb"]
    assert "git_commit: abc" in ws.mirror_out("show", "gitops:bpa/bitswan.yaml")
    assert state_a in ws.mirror_out("rev-list", "gitops").split()


def test_copy_branches_are_mirrored_and_deleted_when_the_copy_goes_away(ws):
    ws.push_copy_branch("bpa", "alice", "alice-a\n")
    ws.push_copy_branch("bpb", "alice", "alice-b\n")
    ws.push_copy_branch("bpa", "exp-1", "experiment\n")
    synced, pushed = ws.push()
    assert ws.mirror_out("ls-tree", "--name-only", "copies/alice").split() == [
        "bpa",
        "bpb",
    ]
    assert ws.mirror_out("ls-tree", "--name-only", "copies/exp-1").split() == ["bpa"]
    assert ws.mirror_out("show", "copies/alice:bpa/main.py") == "alice-a"
    assert pushed["branches"]["copies/alice"]["result"] == "pushed"
    assert "refs/heads/copies/exp-1" in ws.remote_out(
        "for-each-ref", "--format=%(refname)"
    )

    asyncio.run(git_server.delete_copy_branch("bpa", "exp-1"))
    synced, pushed = ws.push()
    assert synced["deletions"] == ["copies/exp-1"]
    assert pushed["branches"]["copies/exp-1"]["result"] == "deleted"
    assert "refs/heads/copies/exp-1" not in ws.remote_out(
        "for-each-ref", "--format=%(refname)"
    )
    assert "refs/heads/copies/alice" in ws.remote_out(
        "for-each-ref", "--format=%(refname)"
    )


def test_deleted_bp_leaves_the_stage_tree_but_its_history_stays(ws):
    ws.sync()
    old_b = _out("-C", git_server.bp_bare_repo_path("bpb"), "rev-parse", "main")
    first = ws.mirror_out("rev-parse", "dev")
    assert git_server.delete_bp_bare_repo("bpb")
    ws.sync()
    assert ws.mirror_out("ls-tree", "--name-only", "dev").split() == ["bpa"]
    assert _git("-C", mirror.mirror_path(), "cat-file", "-e", old_b).returncode == 0
    assert old_b in ws.mirror_out("rev-list", first).split()
    assert "removed bpb" in ws.mirror_out("log", "-1", "--format=%s", "dev")


def test_missing_stage_commit_keeps_the_previous_tree_and_warns(ws):
    good = ws.advance_bp("bpa", "a1\n")
    ws.stage_commits[("bpa", "staging")] = good
    ws.sync()
    ws.stage_commits[("bpa", "staging")] = "deadbeef" * 5
    synced = ws.sync()
    assert ws.mirror_out("show", "staging:bpa/main.py") == "a1"
    assert any(
        w.startswith("bpa/staging: commit deadbeef") and "kept" in w
        for w in synced["warnings"]
    )


def test_deploy_tags_are_namespaced_per_bp_with_their_subject(ws):
    ws.tag_deploy(
        "bpa", "1700000000", "alice@example.com deployed 2023-11-14 22:13 UTC"
    )
    ws.tag_deploy("bpb", "1700000000", "bob@example.com deployed 2023-11-14 22:13 UTC")
    synced, pushed = ws.push()
    assert synced["tags"] == {"created": 2, "existing": 0}
    assert ws.mirror_out("cat-file", "-t", "refs/tags/deploy/bpa/1700000000") == "tag"
    assert "alice@example.com deployed" in ws.mirror_out(
        "tag", "-l", "-n1", "deploy/bpa/1700000000"
    )
    assert pushed["tags"]["pushed"] == 2
    remote_tags = ws.remote_out(
        "for-each-ref", "--format=%(refname)", "refs/tags/"
    ).split()
    assert remote_tags == [
        "refs/tags/deploy/bpa/1700000000",
        "refs/tags/deploy/bpb/1700000000",
    ]


def test_commit_identity_is_the_requester_or_bailey_with_trailers(ws):
    ws.sync(requester="alice@example.com", trigger="deploy-state")
    assert ws.mirror_out("log", "-1", "--format=%an <%ae>|%cn <%ce>", "dev") == (
        "alice@example.com <alice@example.com>|alice@example.com <alice@example.com>"
    )
    body = ws.mirror_out("log", "-1", "--format=%b", "dev")
    assert "Bitswan-Trigger: deploy-state" in body
    assert "Bitswan-Requester: alice@example.com" in body
    ws.advance_bp("bpa", "a1\n")
    ws.sync(requester=None, trigger="schedule")
    assert (
        ws.mirror_out("log", "-1", "--format=%an <%ae>", "dev")
        == "Bailey <bailey@bitswan>"
    )


def test_first_push_creates_every_branch_and_the_second_is_up_to_date(ws):
    ws.stage_commits[("bpa", "production")] = ws.advance_bp("bpa", "a1\n")
    synced, pushed = ws.push()
    assert pushed["result"] == "ok"
    assert {b: r["result"] for b, r in pushed["branches"].items()} == {
        "dev": "pushed",
        "production": "pushed",
        "gitops": "pushed",
    }
    assert ws.remote_out("rev-parse", "dev") == ws.mirror_out("rev-parse", "dev")
    assert ws.remote_out("ls-tree", "--name-only", "production").split() == ["bpa"]

    synced, pushed = ws.push()
    assert pushed["result"] == "ok"
    assert all(r["result"] == "up_to_date" for r in pushed["branches"].values())


def test_foreign_commits_on_the_remote_are_reported_not_overwritten(ws):
    ws.push()
    foreign_clone = str(ws.tmp_path / "foreign")
    _git("clone", "-q", "--branch", "dev", ws.remote_url, foreign_clone)
    foreign = _commit(
        foreign_clone, "bpa/notes.txt", "edited on github\n", "foreign edit"
    )
    _git("push", "-q", "origin", "dev", cwd=foreign_clone)

    ws.advance_bp("bpa", "a1\n")
    ws.write_state("bpa", "business_processes:\n  bpa:\n    dev: {git_commit: a1}\n")
    synced, pushed = ws.push()
    assert pushed["result"] == "diverged"
    assert pushed["branches"]["dev"]["result"] == "diverged"
    assert pushed["branches"]["dev"]["remote"] == foreign
    assert ws.remote_out("rev-parse", "dev") == foreign
    assert pushed["branches"]["gitops"]["result"] == "pushed"


def test_unreachable_remote_is_an_error_with_the_reason(ws, monkeypatch):
    monkeypatch.setattr(mirror, "LS_REMOTE_TIMEOUT_S", 20)
    synced = ws.sync()
    pushed = asyncio.run(
        mirror.push_mirror(
            f"file://{ws.tmp_path}/does-not-exist.git", {}, synced["heads"], []
        )
    )
    assert pushed["result"] == "error"
    assert "cannot reach remote" in pushed["error"]


class _FakeService:
    def __init__(self, ws):
        self.gitops_dir = ws.gitops_dir
        self.secrets_dir = ws.secrets_dir


def test_run_mirror_push_records_status_and_skips_when_unconfigured(ws, monkeypatch):
    monkeypatch.setattr(mirror, "_service", lambda: _FakeService(ws))
    status = asyncio.run(mirror.run_mirror_push("schedule", None))
    assert status["result"] == "unconfigured"
    assert not os.path.exists(mirror.mirror_path())

    remote_cfg.save_config(ws.secrets_dir, ws.remote_url, "admin@example.com")
    status = asyncio.run(mirror.run_mirror_push("configure", "admin@example.com"))
    assert status["result"] == "ok"
    assert status["last_success_at"] == status["last_attempt_at"]
    assert status["branches"]["dev"]["result"] == "pushed"
    assert status["trigger"] == "configure"
    saved = remote_cfg.load_status(ws.secrets_dir)
    assert saved["branches"]["gitops"]["result"] == "pushed"
    status_file = os.path.join(
        remote_cfg.remote_dir(ws.secrets_dir), remote_cfg.STATUS_FILE
    )
    assert stat.S_IMODE(os.stat(status_file).st_mode) == 0o600
    assert os.path.isfile(remote_cfg.private_key_path(ws.secrets_dir))


def test_run_mirror_push_failure_is_recorded_and_raised(ws, monkeypatch):
    monkeypatch.setattr(mirror, "_service", lambda: _FakeService(ws))
    monkeypatch.setattr(mirror, "LS_REMOTE_TIMEOUT_S", 20)
    remote_cfg.save_config(
        ws.secrets_dir, f"file://{ws.tmp_path}/missing.git", "admin@example.com"
    )
    with pytest.raises(mirror.MirrorError):
        asyncio.run(mirror.run_mirror_push("manual", "admin@example.com"))
    saved = remote_cfg.load_status(ws.secrets_dir)
    assert saved["result"] == "error"
    assert saved["last_success_at"] is None
    assert "cannot reach remote" in saved["error"]


def test_request_push_is_a_no_op_without_a_remote(ws, monkeypatch):
    monkeypatch.setattr(mirror, "_service", lambda: _FakeService(ws))

    async def go():
        return mirror.request_push("deploy-state", "alice@example.com", immediate=True)

    assert asyncio.run(go()) is None


def test_request_push_coalesces_queued_work_and_debounces_events(ws, monkeypatch):
    monkeypatch.setattr(mirror, "_service", lambda: _FakeService(ws))
    monkeypatch.setattr(mirror, "DEBOUNCE_S", 0.05)
    queue = TaskQueue()
    monkeypatch.setattr(mirror, "task_queue", queue)
    remote_cfg.save_config(ws.secrets_dir, ws.remote_url, "admin@example.com")
    runs: list[tuple[str, str | None]] = []

    async def fake_run(trigger, requester):
        runs.append((trigger, requester))
        return {}

    monkeypatch.setattr(mirror, "run_mirror_push", fake_run)

    async def scenario():
        gate = asyncio.Event()

        async def blocker():
            await gate.wait()

        queue.submit("blocker", blocker)
        await asyncio.sleep(0.02)
        first = mirror.request_push("manual", "admin@example.com", immediate=True)
        second = mirror.request_push("manual", "admin@example.com", immediate=True)
        assert first == second
        assert [t["kind"] for t in queue.snapshot() if t["status"] == "queued"] == [
            mirror.TASK_KIND
        ]

        gate.set()
        for _ in range(100):
            await asyncio.sleep(0.01)
            if runs:
                break
        assert runs == [("manual", "admin@example.com")]

        current_requester.set("bob@example.com")
        assert mirror.request_push("deploy-state") is None
        assert mirror.request_push("deploy-state") is None
        await asyncio.sleep(0.3)
        assert runs == [
            ("manual", "admin@example.com"),
            ("deploy-state", "bob@example.com"),
        ]

    asyncio.run(scenario())
