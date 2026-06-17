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


def test_bp_files_list_and_read(tmp_path, monkeypatch):
    copies = tmp_path / "copies"
    main = copies / "main"
    (main / "shop" / "backend").mkdir(parents=True)
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(copies))
    _git("init", "-q", cwd=str(main))
    _git("config", "user.email", "t@t", cwd=str(main))
    _git("config", "user.name", "t", cwd=str(main))
    (main / "shop" / "README.md").write_text("# shop\n")
    (main / "shop" / "backend" / "main.go").write_text("package main\n")
    _git("add", "-A", cwd=str(main))
    _git("commit", "-qm", "c1", cwd=str(main))
    sha = _git("rev-parse", "HEAD", cwd=str(main)).stdout.strip()

    svc = AutomationService()

    # Root listing of the BP.
    root = asyncio.run(svc.bp_files("shop", sha, ""))
    assert root["kind"] == "tree"
    names = {e["name"]: e["kind"] for e in root["entries"]}
    assert names == {"backend": "folder", "README.md": "file"}

    # Listing a subfolder.
    sub = asyncio.run(svc.bp_files("shop", sha, "backend"))
    assert [e["name"] for e in sub["entries"]] == ["main.go"]

    # Reading a file.
    f = asyncio.run(svc.bp_files("shop", sha, "README.md"))
    assert (
        f["kind"] == "file" and f["content"] == "# shop\n" and f["truncated"] is False
    )


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
