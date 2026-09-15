from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies import get_automation_service
from app.services import workspace_git_remote as remote_cfg
from app.services import workspace_mirror
from app.task_queue import current_requester
from app.utils import daemon_user_role

router = APIRouter(prefix="/workspace", tags=["workspace"])


class RemoteBody(BaseModel):
    url: str


def require_admin() -> str:
    actor = (current_requester.get() or "").strip()
    try:
        role = daemon_user_role(actor) if actor else ""
    except Exception:
        role = ""
    if role != "admin":
        raise HTTPException(
            status_code=403, detail="Workspace git remote settings are admin-only"
        )
    return actor


def require_identity() -> str:
    actor = (current_requester.get() or "").strip()
    if not actor:
        raise HTTPException(status_code=401, detail="No verified identity")
    return actor


def _secrets_dir() -> str:
    return get_automation_service().secrets_dir


async def _view(secrets_dir: str) -> dict:
    view = await remote_cfg.public_view(secrets_dir)
    view["status"]["in_progress"] = workspace_mirror.push_in_flight()
    view["provider"] = remote_cfg.remote_provider(view["url"]) if view["url"] else None
    return view


@router.get("/git-remote")
async def get_git_remote(actor: str = Depends(require_admin)) -> dict:
    return await _view(_secrets_dir())


@router.put("/git-remote")
async def set_git_remote(body: RemoteBody, actor: str = Depends(require_admin)) -> dict:
    try:
        url = remote_cfg.validate_remote_url(body.url)
    except remote_cfg.RemoteUrlError as e:
        raise HTTPException(status_code=400, detail=str(e))
    secrets_dir = _secrets_dir()
    await remote_cfg.ensure_keypair(secrets_dir)
    remote_cfg.save_config(secrets_dir, url, actor)
    task_id = workspace_mirror.request_push("configure", actor, immediate=True)
    view = await _view(secrets_dir)
    view["task_id"] = task_id
    return view


@router.delete("/git-remote")
async def clear_git_remote(actor: str = Depends(require_admin)) -> dict:
    secrets_dir = _secrets_dir()
    remote_cfg.save_config(secrets_dir, None, actor)
    workspace_mirror.cancel_pending()
    return await _view(secrets_dir)


def _require_url(secrets_dir: str) -> None:
    if not remote_cfg.load_config(secrets_dir)["url"]:
        raise HTTPException(status_code=400, detail="No git remote is configured")


@router.post("/git-remote/push")
async def push_git_remote(actor: str = Depends(require_admin)) -> dict:
    secrets_dir = _secrets_dir()
    _require_url(secrets_dir)
    if remote_cfg.load_config(secrets_dir)["paused"]:
        raise HTTPException(status_code=409, detail="The git remote is paused")
    already_queued = workspace_mirror.request_push("manual", actor, immediate=False)
    task_id = already_queued or workspace_mirror.request_push(
        "manual", actor, immediate=True
    )
    view = await _view(secrets_dir)
    view["task_id"] = task_id
    view["coalesced"] = bool(already_queued)
    return view


@router.post("/git-remote/pull")
async def pull_git_remote(actor: str = Depends(require_identity)) -> dict:
    secrets_dir = _secrets_dir()
    cfg = remote_cfg.load_config(secrets_dir)
    if not cfg["url"] or cfg["paused"]:
        return {
            "configured": bool(cfg["url"]),
            "paused": cfg["paused"],
            "result": "paused" if cfg["url"] else "unconfigured",
            "inbound": [],
            "conflicts": [],
            "error": None,
            "branches": {},
        }
    try:
        status = await workspace_mirror.run_inline("deploy-check", actor)
    except workspace_mirror.MirrorError as e:
        status = remote_cfg.load_status(secrets_dir)
        status["error"] = status.get("error") or str(e)
    return {
        "configured": True,
        "paused": False,
        "result": status.get("result"),
        "inbound": status.get("inbound") or [],
        "conflicts": status.get("conflicts") or [],
        "error": status.get("error"),
        "branches": status.get("branches") or {},
    }


@router.post("/git-remote/force-push")
async def force_push_git_remote(actor: str = Depends(require_admin)) -> dict:
    secrets_dir = _secrets_dir()
    _require_url(secrets_dir)
    try:
        await workspace_mirror.run_inline("repair", actor, force=True)
    except workspace_mirror.MirrorError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return await _view(secrets_dir)


@router.post("/git-remote/pause")
async def pause_git_remote(actor: str = Depends(require_admin)) -> dict:
    secrets_dir = _secrets_dir()
    _require_url(secrets_dir)
    remote_cfg.set_paused(secrets_dir, True, actor)
    workspace_mirror.cancel_pending()
    return await _view(secrets_dir)


@router.post("/git-remote/resume")
async def resume_git_remote(actor: str = Depends(require_admin)) -> dict:
    secrets_dir = _secrets_dir()
    _require_url(secrets_dir)
    remote_cfg.set_paused(secrets_dir, False, actor)
    task_id = workspace_mirror.request_push("resume", actor, immediate=True)
    view = await _view(secrets_dir)
    view["task_id"] = task_id
    return view


@router.post("/git-remote/rotate-key")
async def rotate_git_remote_key(actor: str = Depends(require_admin)) -> dict:
    secrets_dir = _secrets_dir()
    await remote_cfg.rotate_keypair(secrets_dir)
    remote_cfg.save_status(
        secrets_dir,
        {
            **remote_cfg.load_status(secrets_dir),
            "key_rotated_at": remote_cfg._now_iso(),
            "key_rotated_by": actor,
        },
    )
    return await _view(secrets_dir)
