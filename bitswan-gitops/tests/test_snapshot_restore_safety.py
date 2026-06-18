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
