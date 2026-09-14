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


def _secrets_dir() -> str:
    return get_automation_service().secrets_dir


async def _view(secrets_dir: str) -> dict:
    view = await remote_cfg.public_view(secrets_dir)
    view["status"]["in_progress"] = workspace_mirror.push_in_flight()
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


@router.post("/git-remote/push")
async def push_git_remote(actor: str = Depends(require_admin)) -> dict:
    secrets_dir = _secrets_dir()
    if not remote_cfg.load_config(secrets_dir)["url"]:
        raise HTTPException(status_code=400, detail="No git remote is configured")
    already_queued = workspace_mirror.request_push("manual", actor, immediate=False)
    task_id = already_queued or workspace_mirror.request_push(
        "manual", actor, immediate=True
    )
    view = await _view(secrets_dir)
    view["task_id"] = task_id
    view["coalesced"] = bool(already_queued)
    return view
