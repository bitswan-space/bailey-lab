"""API routes for backup management."""

import asyncio
import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.services import backup_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/backups", tags=["backups"])

# Whole-server backups take minutes; POST /run returns 202 and the run
# continues here. One at a time.
_run_task: asyncio.Task | None = None


def _backup_running() -> bool:
    return _run_task is not None and not _run_task.done()


# --- Configuration ---


class BackupConfigRequest(BaseModel):
    enabled: bool = True
    retention_daily: int = 30
    retention_monthly: int = 12


@router.get("/config")
async def get_config():
    """Get current backup configuration and last-run status."""
    aoc_connected = backup_service._aoc_settings() is not None
    config = backup_service.get_backup_config()
    if not config:
        return {"configured": False, "aoc_connected": aoc_connected}
    return {
        "configured": True,
        "aoc_connected": aoc_connected,
        "enabled": config.get("enabled", True),
        "retention": config.get("retention", {}),
        "has_key": backup_service.get_restic_key() is not None,
        "last_run": backup_service.get_last_run(),
        "running": _backup_running(),
    }


@router.post("/config")
async def save_config(body: BackupConfigRequest):
    """Save backup configuration and initialize the restic repository.

    Backups run through the AOC backup proxy — no S3 credentials are
    needed (or accepted) here; the workspace's AOC connection is used.
    """
    if backup_service._aoc_settings() is None:
        raise HTTPException(
            status_code=400,
            detail="This workspace is not connected to an AOC; backups unavailable",
        )

    config = {
        "enabled": body.enabled,
        "retention": {
            "daily": body.retention_daily,
            "monthly": body.retention_monthly,
        },
    }
    backup_service.save_backup_config(config)

    if not body.enabled:
        return {"status": "disabled", "message": "Backups disabled"}

    ok, msg = await backup_service.ensure_backups_enabled()
    if not ok:
        raise HTTPException(status_code=500, detail=msg)

    result = {"status": "configured", "message": msg}
    if "recovered" in msg.lower():
        result["recovered"] = True
    return result


# --- Key management ---
# The encryption key always lives on the local server (secrets/.backup/restic-key).
# On setup, it's also mirrored off-site (into the backup bucket, via AOC).
# The user can download it (to store in a password manager) and delete the
# off-site copy so a compromised object store can't be used to decrypt backups.
# URL paths keep their historical "s3" names for API stability.


@router.get("/key")
async def get_key():
    """Download the restic encryption key for offline storage."""
    key = backup_service.get_restic_key()
    if not key:
        raise HTTPException(status_code=404, detail="No encryption key found")
    return {"key": key}


@router.get("/key/s3-status")
async def key_s3_status():
    """Check if the key is mirrored off-site."""
    config = backup_service.get_backup_config()
    if not config:
        raise HTTPException(status_code=400, detail="Backup not configured")
    exists = await backup_service.key_exists_remote()
    return {"on_s3": exists}


@router.post("/key/upload-to-s3")
async def upload_key_offsite():
    """Mirror the encryption key off-site as a backup copy."""
    config = backup_service.get_backup_config()
    key = backup_service.get_restic_key()
    if not config or not key:
        raise HTTPException(status_code=400, detail="Backup not configured or no key")
    ok, msg = await backup_service.upload_key_remote(key)
    if not ok:
        raise HTTPException(status_code=500, detail=msg)
    return {"status": "uploaded", "message": "Key uploaded"}


@router.delete("/key/s3")
async def delete_key_offsite():
    """Delete the off-site copy of the encryption key. The local copy remains.
    WARNING: If the local server is lost and you haven't downloaded the key,
    all backups become unrecoverable."""
    config = backup_service.get_backup_config()
    if not config:
        raise HTTPException(status_code=400, detail="Backup not configured")
    ok, msg = await backup_service.delete_key_remote()
    if not ok:
        raise HTTPException(status_code=500, detail=msg)
    return {
        "status": "deleted",
        "message": "Off-site key copy deleted. Local copy still exists for making backups.",
    }


# --- Backup operations ---


@router.post("/run")
async def run_backup_now():
    """Start a whole-server backup in the background (202).

    409 while one is already running. Outcome lands in `last_run` on
    GET /backups/config."""
    global _run_task
    if not backup_service.is_configured():
        raise HTTPException(status_code=400, detail="Backup not configured")
    if _backup_running():
        raise HTTPException(status_code=409, detail="A backup is already running")
    config = backup_service.get_backup_config()

    async def run():
        try:
            await backup_service.run_backup(config)
        except Exception:
            logger.exception("Manual backup run failed")

    _run_task = asyncio.create_task(run())
    return JSONResponse(status_code=202, content={"status": "started"})


@router.get("/snapshots")
async def list_snapshots(tag: str = None):
    """List available backup snapshots."""
    if not backup_service.is_configured():
        raise HTTPException(status_code=400, detail="Backup not configured")
    config = backup_service.get_backup_config()

    snapshots = await backup_service.list_snapshots(config, tag=tag)
    return {"snapshots": snapshots}


# --- Restore operations ---


class RestoreRequest(BaseModel):
    snapshot_id: str
    stage: str = "production"


@router.post("/restore/postgres")
async def restore_postgres(body: RestoreRequest):
    """Restore a Postgres backup to a given stage."""
    if not backup_service.is_configured():
        raise HTTPException(status_code=400, detail="Backup not configured or no key")
    config = backup_service.get_backup_config()

    ok, msg = await backup_service.restore_postgres(
        config, body.snapshot_id, body.stage
    )
    if not ok:
        raise HTTPException(status_code=500, detail=msg)
    return {"status": "restored", "message": msg}


@router.post("/restore/couchdb")
async def restore_couchdb(body: RestoreRequest):
    """Restore a CouchDB backup to a given stage."""
    if not backup_service.is_configured():
        raise HTTPException(status_code=400, detail="Backup not configured or no key")
    config = backup_service.get_backup_config()

    ok, msg = await backup_service.restore_couchdb(config, body.snapshot_id, body.stage)
    if not ok:
        raise HTTPException(status_code=500, detail=msg)
    return {"status": "restored", "message": msg}


class WorkspaceRestoreRequest(BaseModel):
    snapshot_id: str


@router.post("/restore/workspace")
async def restore_workspace(body: WorkspaceRestoreRequest):
    """Restore workspace files to /tmp/restores/{datetime}."""
    if not backup_service.is_configured():
        raise HTTPException(status_code=400, detail="Backup not configured or no key")
    config = backup_service.get_backup_config()

    ok, msg = await backup_service.restore_workspace(config, body.snapshot_id)
    if not ok:
        raise HTTPException(status_code=500, detail=msg)
    return {"status": "restored", "message": msg}
