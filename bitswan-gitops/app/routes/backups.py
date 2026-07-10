"""API routes for backup management."""

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import backup_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/backups", tags=["backups"])


# --- Configuration ---


class BackupConfigRequest(BaseModel):
    enabled: bool = True
    retention_daily: int = 30
    retention_monthly: int = 12


@router.get("/config")
async def get_config():
    """Get current backup configuration."""
    config = backup_service.get_backup_config()
    if not config:
        return {"configured": False}
    return {
        "configured": True,
        "enabled": config.get("enabled", True),
        "retention": config.get("retention", {}),
        "has_key": backup_service.get_restic_key() is not None,
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
    """Trigger an immediate backup of all production data."""
    if not backup_service.is_configured():
        raise HTTPException(status_code=400, detail="Backup not configured")
    config = backup_service.get_backup_config()

    try:
        results = await backup_service.run_backup(config)
        return results
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
