"""
FastAPI routes for per-BP stage snapshots.

Long-running operations (create/restore/clone) return 202 with a task_id;
clients poll `GET /snapshots/tasks/{task_id}` (the `snapshot_progress` SSE
event is broadcast as a freshness bonus, same contract as deploys).

Error mapping follows `routes/services.py`: ValueError → 400,
LookupError → 404, BusyError → 409, RuntimeError → 500.

Distinct from `/backups/*` (restic/S3 disaster recovery) — these are
per-BP, cross-stage data snapshots stored locally on the gitops server.
"""

import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from app.models import (
    SnapshotCloneRequest,
    SnapshotCreateRequest,
    SnapshotProvisionRequest,
    SnapshotRestoreRequest,
)
from app.snapshot_manager import snapshot_manager
from app.snapshot_runner import (
    BusyError,
    spawn_clone_stage,
    spawn_create_snapshot,
    spawn_restore_snapshot,
)
from app.services.snapshot_service import get_snapshot_service
from app.utils import SERVICE_REALMS, sanitize_automation_name

router = APIRouter(prefix="/snapshots", tags=["snapshots"])


def _get_workspace_name() -> str:
    return os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace-local")


def _bp_slug(bp: str) -> str:
    slug = sanitize_automation_name(bp)
    if not slug:
        raise HTTPException(status_code=400, detail=f"Invalid BP name: {bp!r}")
    return slug


def _validate_stage(stage: str) -> None:
    if stage not in SERVICE_REALMS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid stage '{stage}': must be one of {sorted(SERVICE_REALMS)}",
        )


async def _audit_backup(slug: str, action: str, detail: str, by: str | None) -> None:
    """Append a backup/restore event to bitswan.yaml (versioned audit log).
    Best-effort: an audit failure must never fail the snapshot operation."""
    try:
        from app.dependencies import get_automation_service

        await get_automation_service().record_backup_event(slug, action, detail, by)
    except Exception as e:  # noqa: BLE001
        import logging

        logging.warning("backup audit (%s %s) failed: %s", action, slug, e)


# NOTE: route order matters — the concrete /tasks/{task_id} route must be
# declared before the parameterised /{bp} routes would shadow it.
@router.get("/tasks/{task_id}")
async def get_snapshot_task(task_id: str):
    """Poll fallback for SSE drops — returns current snapshot task state."""
    task = snapshot_manager.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Snapshot task not found")
    return task.to_dict()


@router.get("/{bp}")
async def list_bp_snapshots(bp: str):
    """All snapshots of one BP across stages + eligibility + disk usage +
    any in-flight tasks (so a reloaded dashboard can resume its progress UI)."""
    slug = _bp_slug(bp)
    service = get_snapshot_service()
    try:
        snapshots = service.list_snapshots(slug)
        eligibility = service.eligibility(slug)
        usage = service.disk_usage(slug)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    active = [t.to_dict() for t in snapshot_manager.get_active_tasks_for_bp(slug)]
    return {
        "bp": slug,
        "snapshots": snapshots,
        "eligibility": eligibility,
        "disk_usage_bytes": usage,
        "active_tasks": active,
    }


@router.get("/{bp}/eligibility")
async def get_bp_eligibility(bp: str):
    """Registry flags + live service availability per stage."""
    slug = _bp_slug(bp)
    service = get_snapshot_service()
    try:
        eligibility = service.eligibility(slug)
        for stage in sorted(SERVICE_REALMS):
            availability = await service.validate_target(slug, stage)
            eligibility["stages"][stage]["availability"] = availability
        return eligibility
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{bp}/provision")
async def provision_bp(bp: str, body: SnapshotProvisionRequest):
    """Explicit opt-in: register the BP at a stage and create its per-BP
    namespaces. The namespaces start EMPTY — existing data on the shared
    default databases is NOT migrated."""
    slug = _bp_slug(bp)
    _validate_stage(body.stage)
    from app.services.bp_databases import ensure_bp_databases

    try:
        results = await ensure_bp_databases(
            _get_workspace_name(), slug, body.bp_name or bp, body.stage
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"bp": slug, "stage": body.stage, "services": results}


@router.post("/{bp}/restore")
async def restore_snapshot(bp: str, body: SnapshotRestoreRequest):
    """Start a background restore of one snapshot into a target stage.

    REPLACE semantics: the target stage's current data is auto-snapshotted
    first, then cleared and overwritten.
    """
    slug = _bp_slug(bp)
    _validate_stage(body.source_stage)
    _validate_stage(body.target_stage)
    # Safety: never overwrite LIVE Production data with a restore. Recovery goes
    # into the isolated Disaster-Recovery standby (restored, hand-verified) and
    # only then goes live via the DR swap (an ingress repoint, no data move).
    if body.target_stage == "production":
        raise HTTPException(
            status_code=400,
            detail=(
                "Restoring directly into live Production is not allowed. Restore "
                "into Disaster Recovery, verify the data, then swap DR with "
                "Production (ingress cutover)."
            ),
        )
    try:
        res = await spawn_restore_snapshot(
            slug, body.snapshot_id, body.source_stage, body.target_stage
        )
    except BusyError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await _audit_backup(
        slug,
        "restored",
        f"{body.source_stage} snapshot → {body.target_stage}",
        body.by,
    )
    return JSONResponse(
        status_code=202,
        content={
            "task_id": res["task_id"],
            "bp": slug,
            "snapshot_id": body.snapshot_id,
            "source_stage": body.source_stage,
            "target_stage": body.target_stage,
            "status": "pending",
        },
    )


@router.post("/{bp}/clone")
async def clone_stage(bp: str, body: SnapshotCloneRequest):
    """One-click stage→stage data clone (snapshot source, restore into
    target). Same replace semantics + target auto-snapshot as restore."""
    slug = _bp_slug(bp)
    _validate_stage(body.source_stage)
    _validate_stage(body.target_stage)
    if body.target_stage == "production":
        raise HTTPException(
            status_code=400,
            detail=(
                "Cloning directly into live Production is not allowed — restore "
                "into Disaster Recovery and swap to go live."
            ),
        )
    try:
        res = await spawn_clone_stage(slug, body.source_stage, body.target_stage)
    except BusyError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return JSONResponse(
        status_code=202,
        content={
            "task_id": res["task_id"],
            "bp": slug,
            "source_stage": body.source_stage,
            "target_stage": body.target_stage,
            "status": "pending",
        },
    )


# Declared AFTER /restore, /clone and /provision: this parameterised
# route would otherwise capture those words as a stage name.
@router.post("/{bp}/{stage}")
async def create_snapshot(bp: str, stage: str, body: SnapshotCreateRequest):
    """Start a background snapshot of the BP's data at one stage."""
    slug = _bp_slug(bp)
    _validate_stage(stage)
    try:
        res = await spawn_create_snapshot(slug, stage, label=body.label or "")
    except BusyError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await _audit_backup(
        slug, "created", f"{body.label or 'snapshot'} ({stage})", body.by
    )
    return JSONResponse(
        status_code=202,
        content={
            "task_id": res["task_id"],
            "bp": slug,
            "stage": stage,
            "status": "pending",
        },
    )


@router.delete("/{bp}/{stage}/{snapshot_id}")
async def delete_snapshot(bp: str, stage: str, snapshot_id: str):
    """Delete one snapshot (synchronous). 409 while the bp×stage is busy."""
    slug = _bp_slug(bp)
    _validate_stage(stage)
    if snapshot_manager.is_busy(slug, stage):
        raise HTTPException(
            status_code=409,
            detail=f"A snapshot operation is running for {slug} at {stage}",
        )
    service = get_snapshot_service()
    try:
        service.delete_snapshot(slug, stage, snapshot_id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"status": "deleted", "bp": slug, "stage": stage, "snapshot_id": snapshot_id}
