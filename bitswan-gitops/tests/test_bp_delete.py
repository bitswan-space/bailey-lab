"""Business-process delete: guard, full teardown inventory, idempotency.

The orchestrator (`app/services/bp_delete.py`) composes primitives that all
tolerate "already gone", so a re-run after a partial failure completes the
teardown. These tests use a real AutomationService on a tmp gitops dir with
a fake infra driver (pattern: test_delete_automation.py) and monkeypatch the
git-persist + broadcast edges.
"""

import asyncio
import os

import pytest
import yaml

from app.services import bp_delete, bp_git, git_server
from app.services.automation_service import AutomationService

BP = "letsgo"
DEV_ID = "backend-letsgo-dev"
LIVE_ID = "backend-copy-alice-letsgo-live-dev"
OTHER_ID = "web-other-dev"


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


_ENTRIES = {
    DEV_ID: {
        "automation_name": "backend",
        "context": BP,
        "relative_path": f"copies/main/{BP}/backend",
        "stage": "dev",
    },
    LIVE_ID: {
        "automation_name": "backend",
        "context": f"copy-alice-{BP}",
        "relative_path": f"copies/alice/{BP}/backend",
        "stage": "live-dev",
    },
    OTHER_ID: {
        "automation_name": "web",
        "context": "other",
        "relative_path": "copies/main/other/web",
        "stage": "dev",
    },
}


def _setup(tmp_path, monkeypatch, entries=None, containers=None, protected=False):
    entries = dict(entries if entries is not None else _ENTRIES)
    if protected:
        entries["backend-letsgo-production"] = {
            "automation_name": "backend",
            "context": BP,
            "relative_path": f"copies/main/{BP}/backend",
            "stage": "",  # persisted "" = production
        }
    (tmp_path / "bitswan.yaml").write_text(yaml.safe_dump({"deployments": entries}))

    copies = tmp_path / "copies"
    for scope in ("main", "alice"):
        d = copies / scope / BP / "backend"
        d.mkdir(parents=True)
        (d / "automation.toml").write_text("id = 'x'\n")
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(copies))
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))

    repos = tmp_path / "git"
    (repos / f"{BP}.git" / "objects").mkdir(parents=True)
    monkeypatch.setattr(git_server, "GIT_REPOS_DIR", str(repos))

    secrets = tmp_path / "secrets-dir"
    (secrets / "bp" / BP).mkdir(parents=True)
    (secrets / "bp" / BP / "dev").write_text("FOO=bar\n")
    (tmp_path / "firewall").mkdir()
    (tmp_path / "firewall" / f"{BP}__dev.attempts.jsonl").write_text("{}\n")
    (tmp_path / "snapshots" / BP).mkdir(parents=True)

    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    svc.secrets_dir = str(secrets)
    svc.workspace_name = "ws"
    svc._infra_driver = _FakeDriver(
        list(containers)
        if containers is not None
        else [_Container(DEV_ID), _Container(LIVE_ID), _Container(OTHER_ID)]
    )

    persisted: list[tuple[set, str, str]] = []

    async def _persist(bs_yaml, bps, target, action, deployed_by=None, message=None):
        persisted.append((set(bps), target, action))
        # The real persist rewrites the per-BP slices that read_bitswan_yaml
        # aggregates; simulate by writing the mutated aggregate back, so the
        # post-persist fresh read (gateway guard) sees the popped entries.
        (tmp_path / "bitswan.yaml").write_text(yaml.safe_dump(bs_yaml))
        (tmp_path / "persisted.yaml").write_text(yaml.safe_dump(bs_yaml))

    monkeypatch.setattr(svc, "_persist_bp_state", _persist)

    # Root-rm needs a driver exec; force the shutil fallback in tests.
    async def _no_root_rm(path):
        return False

    monkeypatch.setattr(bp_git, "_rm_rf_as_root_in_container", _no_root_rm)

    broadcasts: list[str | None] = []

    async def _bcast(service, forget_copy=None):
        broadcasts.append(forget_copy)

    monkeypatch.setattr(bp_delete, "_broadcast_all", _bcast)

    from app.services import bp_databases

    db_calls: list[tuple] = []

    async def _drop_bp(workspace, slug):
        db_calls.append(("bp", workspace, slug))
        return {f"{slug}@all": "ok"}

    async def _drop_copy(workspace, copy, slugs):
        db_calls.append(("copy", workspace, copy, tuple(slugs)))
        return {f"copy-{copy}": "ok"}

    monkeypatch.setattr(bp_databases, "drop_bp_databases", _drop_bp)
    monkeypatch.setattr(bp_databases, "drop_copy_bp_databases", _drop_copy)

    return svc, persisted, db_calls, broadcasts


def test_guard_flags_staging_and_production(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch, protected=True)
    from app.utils import read_bitswan_yaml

    bs = read_bitswan_yaml(str(tmp_path))
    prot = bp_delete.protected_deployments(bs, BP)
    assert prot == [
        {"deployment_id": "backend-letsgo-production", "stage": "production"}
    ]
    # dev/live-dev never block.
    assert bp_delete.protected_deployments(
        {"deployments": {DEV_ID: _ENTRIES[DEV_ID], LIVE_ID: _ENTRIES[LIVE_ID]}}, BP
    ) == []


def test_full_teardown_inventory(tmp_path, monkeypatch):
    svc, persisted, db_calls, broadcasts = _setup(tmp_path, monkeypatch)

    res = asyncio.run(bp_delete.delete_business_process(BP, "u@x", svc))
    assert res["status"] == "success"

    # Containers of the BP's deployments removed; the OTHER bp's kept.
    assert f"cid-{DEV_ID}" in svc._infra_driver.removed
    assert f"cid-{LIVE_ID}" in svc._infra_driver.removed
    assert f"cid-{OTHER_ID}" not in svc._infra_driver.removed

    # One persist for the BP slice, with the entries popped (OTHER survives).
    assert persisted == [({BP}, BP, "delete-bp")]
    left = yaml.safe_load((tmp_path / "persisted.yaml").read_text())["deployments"]
    assert OTHER_ID in left and DEV_ID not in left and LIVE_ID not in left

    # Reconcile push for the emptied slice through the driver.
    assert any(
        d.get("deploy_remote") == f"driver://deploy/{BP}"
        for d in svc._infra_driver.deploys
    )

    # DBs: per-BP + per-(copy alice, BP); secrets + firewall logs gone;
    # clones gone from main + alice; bare repo gone; snapshots KEPT.
    assert ("bp", "ws", BP) in db_calls
    assert ("copy", "ws", "alice", (BP,)) in db_calls
    assert not (tmp_path / "secrets-dir" / "bp" / BP).exists()
    assert not (tmp_path / "firewall" / f"{BP}__dev.attempts.jsonl").exists()
    assert not (tmp_path / "copies" / "main" / BP).exists()
    assert not (tmp_path / "copies" / "alice" / BP).exists()
    assert not (tmp_path / "git" / f"{BP}.git").exists()
    assert (tmp_path / "snapshots" / BP).is_dir()
    assert broadcasts == [None]


def test_idempotent_rerun_on_half_torn_bp(tmp_path, monkeypatch):
    # No yaml entries, no clones, no containers — only the bare repo remains
    # (a previously interrupted delete). The re-run finishes without error.
    svc, persisted, _, _ = _setup(
        tmp_path, monkeypatch, entries={OTHER_ID: _ENTRIES[OTHER_ID]}, containers=[]
    )
    import shutil

    shutil.rmtree(tmp_path / "copies" / "main" / BP)
    shutil.rmtree(tmp_path / "copies" / "alice" / BP)

    from app.utils import read_bitswan_yaml

    bs = read_bitswan_yaml(str(tmp_path))
    assert bp_delete.bp_has_remnants(bs, BP) is True  # the bare repo
    res = asyncio.run(bp_delete.delete_business_process(BP, None, svc))
    assert res["status"] == "success"
    assert not (tmp_path / "git" / f"{BP}.git").exists()
    # Nothing left at all now → the route's 404 rule kicks in.
    assert bp_delete.bp_has_remnants(read_bitswan_yaml(str(tmp_path)), BP) is False


def test_remnant_rule_counts_registry_entry(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch, entries={}, containers=[])
    import shutil

    shutil.rmtree(tmp_path / "copies")
    shutil.rmtree(tmp_path / "git" / f"{BP}.git")
    assert bp_delete.bp_has_remnants({}, BP) is False

    from app.services import bp_databases

    reg = bp_databases.load_registry()
    reg["bps"][BP] = {"bp_name": BP, "stages": {}}
    bp_databases.save_registry(reg)
    assert bp_delete.bp_has_remnants({}, BP) is True


def test_gateway_teardown_guarded_by_active_members(tmp_path, monkeypatch):
    # A gateway container for the BP's live-dev context is removed once the
    # entries are gone; the OTHER context's gateway survives.
    gw = _Container("", labels={"gitops.firewall_gateway": "true"})
    gw.labels.pop("gitops.deployment_id")
    gw.labels.update({"gitops.context": f"copy-alice-{BP}", "gitops.stage": "live-dev"})
    gw.id = "cid-gateway"
    other_gw = _Container("", labels={"gitops.firewall_gateway": "true"})
    other_gw.labels.pop("gitops.deployment_id")
    other_gw.labels.update({"gitops.context": "other", "gitops.stage": "dev"})
    other_gw.id = "cid-other-gateway"

    svc, _, _, _ = _setup(
        tmp_path,
        monkeypatch,
        containers=[_Container(DEV_ID), _Container(LIVE_ID), gw, other_gw],
    )
    res = asyncio.run(bp_delete.delete_business_process(BP, None, svc))
    assert res["status"] == "success"
    assert "cid-gateway" in svc._infra_driver.removed
    assert "cid-other-gateway" not in svc._infra_driver.removed


def test_failed_step_keeps_bare_repo_as_retry_marker(tmp_path, monkeypatch):
    # When any step errors (here: the reconcile push), the bare repo must
    # SURVIVE — it is the remnant that lets a re-issued DELETE past the 404
    # rule to retry the failed step (e.g. prune leaked routes).
    svc, _, _, _ = _setup(tmp_path, monkeypatch)

    async def _boom(bp, message, deployed_by=None):
        raise RuntimeError("driver apply failed")

    monkeypatch.setattr(svc, "push_bp_state", _boom)
    with pytest.raises(RuntimeError):
        asyncio.run(bp_delete.delete_business_process(BP, None, svc))
    assert (tmp_path / "git" / f"{BP}.git").exists()  # kept
    from app.utils import read_bitswan_yaml

    assert bp_delete.bp_has_remnants(read_bitswan_yaml(str(tmp_path)), BP) is True
