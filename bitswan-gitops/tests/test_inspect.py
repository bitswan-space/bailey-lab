"""Tests for the Inspect-modal backend: bp_files (git-backed source browse at a
commit) and scale_business_process (scale all of a BP stage's members). The
bundle (docker save + pg_dump) is exercised live."""

import asyncio
import os
import subprocess

from app.utils import dump_bitswan_yaml
from app.services import automation_service as asvc
from app.services.automation_service import AutomationService


def _git(*args, cwd):
    env = dict(
        os.environ,
        GIT_AUTHOR_NAME="t",
        GIT_AUTHOR_EMAIL="t@t",
        GIT_COMMITTER_NAME="t",
        GIT_COMMITTER_EMAIL="t@t",
    )
    return subprocess.run(
        ["git", *args], cwd=cwd, env=env, check=True, capture_output=True, text=True
    )


def _setup_bp_repo(tmp_path, monkeypatch, bp="shop"):
    """Build the per-BP layout the Inspect backend now expects: a bare repo at
    BITSWAN_GIT_REPOS_DIR/<bp>.git and its clone at copies/main/<bp> (copies/main
    itself is NOT a repo anymore). Returns the clone path."""
    repos = tmp_path / "git"
    copies = tmp_path / "copies"
    repos.mkdir(parents=True, exist_ok=True)
    (copies / "main").mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("BITSWAN_GIT_REPOS_DIR", str(repos))
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(copies))
    bare = repos / f"{bp}.git"
    _git("init", "-q", "--bare", "--initial-branch=main", str(bare), cwd=str(tmp_path))
    clone = copies / "main" / bp
    _git("clone", "-q", str(bare), str(clone), cwd=str(tmp_path))
    _git("config", "user.email", "t@t", cwd=str(clone))
    _git("config", "user.name", "t", cwd=str(clone))
    return clone


def _commit_push(clone, message):
    _git("add", "-A", cwd=str(clone))
    _git("commit", "-qm", message, cwd=str(clone))
    # main is deploy-only on a real bare (pre-receive hook), but this test bare
    # has no hook — push straight to main so fetch_main can see the commit.
    _git("push", "-q", "origin", "HEAD:refs/heads/main", cwd=str(clone))
    return _git("rev-parse", "HEAD", cwd=str(clone)).stdout.strip()


def test_bp_files_list_and_read(tmp_path, monkeypatch):
    clone = _setup_bp_repo(tmp_path, monkeypatch)
    (clone / "backend").mkdir(parents=True)
    (clone / "README.md").write_text("# shop\n")
    (clone / "backend" / "main.go").write_text("package main\n")
    sha = _commit_push(clone, "c1")

    svc = AutomationService()

    # Full recursive tree of the BP, nested folders-before-files. Paths are
    # BP-relative (the clone IS the BP repo — no bp/ prefix).
    tree = asyncio.run(svc.bp_file_tree("shop", sha))
    entries = tree["entries"]
    names = {e["name"]: e["kind"] for e in entries}
    assert names == {"backend": "folder", "README.md": "file"}
    backend = next(e for e in entries if e["name"] == "backend")
    assert backend["children"][0]["name"] == "main.go"
    assert backend["children"][0]["path"] == "backend/main.go"

    # Reading a file at the deployed commit.
    f = asyncio.run(svc.bp_file_content("shop", sha, "README.md"))
    assert f["content"] == "# shop\n" and f["truncated"] is False

    # A nested file resolves too.
    g = asyncio.run(svc.bp_file_content("shop", sha, "backend/main.go"))
    assert g["content"] == "package main\n"


def test_bp_diff_between_two_deploys(tmp_path, monkeypatch):
    """Inspect → "Diff vs current": diffing a prior deploy's source commit
    against the current one must surface the change (the e2e history chapter).
    Regression guard for the per-BP layout — the diff runs inside the BP's own
    clone in copies/main, not the (now non-repo) copies/main root."""
    clone = _setup_bp_repo(tmp_path, monkeypatch)
    (clone / "README.md").write_text("# shop v1\n")
    v1 = _commit_push(clone, "v1")
    (clone / "README.md").write_text("# shop v1\n\nManager approval tier (v2)\n")
    v2 = _commit_push(clone, "v2")

    svc = AutomationService()
    res = asyncio.run(svc.bp_diff("shop", v1, v2))
    assert "Manager approval tier (v2)" in res["diff"], res
    assert res["from"] == v1 and res["to"] == v2

    # A no-op diff (same commit) is genuinely empty, not an error.
    same = asyncio.run(svc.bp_diff("shop", v2, v2))
    assert same["diff"] == ""


def test_scale_business_process_scales_all_members(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    bs = {
        "deployments": {
            "backend-shop-dev": {
                "stage": "dev",
                "context": "shop",
                "image_id": "sha256:a",
            },
            "frontend-shop-dev": {
                "stage": "dev",
                "context": "shop",
                "image_id": "sha256:b",
            },
        }
    }
    with open(tmp_path / "bitswan.yaml", "w") as f:
        dump_bitswan_yaml(bs, f)

    calls = []

    async def _fake_scale(self, deployment_id, replicas):
        calls.append((deployment_id, replicas))
        return {"status": "success", "replicas": replicas}

    monkeypatch.setattr(asvc.AutomationService, "scale_automation", _fake_scale)

    res = asyncio.run(svc.scale_business_process("shop", "dev", 3))
    assert res["replicas"] == 3
    assert set(res["members"]) == {"backend-shop-dev", "frontend-shop-dev"}
    assert sorted(calls) == [("backend-shop-dev", 3), ("frontend-shop-dev", 3)]
