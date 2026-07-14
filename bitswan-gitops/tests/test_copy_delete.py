"""Whole-copy delete: branch removal despite denyDeletes, per-copy DB drop
names, full teardown, and the remnant rule."""

import asyncio
import os
import subprocess

import pytest
import yaml

from app.services import bp_delete, bp_git, git_server
from app.services.automation_service import AutomationService

COPY = "alice"
BP = "letsgo"
LIVE_ID = f"backend-copy-{COPY}-{BP}-live-dev"


def _git(*args, cwd=None, check=True):
    env = dict(os.environ)
    for k, v in (
        ("GIT_AUTHOR_NAME", "t"),
        ("GIT_AUTHOR_EMAIL", "t@t"),
        ("GIT_COMMITTER_NAME", "t"),
        ("GIT_COMMITTER_EMAIL", "t@t"),
    ):
        env.setdefault(k, v)
    return subprocess.run(
        ["git", *args], cwd=cwd, env=env, capture_output=True, text=True, check=check
    )


@pytest.fixture()
def repos_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(git_server, "GIT_REPOS_DIR", str(tmp_path / "git"))
    monkeypatch.setattr(git_server, "HOOKS_SRC_DIR", str(tmp_path / "no-hooks"))
    return str(tmp_path / "git")


def test_delete_copy_branch_bypasses_deny_deletes(repos_dir):
    # A real bare repo with receive.denyDeletes=true + the pre-receive hook:
    # push-deleting a branch is forbidden, but the server-side update-ref -d
    # (the ONLY sanctioned copy-branch removal) must succeed.
    repo = asyncio.run(git_server.ensure_bp_bare_repo(BP))
    assert (
        _git("-C", repo, "config", "--get", "receive.denyDeletes").stdout.strip()
        == "true"
    )
    sha = _git("-C", repo, "rev-parse", "main").stdout.strip()
    _git("-C", repo, "update-ref", f"refs/heads/{COPY}", sha)

    assert asyncio.run(git_server.delete_copy_branch(BP, COPY)) is True
    gone = _git(
        "-C", repo, "show-ref", "--verify", "-q", f"refs/heads/{COPY}", check=False
    )
    assert gone.returncode != 0
    # Idempotent: a second delete is a no-op, not an error.
    assert asyncio.run(git_server.delete_copy_branch(BP, COPY)) is False


def test_delete_copy_branch_refuses_main(repos_dir):
    asyncio.run(git_server.ensure_bp_bare_repo(BP))
    with pytest.raises(ValueError):
        asyncio.run(git_server.delete_copy_branch(BP, "main"))


class _Container:
    def __init__(self, deployment_id, labels=None):
        self.id = f"cid-{deployment_id}"
        self.labels = {
            "gitops.deployment_id": deployment_id,
            "gitops.workspace": "ws",
            **(labels or {}),
        }
        self.state = "running"

    def to_docker_dict(self):
        return {"Id": self.id, "Labels": self.labels, "State": self.state}


class _FakeDriver:
    def __init__(self, containers):
        self.containers = containers
        self.removed: list[str] = []
        self.deploys: list[dict] = []

    async def container_list(self, ctx, labels=None):
        return [
            c
            for c in self.containers
            if all(c.labels.get(k) == v for k, v in (labels or {}).items())
        ]

    async def container_remove(self, ctx, cid):
        self.removed.append(cid)
        self.containers = [c for c in self.containers if c.id != cid]

    def deploy_remote_for_bp(self, bp):
        return f"driver://deploy/{bp}"

    async def ensure_deploy_repo(self, bp):
        return None

    async def deploy(self, **kwargs):
        self.deploys.append(kwargs)
        return []


def test_delete_copy_full_teardown(tmp_path, monkeypatch, repos_dir):
    entries = {
        LIVE_ID: {
            "automation_name": "backend",
            "context": f"copy-{COPY}-{BP}",
            "relative_path": f"copies/{COPY}/{BP}/backend",
            "stage": "live-dev",
        },
        "web-other-dev": {
            "automation_name": "web",
            "context": "other",
            "relative_path": "copies/main/other/web",
            "stage": "dev",
        },
    }
    (tmp_path / "bitswan.yaml").write_text(yaml.safe_dump({"deployments": entries}))
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))

    copies = tmp_path / "copies"
    clone = copies / COPY / BP
    (clone / ".git").mkdir(parents=True)
    (clone / "backend").mkdir()
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(copies))

    # Two bare repos: the cloned BP and one whose clone was removed from the
    # copy dir — its branch must STILL be deleted (branches outlive clones).
    for bp in (BP, "stale"):
        repo = asyncio.run(git_server.ensure_bp_bare_repo(bp))
        sha = _git("-C", repo, "rev-parse", "main").stdout.strip()
        _git("-C", repo, "update-ref", f"refs/heads/{COPY}", sha)

    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    svc.secrets_dir = str(tmp_path / "secrets-dir")
    svc.workspace_name = "ws"
    svc._infra_driver = _FakeDriver([_Container(LIVE_ID)])

    persisted: list[tuple[set, str]] = []

    async def _persist(bs_yaml, bps, target, action, deployed_by=None, message=None):
        persisted.append((set(bps), action))
        (tmp_path / "bitswan.yaml").write_text(yaml.safe_dump(bs_yaml))

    monkeypatch.setattr(svc, "_persist_bp_state", _persist)

    async def _no_root_rm(path):
        return False

    monkeypatch.setattr(bp_git, "_rm_rf_as_root_in_container", _no_root_rm)

    forgotten: list[str | None] = []

    async def _bcast(service, forget_copy=None):
        forgotten.append(forget_copy)

    monkeypatch.setattr(bp_delete, "_broadcast_all", _bcast)

    from app.services import bp_databases

    db_calls: list[tuple] = []

    async def _drop_copy(workspace, copy, slugs):
        db_calls.append((workspace, copy, tuple(slugs)))
        return {}

    monkeypatch.setattr(bp_databases, "drop_copy_bp_databases", _drop_copy)

    res = asyncio.run(bp_delete.delete_copy(COPY, "u@x", svc))
    assert res["status"] == "success"

    assert svc._infra_driver.removed == [f"cid-{LIVE_ID}"]
    assert persisted == [({BP}, "delete-copy")]
    left = yaml.safe_load((tmp_path / "bitswan.yaml").read_text())["deployments"]
    assert LIVE_ID not in left and "web-other-dev" in left
    assert any(
        d.get("deploy_remote") == f"driver://deploy/{BP}"
        for d in svc._infra_driver.deploys
    )
    assert db_calls == [("ws", COPY, (BP,))]
    # The branch is gone in BOTH repos, including the stale one.
    for bp in (BP, "stale"):
        repo = git_server.bp_bare_repo_path(bp)
        gone = _git(
            "-C",
            repo,
            "show-ref",
            "--verify",
            "-q",
            f"refs/heads/{COPY}",
            check=False,
        )
        assert gone.returncode != 0, bp
    assert not (copies / COPY).exists()
    assert forgotten == [COPY]


def test_copy_remnant_rule(tmp_path, monkeypatch, repos_dir):
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(tmp_path / "copies"))
    # Nothing anywhere → no remnants.
    assert asyncio.run(bp_delete.copy_has_remnants({}, COPY)) is False
    # A branch in a bare repo alone counts (clone + entries already gone).
    repo = asyncio.run(git_server.ensure_bp_bare_repo(BP))
    sha = _git("-C", repo, "rev-parse", "main").stdout.strip()
    _git("-C", repo, "update-ref", f"refs/heads/{COPY}", sha)
    assert asyncio.run(bp_delete.copy_has_remnants({}, COPY)) is True
