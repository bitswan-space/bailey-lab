"""Tests for the business_processes tree schema in bitswan.yaml: flat↔tree
round-trip (the hydration keystone) and the BP-level deploy record + history.

The actual image bake + `docker compose up` are exercised live; here we test the
schema/grouping/history logic with git writes stubbed.
"""

import asyncio
import os
import subprocess

from app.utils import read_bitswan_yaml, dump_bitswan_yaml
from app.services import automation_service as asvc
from app.services.automation_service import AutomationService


def _flat_yaml():
    return {
        "deployments": {
            "backend-shop-dev": {
                "stage": "dev",
                "context": "shop",
                "automation_name": "backend",
                "relative_path": "copies/main/shop/backend",
                "image": "internal/ws-shop-backend-app:sha111",
                "image_id": "sha256:aaa",
                "source_commit": "c0ffee1234",
            },
            "frontend-shop-dev": {
                "stage": "dev",
                "context": "shop",
                "automation_name": "frontend",
                "image": "internal/ws-shop-frontend-app:sha222",
                "image_id": "sha256:bbb",
                "source_commit": "c0ffee1234",
            },
            "backend-shop": {  # production (stage "")
                "stage": "",
                "context": "shop",
                "automation_name": "backend",
                "image": "internal/ws-shop-backend-app:sha111",
                "image_id": "sha256:aaa",
            },
        },
        "secrets": {"keep": "me"},
    }


def test_flat_tree_round_trip(tmp_path):
    """dump (flat→tree) then read (tree→flat) preserves the deployments, groups
    them under business_processes[bp][stage], and keeps other top-level keys."""
    path = tmp_path / "bitswan.yaml"
    with open(path, "w") as f:
        dump_bitswan_yaml(_flat_yaml(), f)

    # On disk: the tree, no flat deployments key.
    import yaml

    raw = yaml.safe_load(open(path))
    assert "deployments" not in raw
    bps = raw["business_processes"]
    assert set(bps["shop"].keys()) == {"dev", "production"}
    assert set(bps["shop"]["dev"]["deployments"].keys()) == {
        "backend-shop-dev",
        "frontend-shop-dev",
    }
    assert set(bps["shop"]["production"]["deployments"].keys()) == {"backend-shop"}
    assert raw["secrets"] == {"keep": "me"}  # untouched

    # Read back: flat view is hydrated, stage canonicalised ("" for production).
    bs = read_bitswan_yaml(str(tmp_path))
    deps = bs["deployments"]
    assert set(deps.keys()) == {
        "backend-shop-dev",
        "frontend-shop-dev",
        "backend-shop",
    }
    assert deps["backend-shop-dev"]["image_id"] == "sha256:aaa"
    assert deps["backend-shop"]["stage"] == ""  # production hydrates back to ""
    assert deps["backend-shop-dev"]["stage"] == "dev"


def _git(*args, cwd, env_extra=None, capture=False):
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_COMMITTER_NAME="t")
    env.update(env_extra or {})
    return subprocess.run(
        ["git", *args], cwd=cwd, env=env, check=True, capture_output=capture, text=True
    )


def test_bp_diff(tmp_path, monkeypatch):
    """bp_diff returns the unified diff of a BP's source between two commits.
    Per-BP layout: each BP is its own repo, so the diff runs inside the BP's
    clone at copies/main/<bp> (copies/main itself is no longer a repo), and the
    paths are BP-relative (no bp/ prefix)."""
    repos = tmp_path / "git"
    copies = tmp_path / "copies"
    repos.mkdir(parents=True)
    (copies / "main").mkdir(parents=True)
    monkeypatch.setenv("BITSWAN_GIT_REPOS_DIR", str(repos))
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(copies))
    bare = repos / "shop.git"
    _git("init", "-q", "--bare", "--initial-branch=main", str(bare), cwd=str(tmp_path))
    clone = copies / "main" / "shop"
    _git("clone", "-q", str(bare), str(clone), cwd=str(tmp_path))
    _git("config", "user.email", "t@t", cwd=str(clone))
    _git("config", "user.name", "t", cwd=str(clone))
    (clone / "f.txt").write_text("v1\n")
    _git("add", "-A", cwd=str(clone))
    _git("commit", "-qm", "c1", cwd=str(clone))
    _git("push", "-q", "origin", "HEAD:refs/heads/main", cwd=str(clone))
    sha1 = _git("rev-parse", "HEAD", cwd=str(clone), capture=True).stdout.strip()
    (clone / "f.txt").write_text("v2\n")
    _git("add", "-A", cwd=str(clone))
    _git("commit", "-qm", "c2", cwd=str(clone))
    _git("push", "-q", "origin", "HEAD:refs/heads/main", cwd=str(clone))
    sha2 = _git("rev-parse", "HEAD", cwd=str(clone), capture=True).stdout.strip()

    svc = AutomationService()
    r = asyncio.run(svc.bp_diff("shop", sha1, sha2))
    assert "+v2" in r["diff"] and "-v1" in r["diff"]
    assert "f.txt" in r["diff"]


def test_write_bp_deploy_sets_only_commit_no_history(tmp_path, monkeypatch):
    """write_bp_deploy stamps the node's shared git_commit and stores NO history
    array in bitswan.yaml — git is the history source of truth."""

    async def _noop_update_git(*a, **k):
        return None

    monkeypatch.setattr(asvc, "update_git", _noop_update_git)
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    with open(tmp_path / "bitswan.yaml", "w") as f:
        dump_bitswan_yaml(_flat_yaml(), f)

    # In a real deploy/promote the node's git_commit equals the deployed
    # members' source_commit (both are the deployed source version) — here the
    # fixture's shop/dev members carry "c0ffee1234", so that is what surfaces on
    # the node (the deployed source is the single source of truth for history).
    asyncio.run(
        svc.write_bp_deploy("shop", "dev", "c0ffee1234", [], "tim@x", source="deploy")
    )

    import yaml

    raw = yaml.safe_load(open(tmp_path / "bitswan.yaml"))
    node = raw["business_processes"]["shop"]["dev"]
    assert node["git_commit"] == "c0ffee1234"
    assert "history" not in node  # history lives in git, not the file
    assert "deployed_at" not in node and "deployed_by" not in node


def test_bp_history_from_git_log(tmp_path):
    """bp_history is derived from the git log of bitswan.yaml: one entry per
    distinct BP-stage state, newest-first, with the current marker."""
    import os as _os

    _os.environ.pop("BITSWAN_COPIES_DIR", None)
    repo = tmp_path
    _git("init", "-q", cwd=str(repo))
    _git("config", "user.email", "t@t", cwd=str(repo))
    _git("config", "user.name", "t", cwd=str(repo))

    def commit_state(src_commit, msg, author="dev@x", marker=None):
        bs = {
            "business_processes": {
                "shop": {
                    "dev": {
                        "git_commit": src_commit,
                        "deployments": {
                            "backend-shop-dev": {
                                "image": f"img:{src_commit}",
                                "image_id": f"sha256:{src_commit}",
                            }
                        },
                    }
                }
            }
        }
        if marker is not None:
            # An unrelated change to the file that leaves shop/dev untouched.
            bs["_marker"] = marker
        import yaml

        with open(repo / "bitswan.yaml", "w") as f:
            yaml.dump(bs, f)
        _git("add", "bitswan.yaml", cwd=str(repo))
        _git(
            "commit",
            "-q",
            "-m",
            msg,
            cwd=str(repo),
            env_extra={"GIT_AUTHOR_EMAIL": author, "GIT_COMMITTER_EMAIL": author},
        )

    commit_state("aaaaaaaa", "deploy shop → dev @ aaaaaaaa")
    commit_state("aaaaaaaa", "unrelated edit", marker="x")  # shop/dev unchanged
    commit_state("bbbbbbbb", "deploy shop → dev @ bbbbbbbb")
    commit_state("aaaaaaaa", "rollback shop → dev @ aaaaaaaa")

    svc = AutomationService()
    svc.gitops_dir = str(repo)
    svc.gitops_dir_host = str(repo)

    h = asyncio.run(svc.bp_history("shop", "dev"))
    srcs = [e["source_commit"] for e in h["history"]]
    # Newest-first; the dup "unrelated edit" collapsed; rollback is its own entry.
    assert srcs == ["aaaaaaaa", "bbbbbbbb", "aaaaaaaa"]
    assert h["history"][0]["status"] == "rolled-back"
    assert h["history"][0]["source"] == "rollback"
    assert h["history"][1]["status"] == "deployed"
    # `current` is the newest event commit, and only it is the live one.
    assert h["current"] == h["history"][0]["commit"]
