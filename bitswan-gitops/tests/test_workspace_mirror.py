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


def _git(*args, cwd=None, check=True, author=None):
    env = dict(os.environ)
    env.setdefault("GIT_AUTHOR_NAME", "t")
    env.setdefault("GIT_AUTHOR_EMAIL", "t@t")
    env.setdefault("GIT_COMMITTER_NAME", "t")
    env.setdefault("GIT_COMMITTER_EMAIL", "t@t")
    if author:
        env["GIT_AUTHOR_NAME"] = author
        env["GIT_AUTHOR_EMAIL"] = author
    return subprocess.run(
        ["git", *args], cwd=cwd, env=env, capture_output=True, text=True, check=check
    )


def _out(*args, cwd=None):
    return _git(*args, cwd=cwd).stdout.strip()


def _commit(clone, rel, text, msg, author=None):
    path = os.path.join(clone, rel)
    os.makedirs(os.path.dirname(path) or clone, exist_ok=True)
    with open(path, "w") as f:
        f.write(text)
    _git("add", "-A", cwd=clone)
    _git("commit", "-qm", msg, cwd=clone, author=author)
    return _out("rev-parse", "HEAD", cwd=clone)


class _FakeService:
    def __init__(self, ws):
        self.gitops_dir = ws.gitops_dir
        self.secrets_dir = ws.secrets_dir


class Workspace:
    def __init__(self, tmp_path):
        self.tmp_path = tmp_path
        self.gitops_dir = str(tmp_path / "gitops")
        self.secrets_dir = str(tmp_path / "secrets")
        self.remote = str(tmp_path / "remote.git")
        _git("init", "-q", "--bare", "--initial-branch=main", self.remote)
        self.remote_url = f"file://{self.remote}"
        self.clones: dict[str, str] = {}

    def seed_bp(self, bp, text="v0\n"):
        bare = asyncio.run(git_server.ensure_bp_bare_repo(bp))
        clone = str(self.tmp_path / f"clone-{bp}")
        _git("clone", "-q", bare, clone)
        sha = _commit(clone, "main.py", text, f"seed {bp}")
        asyncio.run(bp_git.publish_main_from_clone(clone, bp))
        self.clones[bp] = clone
        self.write_state(bp, f"business_processes:\n  {bp}: {{}}\n")
        return sha

    def advance_bp(self, bp, text, msg="update", rel="main.py"):
        clone = self.clones[bp]
        _git(
            "pull",
            "-q",
            "--ff-only",
            git_server.bp_bare_repo_path(bp),
            "main",
            cwd=clone,
        )
        sha = _commit(clone, rel, text, msg)
        asyncio.run(bp_git.publish_main_from_clone(clone, bp))
        return sha

    def bp_main(self, bp):
        return _out("-C", git_server.bp_bare_repo_path(bp), "rev-parse", "main")

    def bp_show(self, bp, path):
        return _out("-C", git_server.bp_bare_repo_path(bp), "show", f"main:{path}")

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
        if not os.path.isdir(work):
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

    def configure(self, paused=False):
        remote_cfg.save_config(
            self.secrets_dir, self.remote_url, "admin@example.com", paused=paused
        )

    def run(self, trigger="test", requester="admin@example.com", force=False):
        return asyncio.run(mirror.run_mirror_sync(trigger, requester, force=force))

    def remote_clone(self, branch="main", name="foreign"):
        path = str(self.tmp_path / name)
        if os.path.isdir(path):
            _git("-C", path, "pull", "-q", "--ff-only")
            return path
        _git("clone", "-q", "--branch", branch, self.remote_url, path)
        return path

    def remote_out(self, *args):
        return _out("-C", self.remote, *args)

    def mirror_out(self, *args):
        return _out("-C", mirror.mirror_path(), *args)


@pytest.fixture()
def ws(tmp_path, monkeypatch):
    monkeypatch.setattr(git_server, "GIT_REPOS_DIR", str(tmp_path / "git"))
    monkeypatch.setattr(
        git_server, "HOOKS_SRC_DIR", str(tmp_path / "nonexistent-hooks")
    )
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(tmp_path / "copies"))
    monkeypatch.setenv("BITSWAN_WORKSPACE_NAME", "finance")
    monkeypatch.setenv("BITSWAN_GITOPS_DOMAIN", "example.test")
    monkeypatch.delenv("BITSWAN_GIT_REMOTE", raising=False)
    monkeypatch.setattr(remote_cfg, "ALLOW_LOCAL_REMOTES", True)
    mirror.reset_for_tests()
    w = Workspace(tmp_path)
    monkeypatch.setattr(mirror, "_service", lambda: _FakeService(w))
    w.seed_bp("bpa", "a0\n")
    w.seed_bp("bpb", "b0\n")
    yield w
    mirror.reset_for_tests()


def test_mirror_repo_is_hidden_from_bp_listing_and_not_pushable(ws):
    asyncio.run(mirror.ensure_mirror_repo())
    assert git_server.list_bp_repos() == ["bpa", "bpb"]
    assert ws.mirror_out("config", "http.receivepack") == "false"


def test_first_run_pushes_main_with_one_folder_per_bp_a_readme_and_gitops(ws):
    ws.configure()
    status = ws.run()
    assert status["result"] == "ok"
    assert status["branches"]["main"]["result"] == "pushed"
    assert status["branches"]["gitops"]["result"] == "pushed"
    assert ws.remote_out(
        "for-each-ref", "--format=%(refname)", "refs/heads"
    ).split() == [
        "refs/heads/gitops",
        "refs/heads/main",
    ]
    assert ws.remote_out("ls-tree", "--name-only", "main").split() == [
        "README.md",
        "bpa",
        "bpb",
    ]
    assert ws.remote_out("show", "main:bpa/main.py") == "a0"
    readme = ws.remote_out("show", "main:README.md")
    assert "fast-forward" in readme
    assert "https://finance-dashboard.example.test" in readme
    assert "support@bitswan.ai" in readme
    assert ws.remote_out("ls-tree", "--name-only", "gitops").split() == ["bpa", "bpb"]
    assert "business_processes" in ws.remote_out("show", "gitops:bpa/bitswan.yaml")
    assert ws.bp_main("bpa") in ws.remote_out("rev-list", "main").split()


def test_unconfigured_and_paused_runs_do_nothing(ws):
    status = ws.run()
    assert status["result"] == "unconfigured"
    assert not os.path.exists(mirror.mirror_path())
    ws.configure(paused=True)
    status = ws.run()
    assert status["result"] == "paused"
    assert status["paused"] is True
    assert not os.path.exists(mirror.mirror_path())


def test_second_run_is_up_to_date_and_local_changes_fast_forward_main(ws):
    ws.configure()
    ws.run()
    first = ws.remote_out("rev-parse", "main")
    status = ws.run()
    assert status["branches"]["main"]["result"] == "up_to_date"
    assert ws.remote_out("rev-parse", "main") == first

    new_a = ws.advance_bp("bpa", "a1\n")
    status = ws.run()
    assert status["branches"]["main"]["result"] == "pushed"
    assert ws.remote_out("show", "main:bpa/main.py") == "a1"
    assert ws.remote_out("log", "-1", "--format=%P", "main").split() == [first, new_a]
    assert (
        ws.remote_out("log", "-1", "--format=%s", "main")
        == f"Mirror main: bpa → {new_a[:7]} (+1 unchanged)"
    )


def test_commits_added_on_the_remote_are_pulled_into_the_bp_main(ws):
    ws.configure()
    ws.run()
    before = ws.bp_main("bpa")
    clone = ws.remote_clone()
    foreign = _commit(
        clone,
        "bpa/notes.md",
        "edited on github\n",
        "Add notes",
        author="reviewer@example.com",
    )
    _git("push", "-q", "origin", "main", cwd=clone)

    status = ws.run(trigger="deploy-check", requester="member@example.com")
    assert status["result"] == "inbound"
    assert status["inbound"] == ["bpa"]
    assert status["branches"]["main"]["result"] == "up_to_date"
    after = ws.bp_main("bpa")
    assert after != before
    assert ws.bp_show("bpa", "notes.md") == "edited on github"
    assert ws.bp_show("bpa", "main.py") == "a0"
    assert (
        _out(
            "-C",
            git_server.bp_bare_repo_path("bpa"),
            "log",
            "-1",
            "--format=%P",
            "main",
        )
        == before
    )
    assert _out(
        "-C",
        git_server.bp_bare_repo_path("bpa"),
        "log",
        "-1",
        "--format=%an|%s",
        "main",
    ) == ("reviewer@example.com|Pulled from local: Add notes")
    assert ws.bp_main("bpb") == ws.bp_main("bpb")
    assert ws.mirror_out("rev-parse", "main") == foreign
    assert ws.remote_out("rev-parse", "main") == foreign


def test_remote_and_local_changes_to_different_files_are_merged(ws):
    ws.configure()
    ws.run()
    clone = ws.remote_clone()
    _commit(clone, "bpa/notes.md", "remote\n", "remote notes")
    _git("push", "-q", "origin", "main", cwd=clone)
    local = ws.advance_bp("bpa", "a1\n")

    status = ws.run()
    assert status["result"] == "inbound"
    assert ws.bp_show("bpa", "notes.md") == "remote"
    assert ws.bp_show("bpa", "main.py") == "a1"
    parents = _out(
        "-C", git_server.bp_bare_repo_path("bpa"), "log", "-1", "--format=%P", "main"
    ).split()
    assert parents == [local]
    assert ws.remote_out("show", "main:bpa/main.py") == "a1"
    assert ws.remote_out("show", "main:bpa/notes.md") == "remote"
    assert status["branches"]["main"]["result"] == "pushed"


def test_conflicting_remote_change_is_reported_and_not_pushed(ws):
    ws.configure()
    ws.run()
    clone = ws.remote_clone()
    foreign = _commit(clone, "bpa/main.py", "remote edit\n", "remote edit")
    _git("push", "-q", "origin", "main", cwd=clone)
    ws.advance_bp("bpa", "local edit\n")

    status = ws.run()
    assert status["result"] == "conflict"
    assert status["conflicts"] == ["bpa"]
    assert status["branches"]["main"]["result"] == "conflict"
    assert ws.bp_show("bpa", "main.py") == "local edit"
    assert ws.remote_out("rev-parse", "main") == foreign
    assert status["branches"]["gitops"]["result"] == "up_to_date"


def test_rewritten_remote_main_is_diverged_until_force_pushed(ws):
    ws.configure()
    ws.run()
    clone = ws.remote_clone()
    _git("checkout", "-q", "--orphan", "rewrite", cwd=clone)
    _commit(clone, "unrelated.txt", "x\n", "history rewritten")
    _git("push", "-q", "--force", "origin", "rewrite:main", cwd=clone)
    rewritten = ws.remote_out("rev-parse", "main")

    status = ws.run()
    assert status["result"] == "diverged"
    assert status["branches"]["main"]["result"] == "diverged"
    assert status["branches"]["main"]["remote"] == rewritten
    assert ws.remote_out("rev-parse", "main") == rewritten

    status = ws.run(trigger="repair", force=True)
    assert status["result"] == "ok"
    assert status["branches"]["main"]["result"] == "pushed"
    assert ws.remote_out("rev-parse", "main") == ws.mirror_out("rev-parse", "main")
    assert ws.remote_out("ls-tree", "--name-only", "main").split() == [
        "README.md",
        "bpa",
        "bpb",
    ]


def test_remote_root_files_and_readme_edits_are_kept(ws):
    _git("clone", "-q", ws.remote_url, str(ws.tmp_path / "init"))
    init = str(ws.tmp_path / "init")
    _commit(init, "README.md", "my own readme\n", "init")
    _commit(init, "LICENSE", "MIT\n", "license")
    _git("push", "-q", "origin", "HEAD:main", cwd=init)
    ws.configure()
    status = ws.run()
    assert status["result"] == "ok"
    assert ws.remote_out("ls-tree", "--name-only", "main").split() == [
        "LICENSE",
        "README.md",
        "bpa",
        "bpb",
    ]
    assert ws.remote_out("show", "main:README.md") == "my own readme"
    assert ws.remote_out("show", "main:LICENSE") == "MIT"


def test_unknown_remote_folders_are_left_alone_with_a_warning(ws):
    ws.configure()
    ws.run()
    clone = ws.remote_clone()
    _commit(clone, "stranger/file.txt", "x\n", "stranger")
    _git("push", "-q", "origin", "main", cwd=clone)
    status = ws.run()
    assert status["result"] == "ok"
    assert any("stranger/" in w for w in status["warnings"])
    assert git_server.list_bp_repos() == ["bpa", "bpb"]
    assert ws.remote_out("show", "main:stranger/file.txt") == "x"


def test_deleted_bp_leaves_main_but_its_history_stays(ws):
    ws.configure()
    ws.run()
    old_b = ws.bp_main("bpb")
    first = ws.mirror_out("rev-parse", "main")
    assert git_server.delete_bp_bare_repo("bpb")
    status = ws.run()
    assert status["result"] == "ok"
    assert ws.remote_out("ls-tree", "--name-only", "main").split() == [
        "README.md",
        "bpa",
    ]
    assert old_b in ws.remote_out("rev-list", first).split()
    assert "removed bpb" in ws.remote_out("log", "-1", "--format=%s", "main")


def test_deploy_tags_are_namespaced_per_bp(ws):
    ws.tag_deploy(
        "bpa", "1700000000", "alice@example.com deployed 2023-11-14 22:13 UTC"
    )
    ws.configure()
    status = ws.run()
    assert status["tags"]["created"] == 1
    assert status["tags"]["pushed"] == 1
    assert ws.remote_out(
        "for-each-ref", "--format=%(refname)", "refs/tags/"
    ).split() == ["refs/tags/deploy/bpa/1700000000"]
    assert "alice@example.com deployed" in ws.remote_out(
        "tag", "-l", "-n1", "deploy/bpa/1700000000"
    )


def test_commit_identity_is_the_requester_or_bailey(ws):
    ws.configure()
    ws.run(requester="alice@example.com", trigger="deploy-state")
    assert ws.remote_out("log", "-1", "--format=%an <%ae>|%cn <%ce>", "main") == (
        "alice@example.com <alice@example.com>|alice@example.com <alice@example.com>"
    )
    assert "Bitswan-Trigger: deploy-state" in ws.remote_out(
        "log", "-1", "--format=%b", "main"
    )
    ws.advance_bp("bpa", "a1\n")
    ws.run(requester=None, trigger="schedule")
    assert (
        ws.remote_out("log", "-1", "--format=%an <%ae>", "main")
        == "Bailey <bailey@bitswan>"
    )


def test_status_is_recorded_privately_and_errors_are_raised(ws, monkeypatch):
    ws.configure()
    status = ws.run()
    saved = remote_cfg.load_status(ws.secrets_dir)
    assert saved["result"] == "ok"
    assert saved["last_success_at"] == status["last_attempt_at"]
    status_file = os.path.join(
        remote_cfg.remote_dir(ws.secrets_dir), remote_cfg.STATUS_FILE
    )
    assert stat.S_IMODE(os.stat(status_file).st_mode) == 0o600

    monkeypatch.setattr(mirror, "LS_REMOTE_TIMEOUT_S", 20)
    remote_cfg.save_config(
        ws.secrets_dir, f"file://{ws.tmp_path}/missing.git", "admin@example.com"
    )
    with pytest.raises(mirror.MirrorError):
        ws.run()
    saved = remote_cfg.load_status(ws.secrets_dir)
    assert saved["result"] == "error"
    assert "cannot reach remote" in saved["error"]
    assert saved["last_success_at"] == status["last_attempt_at"]


def test_request_push_is_a_no_op_without_a_remote_or_when_paused(ws):
    async def go():
        return mirror.request_push("deploy-state", "alice@example.com", immediate=True)

    assert asyncio.run(go()) is None
    ws.configure(paused=True)
    assert asyncio.run(go()) is None


def test_request_push_coalesces_queued_work_and_debounces_events(ws, monkeypatch):
    monkeypatch.setattr(mirror, "DEBOUNCE_S", 0.05)
    queue = TaskQueue()
    monkeypatch.setattr(mirror, "task_queue", queue)
    ws.configure()
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


def test_run_inline_holds_the_queue_turn_and_returns_the_status(ws, monkeypatch):
    queue = TaskQueue()
    monkeypatch.setattr(mirror, "task_queue", queue)
    ws.configure()

    async def go():
        status = await mirror.run_inline("deploy-check", "member@example.com")
        await asyncio.sleep(0.1)
        kinds = [(t["kind"], t["status"]) for t in queue.snapshot()]
        return status, kinds

    status, kinds = asyncio.run(go())
    assert status["result"] == "ok"
    assert kinds == [(mirror.TASK_KIND, "completed")]


def test_copy_branches_are_read_only_mirrors_overwritten_and_removed(ws):
    ws.configure()
    ws.push_copy_branch("bpa", "alice", "alice-a\n")
    ws.push_copy_branch("bpb", "alice", "alice-b\n")
    ws.push_copy_branch("bpa", "exp-1", "experiment\n")
    status = ws.run()
    assert status["result"] == "ok"
    assert status["branches"]["copies/alice"]["result"] == "pushed"
    assert status["branches"]["copies/exp-1"]["result"] == "pushed"
    assert ws.remote_out("ls-tree", "--name-only", "copies/alice").split() == [
        "bpa",
        "bpb",
    ]
    assert ws.remote_out("ls-tree", "--name-only", "copies/exp-1").split() == ["bpa"]
    assert ws.remote_out("show", "copies/alice:bpa/main.py") == "alice-a"
    assert ws.remote_out("ls-tree", "--name-only", "main").split() == [
        "README.md",
        "bpa",
        "bpb",
    ]

    clone = ws.remote_clone(branch="copies/alice", name="alice-remote")
    _commit(clone, "bpa/stray.txt", "committed on the remote\n", "stray commit")
    _git("push", "-q", "origin", "HEAD:copies/alice", cwd=clone)
    ws.push_copy_branch("bpa", "alice", "alice-a2\n")
    status = ws.run()
    assert status["result"] == "ok"
    assert status["branches"]["copies/alice"]["result"] == "pushed"
    assert ws.remote_out("show", "copies/alice:bpa/main.py") == "alice-a2"
    assert (
        _git(
            "-C", ws.remote, "cat-file", "-e", "copies/alice:bpa/stray.txt", check=False
        ).returncode
        != 0
    )
    assert ws.remote_out("rev-parse", "main") == ws.mirror_out("rev-parse", "main")

    asyncio.run(git_server.delete_copy_branch("bpa", "exp-1"))
    status = ws.run()
    assert status["branches"]["copies/exp-1"]["result"] == "deleted"
    heads = ws.remote_out("for-each-ref", "--format=%(refname)", "refs/heads").split()
    assert "refs/heads/copies/exp-1" not in heads
    assert "refs/heads/copies/alice" in heads
    status = ws.run()
    assert status["branches"]["copies/alice"]["result"] == "up_to_date"
    assert "copies/exp-1" not in status["branches"]
