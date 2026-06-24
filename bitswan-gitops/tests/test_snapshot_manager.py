"""
Unit tests for the snapshot task manager, the background runners and the
/snapshots HTTP routes (TestClient against the bare router — no lifespan).
"""

import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import snapshot_runner
from app.snapshot_manager import (
    SnapshotManager,
    SnapshotStatus,
    SnapshotStep,
)
from app.snapshot_runner import (
    BusyError,
    spawn_clone_stage,
    spawn_create_snapshot,
    spawn_restore_snapshot,
)
from app.services.bp_databases import (
    load_registry,
    register_bp_stage,
    save_registry,
)


@pytest.fixture
def gitops_home(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))
    monkeypatch.setenv("BITSWAN_WORKSPACE_NAME", "ws-test")
    (tmp_path / "gitops").mkdir()
    reg = load_registry()
    register_bp_stage(reg, "my-bp", "My BP", "dev")
    register_bp_stage(reg, "my-bp", "My BP", "staging")
    save_registry(reg)
    return tmp_path


# ---------------------------------------------------------------------------
# manager
# ---------------------------------------------------------------------------


async def test_manager_single_stage_lock():
    mgr = SnapshotManager()
    task, conflict = await mgr.create_task("create", "my-bp", ["dev"])
    assert task is not None and conflict is None
    assert mgr.is_busy("my-bp", "dev")
    assert not mgr.is_busy("my-bp", "staging")
    assert not mgr.is_busy("other-bp", "dev")

    # Same bp×stage conflicts.
    task2, conflict2 = await mgr.create_task("create", "my-bp", ["dev"])
    assert task2 is None and conflict2 == "dev"

    # Other BP at same stage is independent.
    task3, _ = await mgr.create_task("create", "other-bp", ["dev"])
    assert task3 is not None

    # Terminal status releases the lock.
    await mgr.update_task(task.task_id, status=SnapshotStatus.COMPLETED)
    assert not mgr.is_busy("my-bp", "dev")


async def test_manager_multi_stage_atomic_reservation():
    mgr = SnapshotManager()
    held, _ = await mgr.create_task("create", "my-bp", ["staging"])
    assert held is not None

    # Restore wants dev+staging: staging is held → NOTHING is reserved.
    task, conflict = await mgr.create_task("restore", "my-bp", ["dev", "staging"])
    assert task is None and conflict == "staging"
    assert not mgr.is_busy("my-bp", "dev")

    await mgr.update_task(held.task_id, status=SnapshotStatus.FAILED)
    task, conflict = await mgr.create_task("restore", "my-bp", ["dev", "staging"])
    assert task is not None
    assert mgr.is_busy("my-bp", "dev") and mgr.is_busy("my-bp", "staging")


async def test_manager_task_dict_carries_step_sequence():
    mgr = SnapshotManager()
    task, _ = await mgr.create_task(
        "restore",
        "my-bp",
        ["dev", "staging"],
        source_stage="dev",
        target_stage="staging",
        snapshot_id="20250101-000000-aabbccdd",
    )
    await mgr.update_task(
        task.task_id,
        status=SnapshotStatus.IN_PROGRESS,
        step=SnapshotStep.RESTORE_POSTGRES,
        message="Restoring postgres...",
    )
    d = mgr.get_task(task.task_id).to_dict()
    assert d["operation"] == "restore"
    assert d["step"] == "restore_postgres"
    assert "restore_postgres" in d["steps"]
    assert d["steps"].index("validating") == 0
    assert d["target_stage"] == "staging"


async def test_manager_cleanup_old_tasks():
    mgr = SnapshotManager()
    task, _ = await mgr.create_task("create", "my-bp", ["dev"])
    await mgr.update_task(task.task_id, status=SnapshotStatus.COMPLETED)
    mgr.cleanup_old_tasks(max_age_seconds=0)
    assert mgr.get_task(task.task_id) is None


# ---------------------------------------------------------------------------
# runners
# ---------------------------------------------------------------------------


class FakeSnapshotService:
    def __init__(self):
        self.snapshots = {}
        self.created = []
        self.restored = []
        self.pruned = []
        self.fail_create = False
        self.fail_restore = False

    async def create_snapshot(
        self, bp, stage, label="", kind="manual", source=None, progress=None, db=None
    ):
        if self.fail_create:
            raise ValueError("postgres not running")
        if progress:
            await progress("snapshot_postgres", "pg...")
            await progress("snapshot_couchdb", "couch...")
            await progress("snapshot_minio", "minio...")
        manifest = {
            "id": f"20250101-00000{len(self.created)}-aabbccdd",
            "bp": bp,
            "stage": stage,
            "label": label,
            "kind": kind,
        }
        self.created.append(manifest)
        self.snapshots[(bp, stage, manifest["id"])] = manifest
        return manifest

    async def restore_snapshot(
        self, bp, snapshot_id, source_stage, target_stage, progress=None, **kw
    ):
        if self.fail_restore:
            raise RuntimeError("boom")
        if progress:
            await progress("pre_restore_snapshot", "auto...")
            await progress("restore_postgres", "pg...")
        self.restored.append((bp, snapshot_id, source_stage, target_stage))
        return {"restored": snapshot_id, "target_stage": target_stage}

    def get_snapshot(self, bp, stage, snapshot_id):
        key = (bp, stage, snapshot_id)
        if key not in self.snapshots:
            raise LookupError(f"Snapshot {snapshot_id} not found")
        return self.snapshots[key]

    def prune_auto_snapshots(self, bp, stage, keep=5, keep_ids=None):
        self.pruned.append((bp, stage))
        return []


@pytest.fixture
def fresh_manager(monkeypatch):
    """Isolated singleton so parallel tests don't share lock state."""
    mgr = SnapshotManager()
    monkeypatch.setattr("app.snapshot_manager.snapshot_manager", mgr)
    monkeypatch.setattr("app.snapshot_runner.snapshot_manager", mgr)
    return mgr


@pytest.fixture
def fake_service(gitops_home, monkeypatch, fresh_manager):
    svc = FakeSnapshotService()
    monkeypatch.setattr(
        "app.services.snapshot_service.get_snapshot_service", lambda: svc
    )
    events = []

    async def fake_broadcast(event_type, data):
        events.append((event_type, data))

    monkeypatch.setattr(snapshot_runner.event_broadcaster, "broadcast", fake_broadcast)
    svc.events = events
    return svc


async def _wait_terminal(mgr, task_id, timeout=5.0):
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        task = mgr.get_task(task_id)
        if task and task.status in (
            SnapshotStatus.COMPLETED,
            SnapshotStatus.FAILED,
        ):
            return task
        await asyncio.sleep(0.01)
    raise AssertionError("task did not reach a terminal state")


async def test_spawn_create_completes_and_broadcasts(fake_service, fresh_manager):
    res = await spawn_create_snapshot("my-bp", "dev", label="x")
    task = await _wait_terminal(fresh_manager, res["task_id"])
    assert task.status == SnapshotStatus.COMPLETED
    assert task.snapshot_id == fake_service.created[0]["id"]
    assert not fresh_manager.is_busy("my-bp", "dev")
    # snapshot_progress was broadcast, ending with the terminal event.
    assert fake_service.events
    assert all(e[0] == "snapshot_progress" for e in fake_service.events)
    assert fake_service.events[-1][1]["status"] == "completed"


async def test_spawn_create_busy_conflict(fake_service, fresh_manager):
    await fresh_manager.create_task("create", "my-bp", ["dev"])
    with pytest.raises(BusyError):
        await spawn_create_snapshot("my-bp", "dev")


async def test_spawn_create_failure_releases_lock(fake_service, fresh_manager):
    fake_service.fail_create = True
    res = await spawn_create_snapshot("my-bp", "dev")
    task = await _wait_terminal(fresh_manager, res["task_id"])
    assert task.status == SnapshotStatus.FAILED
    assert "postgres not running" in task.error
    assert not fresh_manager.is_busy("my-bp", "dev")


async def test_spawn_restore_locks_both_stages(fake_service, fresh_manager):
    snap = await fake_service.create_snapshot("my-bp", "dev")
    res = await spawn_restore_snapshot("my-bp", snap["id"], "dev", "staging")
    # Both stages locked while running (the fake completes fast, so check
    # the task's recorded stages instead of a race-prone is_busy probe).
    task = fresh_manager.get_task(res["task_id"])
    assert sorted(task.stages) == ["dev", "staging"]
    task = await _wait_terminal(fresh_manager, res["task_id"])
    assert task.status == SnapshotStatus.COMPLETED
    assert fake_service.restored == [("my-bp", snap["id"], "dev", "staging")]


async def test_spawn_restore_unknown_snapshot(fake_service, fresh_manager):
    with pytest.raises(LookupError):
        await spawn_restore_snapshot(
            "my-bp", "20990101-000000-deadbeef", "dev", "staging"
        )
    assert not fresh_manager.is_busy("my-bp", "dev")


async def test_spawn_restore_refuses_while_bp_deploying(
    fake_service, fresh_manager, gitops_home, monkeypatch
):
    import yaml

    (gitops_home / "gitops" / "bitswan.yaml").write_text(
        yaml.dump(
            {
                "deployments": {
                    "backend-my-bp-staging": {
                        "stage": "staging",
                        "relative_path": "My BP/backend",
                    }
                }
            }
        )
    )

    class StubAutomationService:
        gitops_dir = str(gitops_home / "gitops")

    monkeypatch.setattr(
        "app.dependencies.get_automation_service",
        lambda: StubAutomationService(),
    )
    snap = await fake_service.create_snapshot("my-bp", "dev")
    monkeypatch.setattr(
        snapshot_runner.deploy_manager, "is_deploying", lambda dep_id: True
    )
    with pytest.raises(BusyError, match="Deployment"):
        await spawn_restore_snapshot("my-bp", snap["id"], "dev", "staging")
    # Nothing was reserved.
    assert not fresh_manager.is_busy("my-bp", "dev")
    assert not fresh_manager.is_busy("my-bp", "staging")


async def test_spawn_clone_runs_snapshot_then_restore(fake_service, fresh_manager):
    res = await spawn_clone_stage("my-bp", "dev", "staging")
    task = await _wait_terminal(fresh_manager, res["task_id"])
    assert task.status == SnapshotStatus.COMPLETED
    assert task.operation == "clone"
    # Clone = auto snapshot of source + restore of it into target.
    assert fake_service.created[0]["kind"] == "auto"
    assert fake_service.restored[0][3] == "staging"
    assert ("my-bp", "dev") in fake_service.pruned


async def test_spawn_clone_same_stage_rejected(fake_service, fresh_manager):
    with pytest.raises(ValueError):
        await spawn_clone_stage("my-bp", "dev", "dev")


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------


@pytest.fixture
def client(fake_service, fresh_manager, monkeypatch):
    # The routes module imported the singleton accessor and manager by
    # reference — patch them there too.
    from app.routes import snapshots as routes_mod

    monkeypatch.setattr(
        routes_mod, "get_snapshot_service", lambda: _RouteFacade(fake_service)
    )
    monkeypatch.setattr(routes_mod, "snapshot_manager", fresh_manager)

    app = FastAPI()
    app.include_router(routes_mod.router)
    return TestClient(app)


class _RouteFacade:
    """list/eligibility/disk_usage facade over the fake runner service."""

    def __init__(self, svc):
        self._svc = svc

    def list_snapshots(self, bp):
        return [m for (b, _s, _i), m in self._svc.snapshots.items() if b == bp]

    def eligibility(self, bp):
        return {"bp": bp, "registered": True, "stages": {}}

    def disk_usage(self, bp):
        return 1234

    def delete_snapshot(self, bp, stage, snapshot_id):
        key = (bp, stage, snapshot_id)
        if key not in self._svc.snapshots:
            raise LookupError("not found")
        del self._svc.snapshots[key]

    def get_snapshot(self, bp, stage, snapshot_id):
        return self._svc.get_snapshot(bp, stage, snapshot_id)


def test_route_create_returns_202_task(client, fresh_manager):
    r = client.post("/snapshots/My BP/dev", json={"label": "x"})
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["bp"] == "my-bp"  # sanitized
    assert body["task_id"]
    # Task endpoint serves it.
    r2 = client.get(f"/snapshots/tasks/{body['task_id']}")
    assert r2.status_code == 200
    assert r2.json()["operation"] == "create"


def test_route_create_invalid_stage(client):
    r = client.post("/snapshots/my-bp/live-dev", json={})
    assert r.status_code == 400


def test_route_busy_returns_409(client, fresh_manager):
    # Mark the bp×stage busy directly — TestClient runs its own event loop,
    # so going through the async manager API here would mix loops.
    fresh_manager._active["my-bp:dev"] = "held-task"
    r = client.post("/snapshots/my-bp/dev", json={})
    assert r.status_code == 409


def test_route_restore_404_for_unknown_snapshot(client):
    r = client.post(
        "/snapshots/my-bp/restore",
        json={
            "snapshot_id": "20990101-000000-deadbeef",
            "source_stage": "dev",
            "target_stage": "staging",
        },
    )
    assert r.status_code == 404


def test_route_clone_validates_stages(client):
    r = client.post(
        "/snapshots/my-bp/clone",
        json={"source_stage": "dev", "target_stage": "dev"},
    )
    assert r.status_code == 400
    r = client.post(
        "/snapshots/my-bp/clone",
        json={"source_stage": "nope", "target_stage": "dev"},
    )
    assert r.status_code == 400


def test_route_task_not_found(client):
    r = client.get("/snapshots/tasks/does-not-exist")
    assert r.status_code == 404


def test_route_list_and_delete(client, fake_service):
    fake_service.snapshots[("my-bp", "dev", "20250101-000000-aabbccdd")] = {
        "id": "20250101-000000-aabbccdd",
        "bp": "my-bp",
        "stage": "dev",
        "kind": "manual",
    }
    r = client.get("/snapshots/my-bp")
    assert r.status_code == 200
    body = r.json()
    assert body["disk_usage_bytes"] == 1234
    assert len(body["snapshots"]) == 1

    r = client.delete("/snapshots/my-bp/dev/20250101-000000-aabbccdd")
    assert r.status_code == 200
    r = client.delete("/snapshots/my-bp/dev/20250101-000000-aabbccdd")
    assert r.status_code == 404


def test_route_delete_busy_409(client, fresh_manager):
    fresh_manager._active["my-bp:dev"] = "held-task"
    r = client.delete("/snapshots/my-bp/dev/20250101-000000-aabbccdd")
    assert r.status_code == 409
