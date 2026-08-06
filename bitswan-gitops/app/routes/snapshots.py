"""
FastAPI routes for per-BP stage snapshots.

Long-running operations (create/restore/clone) return 202 with a task_id;
clients poll `GET /snapshots/tasks/{task_id}` (the `snapshot_progress` SSE
event is broadcast as a freshness bonus, same contract as deploys).

Error mapping follows `routes/services.py`: ValueError → 400,
LookupError → 404, BusyError → 409, RuntimeError → 500.

These are per-BP, cross-stage data snapshots stored locally on the gitops
server. Off-site protection is the automation-server daemon's job (it backs
up this whole directory nightly); snapshots pruned locally are listed as
`remote_only` from the daemon and can be fetched back through it.
"""

import asyncio
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
    spawn_fetch_snapshot,
    spawn_restore_snapshot,
)
from app.services.snapshot_service import get_snapshot_service
from app.utils import (
    SERVICE_REALMS,
    daemon_list_offsite_snapshots,
    sanitize_automation_name,
)

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


async def _audit_backup(
    slug: str, action: str, detail: str, by: str | None, stage: str | None = None
) -> None:
    """Append a backup/restore event to bitswan.yaml (versioned audit log).
    `stage` selects which deployment-history timeline it surfaces on.
    Best-effort: an audit failure must never fail the snapshot operation."""
    try:
        from app.dependencies import get_automation_service

        await get_automation_service().record_backup_event(
            slug, action, detail, by, stage
        )
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
    any in-flight tasks (so a reloaded dashboard can resume its progress UI).

    Snapshots that exist only in the server's backups (local files deleted
    or pruned) are listed too — from the daemon — with `local: false` and
    `remote_only: true`; Fetch materializes them back."""
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

    # Snapshots pruned locally may still live in the automation server's
    # nightly backups; the daemon is the authority on what can be fetched
    # back. Best-effort per stage — an unavailable daemon just means no
    # remote-only rows, never a failed listing.
    local_ids = {s["id"] for s in snapshots}
    for s in snapshots:
        s["local"] = True
    for stage in sorted(SERVICE_REALMS):
        for ref in await asyncio.to_thread(
            daemon_list_offsite_snapshots, slug, stage
        ):
            snapshot_id = ref.get("snapshot_id")
            if not snapshot_id or snapshot_id in local_ids:
                continue
            local_ids.add(snapshot_id)
            # Deliberately partial. The backup repo records an id, a stage and a
            # timestamp for an off-site copy and nothing else — not which
            # services it holds, not its size, not its label or kind. Inventing
            # zeros for those would be worse than omitting them: the UI would
            # confidently report "no services, 0 B" for a snapshot that may hold
            # everything. The dashboard's Snapshot type marks exactly these
            # fields optional so the compiler forces callers to handle it (they
            # were once required, and the first remote-only snapshot took the
            # whole Backups page down with it).
            snapshots.append(
                {
                    "id": snapshot_id,
                    "bp": slug,
                    "stage": stage,
                    "created_at": ref.get("backed_up_at") or "",
                    "local": False,
                    "remote_only": True,
                }
            )
    snapshots.sort(key=lambda m: m.get("created_at", ""), reverse=True)

    active = [t.to_dict() for t in snapshot_manager.get_active_tasks_for_bp(slug)]
    return {
        "bp": slug,
        "snapshots": snapshots,
        "eligibility": eligibility,
        "disk_usage_bytes": usage,
        "active_tasks": active,
        # The automation-server daemon makes the off-site backups; its socket
        # being mounted is what makes a workspace recoverable from them.
        "offsite_enabled": os.path.exists(
            os.environ.get(
                "BITSWAN_INGRESS_SOCKET", "/var/run/bitswan/automation-server.sock"
            )
        ),
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

    # 'dr' is the safe recovery sink: restore into the production STANDBY
    # database (never the live db), then hand-verify and swap. It maps to the
    # production instance + the standby db — the live db is never touched.
    service_target = body.target_stage
    restore_db: int | None = None
    if body.target_stage == "dr":
        from app.dependencies import get_automation_service

        restore_db = get_automation_service().standby_db(slug)
        service_target = "production"
    else:
        _validate_stage(body.target_stage)
        # Safety: never overwrite LIVE Production data with a restore. Recovery
        # goes into the isolated Disaster-Recovery standby (restored, hand-
        # verified) and only then goes live via the DR swap (an ingress
        # repoint, no data move).
        if body.target_stage == "production":
            raise HTTPException(
                status_code=400,
                detail=(
                    "Restoring directly into live Production is not allowed. "
                    "Restore into Disaster Recovery, verify the data, then swap "
                    "DR with Production (ingress cutover)."
                ),
            )
    try:
        res = await spawn_restore_snapshot(
            slug,
            body.snapshot_id,
            body.source_stage,
            service_target,
            db=restore_db,
            by=body.by,
        )
    except BusyError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    audit_dest = (
        f"Disaster Recovery (standby db{restore_db})"
        if restore_db
        else body.target_stage
    )
    # A DR restore lands in the production standby db, so it surfaces on the
    # production timeline; dev/staging restores surface on their own stage.
    # (The DR "currently restored" pointer that gates recovery-testing is set
    # by the background task only once the restore actually succeeds — see
    # spawn_restore_snapshot — so a failed restore never marks DR as loaded.)
    audit_stage = "production" if restore_db else body.target_stage
    await _audit_backup(
        slug,
        "restored",
        f"{body.source_stage} snapshot → {audit_dest}",
        body.by,
        stage=audit_stage,
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


@router.post("/{bp}/{stage}/{snapshot_id}/fetch")
async def fetch_snapshot(bp: str, stage: str, snapshot_id: str):
    """Materialize an off-site snapshot back into the local store (202 + task).

    200 `already_local` when nothing needs fetching; the restore endpoint
    auto-fetches on its own, so this exists for explicit "bring it back"."""
    slug = _bp_slug(bp)
    _validate_stage(stage)

    service = get_snapshot_service()
    try:
        service.get_snapshot(slug, stage, snapshot_id)
        return {"status": "already_local", "bp": slug, "snapshot_id": snapshot_id}
    except LookupError:
        pass
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    remote = await asyncio.to_thread(daemon_list_offsite_snapshots, slug, stage)
    if not any(r.get("snapshot_id") == snapshot_id for r in remote):
        raise HTTPException(
            status_code=404, detail=f"Snapshot {snapshot_id} not found off-site"
        )

    try:
        res = await spawn_fetch_snapshot(slug, stage, snapshot_id)
    except BusyError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await _audit_backup(slug, "fetched", f"{snapshot_id} ({stage})", None, stage=stage)
    return JSONResponse(
        status_code=202,
        content={
            "task_id": res["task_id"],
            "bp": slug,
            "stage": stage,
            "snapshot_id": snapshot_id,
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
        slug, "created", f"{body.label or 'snapshot'} ({stage})", body.by, stage=stage
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
    # Deleting local files never deletes what the server's backup already
    # captured — that is pruned only by the server's retention policy. Tell
    # the UI so it can say so.
    remote = await asyncio.to_thread(daemon_list_offsite_snapshots, slug, stage)
    return {
        "status": "deleted",
        "bp": slug,
        "stage": stage,
        "snapshot_id": snapshot_id,
        "offsite_retained": any(
            r.get("snapshot_id") == snapshot_id for r in remote
        ),
    }
