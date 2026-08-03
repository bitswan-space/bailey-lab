"""#314 — a rollback is scoped to ONE stage, and a wake never lies.

Reproduction from the issue: with two deployment-history entries in development
and one in staging, rolling development back put the STAGING deployment to sleep
and it could not be woken again.

Mechanism: a BP's deploy state is ONE bitswan.yaml (its own git repo) holding
EVERY stage — dev, staging, production, plus each copy's live-dev context. The
rollback restored that whole file at the target revision, so a development
rollback to a commit predating the staging promote deleted staging's deployment
entries. The driver compiles the pushed file wholesale, so staging disappeared
from the desired compose: its containers were retired as orphans and its ingress
route pruned. And because nothing was left in bitswan.yaml to re-activate, the
wake found no members and returned an empty success — "Asleep, unable to wake".

These tests pin both halves: the restore only ever touches the target stage's
slice, and a wake that cannot do anything raises instead of reporting success.
"""

import asyncio
import os
import subprocess

import pytest
import yaml
from fastapi import HTTPException

from app.services.automation_service import AutomationService
from app.utils import read_bitswan_yaml


def _svc(tmp_path):
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    svc.secrets_dir = str(tmp_path / "secrets")
    svc.workspace_name = "ws"
    return svc


def _git(*args, cwd, capture=False):
    env = dict(
        os.environ,
        GIT_AUTHOR_NAME="t",
        GIT_AUTHOR_EMAIL="t@t",
        GIT_COMMITTER_NAME="t",
        GIT_COMMITTER_EMAIL="t@t",
    )
    return subprocess.run(
        ["git", *args], cwd=cwd, env=env, check=True, capture_output=capture, text=True
    )


def _member(name, src):
    return {
        "automation_name": name,
        "relative_path": f"copies/main/shop/{name}",
        "image": f"internal/ws-shop-{name}:{src}",
        "image_id": f"sha256:{src}",
        "source_commit": src,
        "active": True,
    }


def _state(dev_src=None, staging_src=None):
    """The BP's raw (tree-form) bitswan.yaml with the given stages deployed."""
    stages = {}
    if dev_src:
        stages["dev"] = {
            "git_commit": dev_src,
            "deployments": {"backend-shop-dev": _member("backend", dev_src)},
        }
    if staging_src:
        stages["staging"] = {
            "git_commit": staging_src,
            "deployments": {"backend-shop-staging": _member("backend", staging_src)},
        }
    return {"business_processes": {"shop": stages}}


def _repo(tmp_path):
    """The BP's own deploy repo at <gitops>/bp/shop (empty, initialised)."""
    repo = tmp_path / "bp" / "shop"
    repo.mkdir(parents=True)
    _git("init", "-q", "-b", "main", cwd=str(repo))
    return repo


def _commit(repo, state, msg):
    with open(repo / "bitswan.yaml", "w") as f:
        yaml.dump(state, f)
    _git("add", "bitswan.yaml", cwd=str(repo))
    _git("commit", "-q", "-m", msg, cwd=str(repo))
    return _git("rev-parse", "HEAD", cwd=str(repo), capture=True).stdout.strip()


def _capture_apply(svc, monkeypatch):
    """Stand in for the driver push; records which deployments were re-applied."""
    applied: list[list[str]] = []

    async def _apply(deployment_ids, deployed_by=None, report=None):
        applied.append(sorted(deployment_ids))
        return {"deployment_ids": list(deployment_ids)}

    monkeypatch.setattr(svc, "apply_compose_for_deployments", _apply)
    return applied


def _raw(tmp_path):
    return yaml.safe_load(open(tmp_path / "bp" / "shop" / "bitswan.yaml"))


def _history_setup(tmp_path):
    """The issue's starting state: dev deployed twice, then promoted to staging."""
    repo = _repo(tmp_path)
    dev_a = _commit(repo, _state(dev_src="aaaaaaaa"), "deploy shop → dev @ aaaaaaaa")
    _commit(repo, _state(dev_src="bbbbbbbb"), "deploy shop → dev @ bbbbbbbb")
    promoted = _commit(
        repo,
        _state(dev_src="bbbbbbbb", staging_src="bbbbbbbb"),
        "promote shop → staging @ bbbbbbbb",
    )
    return dev_a, promoted


def test_dev_rollback_leaves_staging_deployed(tmp_path, monkeypatch):
    """The issue's exact reproduction: rolling development back to the older of
    its two history entries must revert DEVELOPMENT ONLY. Staging's deploy entry
    (and therefore its containers, its ingress route and its wakeability) must
    survive untouched."""
    svc = _svc(tmp_path)
    applied = _capture_apply(svc, monkeypatch)
    dev_a, promoted = _history_setup(tmp_path)

    res = asyncio.run(
        svc.rollback_business_process("shop", "dev", dev_a, deployed_by="a@x")
    )

    # Only development was re-applied — the rollback is not a whole-BP redeploy.
    assert res["deployment_ids"] == ["backend-shop-dev"]
    assert applied == [["backend-shop-dev"]]
    assert res["git_commit"] == "aaaaaaaa"

    raw = _raw(tmp_path)["business_processes"]["shop"]
    # Development is back at the older version…
    dev = raw["dev"]["deployments"]["backend-shop-dev"]
    assert dev["image_id"] == "sha256:aaaaaaaa"
    assert raw["dev"]["git_commit"] == "aaaaaaaa"
    # …and staging is byte-identical to before the rollback: still declared, still
    # at its promoted version, still active (this is what used to be wiped).
    assert "staging" in raw, raw
    staging = raw["staging"]["deployments"]["backend-shop-staging"]
    assert staging["image_id"] == "sha256:bbbbbbbb"
    assert staging.get("active") is not False
    assert raw["staging"]["git_commit"] == "bbbbbbbb"

    # The flat view the compiler/driver reads agrees: staging is still deployed.
    flat = (read_bitswan_yaml(str(tmp_path)) or {}).get("deployments") or {}
    assert "backend-shop-staging" in flat
    assert flat["backend-shop-staging"]["stage"] == "staging"

    # Staging's own timeline is untouched — no new entry, same current version.
    h_staging = asyncio.run(svc.bp_history("shop", "staging"))
    assert [e["source_commit"] for e in h_staging["history"]] == ["bbbbbbbb"]
    assert h_staging["current"] == promoted
    # Development's timeline records the rollback as its newest entry.
    h_dev = asyncio.run(svc.bp_history("shop", "dev"))
    assert h_dev["history"][0]["status"] == "rolled-back"
    assert h_dev["history"][0]["source_commit"] == "aaaaaaaa"
    assert h_dev["current"] == h_dev["history"][0]["commit"]


def test_rollback_drops_members_added_after_the_target_within_the_stage(
    tmp_path, monkeypatch
):
    """Scoping must not become "never remove anything": a member that only exists
    in the CURRENT development deployment is still rolled away, because it is in
    the target stage."""
    svc = _svc(tmp_path)
    _capture_apply(svc, monkeypatch)
    repo = _repo(tmp_path)
    dev_a = _commit(repo, _state(dev_src="aaaaaaaa"), "deploy shop → dev @ aaaaaaaa")
    two = _state(dev_src="bbbbbbbb", staging_src="bbbbbbbb")
    two["business_processes"]["shop"]["dev"]["deployments"]["frontend-shop-dev"] = (
        _member("frontend", "bbbbbbbb")
    )
    _commit(repo, two, "deploy shop → dev @ bbbbbbbb")

    asyncio.run(svc.rollback_business_process("shop", "dev", dev_a, deployed_by="a@x"))

    raw = _raw(tmp_path)["business_processes"]["shop"]
    assert set(raw["dev"]["deployments"]) == {"backend-shop-dev"}
    assert set(raw["staging"]["deployments"]) == {"backend-shop-staging"}


def test_rollback_to_revision_without_that_stage_is_rejected(tmp_path, monkeypatch):
    """A commit that holds no state for the requested stage is not a rollback
    point for it — say so instead of silently deleting the stage."""
    svc = _svc(tmp_path)
    applied = _capture_apply(svc, monkeypatch)
    dev_a, _ = _history_setup(tmp_path)
    before = _raw(tmp_path)

    with pytest.raises(HTTPException) as ei:
        asyncio.run(
            svc.rollback_business_process("shop", "staging", dev_a, deployed_by="a@x")
        )
    assert ei.value.status_code == 400
    assert "staging" in ei.value.detail
    assert applied == []
    assert _raw(tmp_path) == before  # nothing written


def test_unknown_revision_still_404s(tmp_path, monkeypatch):
    svc = _svc(tmp_path)
    _capture_apply(svc, monkeypatch)
    _history_setup(tmp_path)
    with pytest.raises(HTTPException) as ei:
        asyncio.run(svc.rollback_business_process("shop", "dev", "deadbeef" * 5, "a@x"))
    assert ei.value.status_code == 404


def test_dev_rollback_keeps_other_stages_secrets(tmp_path, monkeypatch):
    """Secrets are per-realm in the same file. A development rollback restores the
    DEV realm only — staging's (and production's) secrets are not collateral."""
    svc = _svc(tmp_path)
    _capture_apply(svc, monkeypatch)

    asyncio.run(svc.write_bp_secrets("shop", {"dev": {"K": "dev1"}}, deployed_by="a@x"))
    h = asyncio.run(svc.bp_history("shop", "dev"))
    first = [e for e in h["history"] if e["source"] == "secret"][0]["commit"]
    asyncio.run(
        svc.write_bp_secrets(
            "shop", {"dev": {"K": "dev2"}, "staging": {"K": "stg1"}}, deployed_by="a@x"
        )
    )

    asyncio.run(svc.rollback_business_process("shop", "dev", first, deployed_by="a@x"))

    secrets = svc.read_bp_secrets("shop")
    assert secrets["dev"]["K"] == "dev1"  # the dev realm rolled back…
    assert secrets["staging"]["K"] == "stg1"  # …staging's is still there


# ── waking a slept stage ────────────────────────────────────────────────────


def test_slept_staging_can_be_woken(tmp_path, monkeypatch):
    """Second half of the report: a staging deployment that IS asleep (its members
    marked inactive + containers removed) must come back — re-activated in
    bitswan.yaml and redeployed — without touching development."""
    svc = _svc(tmp_path)
    applied = _capture_apply(svc, monkeypatch)
    repo = _repo(tmp_path)
    slept = _state(dev_src="bbbbbbbb", staging_src="bbbbbbbb")
    slept["business_processes"]["shop"]["staging"]["deployments"][
        "backend-shop-staging"
    ]["active"] = False
    _commit(repo, slept, "sleep shop/staging")

    res = asyncio.run(svc.wake_context_stage("shop", "staging"))

    assert res["deployment_ids"] == ["backend-shop-staging"]
    assert applied == [["backend-shop-staging"]]
    raw = _raw(tmp_path)["business_processes"]["shop"]
    assert raw["staging"]["deployments"]["backend-shop-staging"]["active"] is True
    assert raw["dev"]["deployments"]["backend-shop-dev"]["active"] is True


def test_wake_with_nothing_to_wake_fails_loudly(tmp_path, monkeypatch):
    """A wake with no deploy entries for the group cannot do anything. It must
    raise — an empty 200 made the dashboard toast "Staging woken" while staging
    stayed down, which is how #314's second symptom hid."""
    svc = _svc(tmp_path)
    applied = _capture_apply(svc, monkeypatch)
    repo = _repo(tmp_path)
    _commit(repo, _state(dev_src="bbbbbbbb"), "deploy shop → dev @ bbbbbbbb")

    with pytest.raises(HTTPException) as ei:
        asyncio.run(svc.wake_context_stage("shop", "staging"))
    assert ei.value.status_code == 404
    assert "staging" in ei.value.detail
    assert applied == []


def test_wake_surfaces_a_failed_redeploy(tmp_path, monkeypatch):
    """A wake whose redeploy fails leaves the stage asleep, so the failure must
    reach the caller rather than being logged and reported as success."""
    svc = _svc(tmp_path)
    repo = _repo(tmp_path)
    _commit(repo, _state(staging_src="bbbbbbbb"), "promote shop → staging @ bbbbbbbb")

    async def _boom(deployment_ids, deployed_by=None, report=None):
        raise RuntimeError("driver push refused")

    monkeypatch.setattr(svc, "apply_compose_for_deployments", _boom)

    with pytest.raises(HTTPException) as ei:
        asyncio.run(svc.wake_context_stage("shop", "staging"))
    assert ei.value.status_code == 502
    assert "driver push refused" in ei.value.detail
