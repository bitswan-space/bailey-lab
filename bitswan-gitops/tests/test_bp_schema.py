"""Tests for the business_processes tree schema in bitswan.yaml: flat↔tree
round-trip (the hydration keystone) and the BP-level deploy record + history.

The actual image bake + `docker compose up` are exercised live; here we test the
schema/grouping/history logic with git writes stubbed.
"""

import asyncio

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


def test_write_bp_deploy_and_history(tmp_path, monkeypatch):
    """write_bp_deploy records the stage's shared commit + a history entry;
    bp_history reads it back with the current flag, and a second deploy prepends
    (newest-first)."""
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))

    async def _noop_update_git(*a, **k):
        return None

    monkeypatch.setattr(asvc, "update_git", _noop_update_git)

    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)

    # Seed a flat bitswan.yaml with the BP's dev deployments.
    with open(tmp_path / "bitswan.yaml", "w") as f:
        dump_bitswan_yaml(_flat_yaml(), f)

    members = [
        {
            "deployment_id": "backend-shop-dev",
            "image": "img:a",
            "image_id": "sha256:aaa",
        },
        {
            "deployment_id": "frontend-shop-dev",
            "image": "img:b",
            "image_id": "sha256:bbb",
        },
    ]
    asyncio.run(
        svc.write_bp_deploy(
            "shop", "dev", "commit-one", members, "tim@x", source="deploy"
        )
    )

    h = svc.bp_history("shop", "dev")
    assert h["current"] == "commit-one"
    assert len(h["history"]) == 1
    assert h["history"][0]["status"] == "deployed"
    assert set(h["history"][0]["members"].keys()) == {
        "backend-shop-dev",
        "frontend-shop-dev",
    }

    # A second deploy prepends (newest-first) and moves `current`.
    asyncio.run(
        svc.write_bp_deploy(
            "shop", "dev", "commit-two", members, "tim@x", source="deploy"
        )
    )
    h2 = svc.bp_history("shop", "dev")
    assert h2["current"] == "commit-two"
    assert [r["git_commit"] for r in h2["history"]] == ["commit-two", "commit-one"]

    # The deployments survived the metadata writes (still grouped, hydrated).
    bs = read_bitswan_yaml(str(tmp_path))
    assert "backend-shop-dev" in bs["deployments"]
