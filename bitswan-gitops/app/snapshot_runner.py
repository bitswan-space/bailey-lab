"""
Background runners for snapshot operations.

Mirrors `app/deploy_runner.py`: spawn the operation as a strongly-referenced
asyncio task, drive `snapshot_manager` task state from the engine's progress
callback, and broadcast every transition over the `snapshot_progress` SSE
event. Clients poll `GET /snapshots/tasks/{task_id}` for the authoritative
state (same rationale as deploys: SSE is fire-and-forget, a dropped stream
must not wedge the UI), the SSE event is a freshness bonus.

Restore/clone refuse to start while any of the BP's member deployments at
the touched stages is mid-deploy, and lock source+target stage atomically.
"""

import asyncio
import logging

from app.deploy_manager import deploy_manager
from app.event_broadcaster import event_broadcaster
from app.snapshot_manager import (
    SnapshotStatus,
    SnapshotStep,
    snapshot_manager,
)

logger = logging.getLogger(__name__)


class BusyError(RuntimeError):
    """A conflicting operation holds the bp×stage lock (HTTP 409)."""


# Strong references to background tasks — prevents GC before completion.
_bg_tasks: set[asyncio.Task] = set()


def _spawn_bg(coro) -> asyncio.Task:
    t = asyncio.create_task(coro)
    _bg_tasks.add(t)
    t.add_done_callback(_bg_tasks.discard)
    return t


async def _broadcast(task_id: str):
    task = snapshot_manager.get_task(task_id)
    if task:
        await event_broadcaster.broadcast("snapshot_progress", task.to_dict())


def _progress_callback(task_id: str):
    async def progress(step: str, message: str):
        try:
            snapshot_step = SnapshotStep(step)
        except ValueError:
            snapshot_step = None
        await snapshot_manager.update_task(
            task_id,
            status=SnapshotStatus.IN_PROGRESS,
            step=snapshot_step,
            message=message,
        )
        await _broadcast(task_id)

    return progress


def _bp_deploy_in_flight(service, bp: str, stages: list[str]) -> str | None:
    """Return a deployment_id of `bp` currently deploying at any of `stages`,
    or None. Restoring under a mid-deploy container swap would race."""
    from app.services.infra_service import stage_for_deployment
    from app.services.bp_databases import derive_bp_and_copy
    from app.utils import read_bitswan_yaml

    bs_yaml = read_bitswan_yaml(service.gitops_dir) or {}
    for dep_id, conf in (bs_yaml.get("deployments") or {}).items():
        conf = conf or {}
        dep_slug, wt = derive_bp_and_copy(conf.get("relative_path"))
        if wt or dep_slug != bp:
            continue
        realm = stage_for_deployment(conf.get("stage") or "production")
        if realm in stages and deploy_manager.is_deploying(dep_id):
            return dep_id
    return None


async def _run_task(task_id: str, label: str, coro_fn):
    """Drive one snapshot operation to a terminal state."""
    try:
        await snapshot_manager.update_task(
            task_id,
            status=SnapshotStatus.IN_PROGRESS,
            step=SnapshotStep.VALIDATING,
            message=f"{label}...",
        )
        await _broadcast(task_id)

        result = await coro_fn(_progress_callback(task_id))

        await snapshot_manager.update_task(
            task_id,
            status=SnapshotStatus.COMPLETED,
            step=SnapshotStep.DONE,
            message=f"{label} completed",
            snapshot_id=(result or {}).get("id") or (result or {}).get("restored"),
            result=result,
        )
        await _broadcast(task_id)
    except Exception as exc:
        logger.exception("%s failed (task %s)", label, task_id)
        await snapshot_manager.update_task(
            task_id,
            status=SnapshotStatus.FAILED,
            error=str(exc),
            message=f"{label} failed",
        )
        await _broadcast(task_id)


async def spawn_create_snapshot(bp: str, stage: str, label: str = "") -> dict:
    """Reserve bp×stage and snapshot it in the background.

    Returns {"task_id": ...} or raises ValueError (busy → caller maps to 409).
    """
    from app.services.snapshot_service import get_snapshot_service

    task, conflict = await snapshot_manager.create_task(
        "create", bp, [stage], source_stage=stage
    )
    if task is None:
        raise BusyError(
            f"A snapshot operation is already running for {bp} at {conflict}"
        )

    service = get_snapshot_service()

    async def run(progress):
        return await service.create_snapshot(
            bp, stage, label=label, kind="manual", progress=progress
        )

    _spawn_bg(_run_task(task.task_id, f"Snapshot of {bp} ({stage})", run))
    return {"task_id": task.task_id}


async def spawn_restore_snapshot(
    bp: str,
    snapshot_id: str,
    source_stage: str,
    target_stage: str,
    db: int | None = None,
    by: str | None = None,
) -> dict:
    """Reserve source+target stages and restore in the background.

    `db` (1/2) restores into that production database instead of the
    single-backend one — the DR-restore path (target_stage is 'production',
    db is the standby) that never touches the live db. For that path the DR
    "currently restored" pointer is recorded only after the restore succeeds,
    so a failed restore never marks DR as loaded with this backup.
    """
    from app.services.snapshot_service import get_snapshot_service
    from app.dependencies import get_automation_service

    service = get_snapshot_service()
    # Existence check up-front so the route can 404 before a task is created.
    service.get_snapshot(bp, source_stage, snapshot_id)

    stages = sorted({source_stage, target_stage})
    deploying = _bp_deploy_in_flight(get_automation_service(), bp, stages)
    if deploying:
        raise BusyError(
            f"Deployment {deploying} is in progress — retry when it finishes"
        )

    task, conflict = await snapshot_manager.create_task(
        "restore",
        bp,
        stages,
        source_stage=source_stage,
        target_stage=target_stage,
        snapshot_id=snapshot_id,
    )
    if task is None:
        raise BusyError(
            f"A snapshot operation is already running for {bp} at {conflict}"
        )

    async def run(progress):
        result = await service.restore_snapshot(
            bp, snapshot_id, source_stage, target_stage, progress=progress, db=db
        )
        # DR restore succeeded → record which backup is now loaded into the
        # standby db (the only one eligible to be recovery-tested). Done here,
        # not at request time, so a failed restore leaves DR honestly empty.
        if db:
            await get_automation_service().record_dr_restore(bp, snapshot_id, by)
        return result

    dest = f"{target_stage} db{db}" if db else target_stage
    _spawn_bg(
        _run_task(
            task.task_id,
            f"Restore of {bp} ({source_stage} → {dest})",
            run,
        )
    )
    return {"task_id": task.task_id}


async def spawn_clone_stage(bp: str, source_stage: str, target_stage: str) -> dict:
    """One-click stage→stage clone: snapshot the source (kind=auto), then
    restore it into the target. One task, both stages locked throughout."""
    from app.services.snapshot_service import get_snapshot_service
    from app.dependencies import get_automation_service

    if source_stage == target_stage:
        raise ValueError("Source and target stage must differ")

    service = get_snapshot_service()
    stages = sorted({source_stage, target_stage})
    deploying = _bp_deploy_in_flight(get_automation_service(), bp, stages)
    if deploying:
        raise BusyError(
            f"Deployment {deploying} is in progress — retry when it finishes"
        )

    task, conflict = await snapshot_manager.create_task(
        "clone",
        bp,
        stages,
        source_stage=source_stage,
        target_stage=target_stage,
    )
    if task is None:
        raise BusyError(
            f"A snapshot operation is already running for {bp} at {conflict}"
        )

    async def run(progress):
        snap = await service.create_snapshot(
            bp,
            source_stage,
            label=f"auto for clone {source_stage} → {target_stage}",
            kind="auto",
            source={"reason": "clone", "target_stage": target_stage},
            progress=progress,
        )
        await snapshot_manager.update_task(task.task_id, snapshot_id=snap["id"])
        result = await service.restore_snapshot(
            bp, snap["id"], source_stage, target_stage, progress=progress
        )
        # The clone's source snapshot is kind=auto; keep the source stage
        # tidy too (restore already pruned the target).
        service.prune_auto_snapshots(bp, source_stage, keep_ids={snap["id"]})
        return result

    _spawn_bg(
        _run_task(
            task.task_id,
            f"Clone of {bp} ({source_stage} → {target_stage})",
            run,
        )
    )
    return {"task_id": task.task_id}
