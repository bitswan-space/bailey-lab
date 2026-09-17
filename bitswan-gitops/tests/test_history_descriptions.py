import asyncio
import os
import subprocess

import yaml

from app.services import bp_git, git_server
from app.services.automation_service import AutomationService


def _git(*args, cwd=None):
    env = dict(os.environ)
    for k, v in {
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "dev@example.com",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "dev@example.com",
    }.items():
        env.setdefault(k, v)
    return subprocess.run(
        ["git", *args], cwd=cwd, env=env, capture_output=True, text=True, check=True
    ).stdout.strip()


def _svc(tmp_path):
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path / "gitops")
    svc.gitops_dir_host = str(tmp_path / "gitops")
    svc.secrets_dir = str(tmp_path / "secrets")
    return svc


def _publish(clone, bp, text, subject):
    with open(os.path.join(clone, "main.py"), "w") as f:
        f.write(text)
    _git("add", "-A", cwd=clone)
    _git("commit", "-qm", subject, cwd=clone)
    asyncio.run(bp_git.publish_main_from_clone(clone, bp))
    return _git("rev-parse", "HEAD", cwd=clone)


def _member(src):
    return {
        "automation_name": "backend",
        "relative_path": "copies/main/shop/backend",
        "image": f"internal/ws-shop-backend:{src[:8]}",
        "image_id": f"sha256:{src}",
        "source_commit": src,
        "active": True,
    }


class _StateRepo:
    def __init__(self, gitops_dir):
        self.path = os.path.join(gitops_dir, "bp", "shop")
        os.makedirs(self.path)
        _git("init", "-q", "-b", "main", cwd=self.path)
        self.stages: dict = {}

    def record(self, stage, src, source, subject=None):
        self.stages[stage] = {
            "git_commit": src,
            "deployments": {f"backend-shop-{stage}": _member(src)},
        }
        with open(os.path.join(self.path, "bitswan.yaml"), "w") as f:
            yaml.safe_dump({"business_processes": {"shop": self.stages}}, f)
        _git("add", "-A", cwd=self.path)
        _git(
            "commit",
            "-qm",
            subject or f"{source} shop → {stage} @ {src[:8]}",
            cwd=self.path,
        )


def test_history_entries_say_what_changed(tmp_path, monkeypatch):
    monkeypatch.setattr(git_server, "GIT_REPOS_DIR", str(tmp_path / "git"))
    monkeypatch.setattr(git_server, "HOOKS_SRC_DIR", str(tmp_path / "nohooks"))
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(tmp_path / "copies"))
    monkeypatch.delenv("BITSWAN_GIT_REMOTE", raising=False)
    svc = _svc(tmp_path)
    bare = asyncio.run(git_server.ensure_bp_bare_repo("shop"))
    clone = str(tmp_path / "clone")
    _git("clone", "-q", bare, clone)
    state = _StateRepo(svc.gitops_dir)

    first = _publish(clone, "shop", "v1\n", "Add invoice validation")
    state.record("dev", first, "deploy")
    second = _publish(clone, "shop", "v2\n", "Round totals to whole units")
    state.record("dev", second, "deploy")
    state.record("staging", second, "dev", "promote business process shop to staging")
    state.record("dev", first, "rollback")

    dev = asyncio.run(svc.bp_history("shop", "dev"))["history"]
    assert [e["summary"] for e in dev] == [
        f"Rolled back to {first[:8]} — Add invoice validation",
        f"Deployed {second[:8]} — Round totals to whole units",
        f"Deployed {first[:8]} — Add invoice validation",
    ]
    assert dev[1]["source_subject"] == "Round totals to whole units"
    assert dev[1]["subject"] == f"deploy shop → dev @ {second[:8]}"
    assert dev[0]["status"] == "rolled-back"

    staging = asyncio.run(svc.bp_history("shop", "staging"))["history"]
    assert staging[0]["summary"] == (
        f"Promoted from Development — Round totals to whole units"
    )


def test_a_version_the_repo_no_longer_has_still_gets_a_summary(tmp_path, monkeypatch):
    monkeypatch.setattr(git_server, "GIT_REPOS_DIR", str(tmp_path / "git"))
    svc = _svc(tmp_path)
    state = _StateRepo(svc.gitops_dir)
    state.record("dev", "0123456789abcdef0123456789abcdef01234567", "deploy")
    dev = asyncio.run(svc.bp_history("shop", "dev"))["history"]
    assert dev[0]["summary"] == "Deployed 01234567"
    assert dev[0]["source_subject"] is None
