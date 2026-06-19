"""Restore safety: a snapshot may be restored into dev/staging/DR but NEVER
directly onto live Production (the dangerous path). Going live is the separate
DR swap (an ingress cutover), not a data restore."""

import asyncio

import pytest
from fastapi import HTTPException

from app.models import SnapshotRestoreRequest
from app.routes.snapshots import restore_snapshot


def test_restore_into_production_is_blocked():
    body = SnapshotRestoreRequest(
        snapshot_id="snap-1", source_stage="production", target_stage="production"
    )
    with pytest.raises(HTTPException) as e:
        asyncio.run(restore_snapshot("MyBP", body))
    assert e.value.status_code == 400
    assert "Production" in e.value.detail


def test_restore_into_production_blocked_regardless_of_source():
    # Blocked no matter where the snapshot came from.
    for src in ("dev", "staging", "production"):
        body = SnapshotRestoreRequest(
            snapshot_id="snap-1", source_stage=src, target_stage="production"
        )
        with pytest.raises(HTTPException) as e:
            asyncio.run(restore_snapshot("MyBP", body))
        assert e.value.status_code == 400


def test_restore_to_dr_targets_production_standby_db(monkeypatch):
    """A 'dr' restore must hit the production instance + the STANDBY database
    (never the live db). The live db's data is untouched."""
    import app.dependencies as deps
    import app.routes.snapshots as snaps

    captured = {}

    async def fake_spawn(
        slug, snapshot_id, source_stage, target_stage, db=None, by=None
    ):
        captured.update(
            slug=slug,
            target_stage=target_stage,
            db=db,
            snapshot_id=snapshot_id,
            by=by,
        )
        return {"task_id": "t-1"}

    class FakeAutomation:
        def standby_db(self, bp):  # live_db=1 → standby=2
            return 2

        async def record_backup_event(self, *a, **k):
            return None

    monkeypatch.setattr(snaps, "spawn_restore_snapshot", fake_spawn)
    monkeypatch.setattr(deps, "get_automation_service", lambda: FakeAutomation())

    body = SnapshotRestoreRequest(
        snapshot_id="snap-1", source_stage="production", target_stage="dr"
    )
    resp = asyncio.run(restore_snapshot("MyBP", body))

    # Routed to the production instance, standby db 2.
    assert captured["target_stage"] == "production"
    assert captured["db"] == 2
    # The response still tells the UI it landed in DR.
    assert resp.status_code == 202
