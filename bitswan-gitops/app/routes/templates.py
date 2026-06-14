"""
Automation-template gallery + scaffold endpoints.

Mirror of the dashboard server's old `routes/templates.ts`. The dashboard now
forwards `GET /api/templates` and `POST /api/automations/from-template` to
these endpoints; gitops is the sole writer to `/workspace-repo`.
"""

import logging
import os
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies import get_automation_service
from app.event_broadcaster import event_broadcaster
from app.services import template_service
from app.services.automation_service import AutomationService

logger = logging.getLogger(__name__)

router = APIRouter(tags=["templates"])

# Same shape as the dashboard server uses for BP / worktree names.
_BP_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
_WORKTREE_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9\-]*$")


def _workspace_root() -> str:
    return os.environ.get("BITSWAN_WORKSPACE_REPO_DIR", "/workspace-repo")


@router.get("/templates/")
async def list_templates() -> dict:
    """Return the merged `{templates, groups}` listing."""
    return template_service.discover_templates(_workspace_root())


class CreateFromTemplateRequest(BaseModel):
    template_id: str | None = None
    group_id: str | None = None
    name: str | None = None
    bp: str
    worktree: str | None = None


@router.post("/automations/from-template")
async def create_from_template(
    body: CreateFromTemplateRequest,
    automation_service: AutomationService = Depends(get_automation_service),
) -> dict:
    """Copy a template (or every automation in a group) into the BP directory,
    inject a UUID into each new `automation.toml`, commit, and broadcast the
    fresh `automations` snapshot.
    """
    if not body.bp or not _BP_NAME_RE.match(body.bp):
        raise HTTPException(status_code=400, detail="Invalid bp")
    if body.worktree is not None and not _WORKTREE_NAME_RE.match(body.worktree):
        raise HTTPException(status_code=400, detail="Invalid worktree name")
    if bool(body.template_id) == bool(body.group_id):
        raise HTTPException(
            status_code=400,
            detail="Exactly one of template_id / group_id is required",
        )

    try:
        result = await template_service.create_automation_from_template(
            workspace_root=_workspace_root(),
            bp=body.bp,
            template_id=body.template_id,
            group_id=body.group_id,
            name=body.name,
            worktree=body.worktree,
        )
    except FileExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("create_automation_from_template failed")
        raise HTTPException(status_code=500, detail=str(e))

    await _broadcast_automations(automation_service, body.worktree)
    return result


async def _broadcast_automations(
    automation_service: AutomationService, worktree: str | None
) -> None:
    """Refresh the affected scope's cache and broadcast the fresh automations
    snapshot so the dashboard updates without waiting for the FS watcher."""
    try:
        await automation_service.refresh(worktree)
        automations = await automation_service.get_automations()
        data = [
            a.model_dump(mode="json") if hasattr(a, "model_dump") else a
            for a in automations
        ]
        await event_broadcaster.broadcast("automations", data)
    except Exception:
        logger.exception("Failed to broadcast automations after change")


# ── Frontend / worker scaffolding ────────────────────────────────────────────
#
# Stage 1.5: business processes are built from frontends (exposed through
# Bailey) and worker containers (private backends). These endpoints scaffold
# them directly from the baked templates — no gallery picker. There is exactly
# one kind of frontend; workers have a `type` (only "go" is wired today,
# mapped to the `go-worker` template; more types will slot in here).

FRONTEND_TEMPLATE_ID = "frontend"
WORKER_TEMPLATE_BY_TYPE = {"go": "go-worker", "fastapi": "fastapi-worker"}


class AddFrontendRequest(BaseModel):
    bp: str
    name: str
    worktree: str | None = None


class AddWorkerRequest(BaseModel):
    bp: str
    name: str
    type: str = "go"
    worktree: str | None = None


class RenameAutomationRequest(BaseModel):
    bp: str
    old_name: str
    new_name: str
    worktree: str | None = None


def _validate_scope(bp: str, worktree: str | None) -> None:
    if not bp or not _BP_NAME_RE.match(bp):
        raise HTTPException(status_code=400, detail="Invalid bp")
    if worktree is not None and not _WORKTREE_NAME_RE.match(worktree):
        raise HTTPException(status_code=400, detail="Invalid worktree name")


async def _scaffold_from_template(
    automation_service: AutomationService,
    *,
    bp: str,
    template_id: str,
    name: str,
    worktree: str | None,
) -> dict:
    try:
        result = await template_service.create_automation_from_template(
            workspace_root=_workspace_root(),
            bp=bp,
            template_id=template_id,
            name=name,
            worktree=worktree,
        )
    except FileExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("scaffold from template %s failed", template_id)
        raise HTTPException(status_code=500, detail=str(e))
    await _broadcast_automations(automation_service, worktree)
    return result


@router.post("/automations/frontend")
async def add_frontend(
    body: AddFrontendRequest,
    automation_service: AutomationService = Depends(get_automation_service),
) -> dict:
    """Add a frontend (the only kind) to a business process."""
    _validate_scope(body.bp, body.worktree)
    return await _scaffold_from_template(
        automation_service,
        bp=body.bp,
        template_id=FRONTEND_TEMPLATE_ID,
        name=body.name,
        worktree=body.worktree,
    )


@router.post("/automations/worker")
async def add_worker(
    body: AddWorkerRequest,
    automation_service: AutomationService = Depends(get_automation_service),
) -> dict:
    """Add a worker container of the given type to a business process."""
    _validate_scope(body.bp, body.worktree)
    template_id = WORKER_TEMPLATE_BY_TYPE.get(body.type)
    if not template_id:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown worker type {body.type!r}; supported: "
            + ", ".join(sorted(WORKER_TEMPLATE_BY_TYPE)),
        )
    return await _scaffold_from_template(
        automation_service,
        bp=body.bp,
        template_id=template_id,
        name=body.name,
        worktree=body.worktree,
    )


@router.post("/automations/rename")
async def rename_automation_route(
    body: RenameAutomationRequest,
    automation_service: AutomationService = Depends(get_automation_service),
) -> dict:
    """Rename a frontend or worker within a business process."""
    _validate_scope(body.bp, body.worktree)
    try:
        result = await template_service.rename_automation(
            workspace_root=_workspace_root(),
            bp=body.bp,
            old_name=body.old_name,
            new_name=body.new_name,
            worktree=body.worktree,
        )
    except FileExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("rename_automation failed")
        raise HTTPException(status_code=500, detail=str(e))
    await _broadcast_automations(automation_service, body.worktree)
    return result
