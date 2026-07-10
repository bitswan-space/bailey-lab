"""
REST surface over the workspace's business processes.

Reads the in-memory cache maintained by `ProcessService`; the cache is kept
fresh by the workspace + copy file-system watchers in `lifespan.py`.
Same data is broadcast over `/events/stream` as a `processes` event for
push-style consumers (the workspace dashboard).
"""

import logging
import os
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies import get_automation_service
from app.deploy_runner import spawn_set_deploy
from app.event_broadcaster import event_broadcaster
from app.services.process_service import process_service, slugify_bp_name
from app.services import template_service
from app.services.automation_service import AutomationService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/processes", tags=["processes"])

# The display name is free-form (issue #77) — the filesystem/git/deployment
# name is the slug derived from it (see `slugify_bp_name`). Cap the length so
# neither the toml nor the slug get silly.
_MAX_PROCESS_NAME_LEN = 100
# Matches the canonical copy-name constraint used by /copies and /templates.
_COPY_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9\-]*$")
# Directory-name slugs in URL paths. New BPs are strictly [a-z0-9-] (see
# `slugify_bp_name`), but BPs created before issue #77 kept the old, wider
# directory rule — accept it so legacy BPs can be renamed too. No `/` and no
# leading dot can pass, so path traversal is ruled out.
_BP_DIR_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


def _validated_display_name(raw: str) -> str:
    """Collapse whitespace + apply the display-name rules shared by create
    and rename. Raises HTTPException(400) on violation."""
    name = " ".join((raw or "").split())
    if not name or len(name) > _MAX_PROCESS_NAME_LEN:
        raise HTTPException(
            status_code=400,
            detail=(
                "Invalid process name: must be 1 to "
                f"{_MAX_PROCESS_NAME_LEN} characters."
            ),
        )
    if not slugify_bp_name(name):
        raise HTTPException(
            status_code=400,
            detail=(
                "Invalid process name: must contain at least one letter or "
                "digit (a-z, 0-9)."
            ),
        )
    return name


class CreateProcessRequest(BaseModel):
    # Human-readable display name; the slug (directory / git repo /
    # deployment-id segment) is derived from it server-side.
    name: str
    copy: str | None = None
    # The email of the user creating the BP (injected by the dashboard from the
    # validated token). Recorded as the git author/committer of the seed +
    # "Create business process" commits, so history shows who made the BP rather
    # than a mechanical identity.
    created_by: str | None = None


@router.post("/")
async def create_process(
    body: CreateProcessRequest,
    automation_service: AutomationService = Depends(get_automation_service),
) -> dict:
    """Create a new business-process directory with auto-setup.

    Scaffolds `process.toml` + `README.md` under the main copy
    (`${BITSWAN_COPIES_DIR}/main/<name>/`) or a specific copy
    (`${BITSWAN_COPIES_DIR}/<copy>/<name>/`). The new BP surfaces
    over the SSE feed within the same response (this route refreshes the
    cache + broadcasts inline instead of waiting for the filesystem watcher
    to debounce).

    Auto-setup (best-effort): the default template group
    (`BITSWAN_DEFAULT_TEMPLATE_GROUP`, default `business-process`) is
    scaffolded into the new BP, and its deploy is kicked off in the background
    — `dev` stage for a main BP, `live-dev` for a copy BP. Failures never
    fail the BP creation; they surface in the `setup_error` response field.
    """
    name = _validated_display_name(body.name)
    if body.copy is not None and not _COPY_NAME_RE.match(body.copy):
        raise HTTPException(status_code=400, detail="Invalid copy name")

    try:
        entry = await process_service.create_business_process(
            name=name, copy=body.copy, created_by=body.created_by
        )
    except FileExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create process: {e}")

    # Push the fresh snapshot to all SSE consumers so the dashboard's
    # sidebar updates without waiting for the workspace watcher tick.
    try:
        await event_broadcaster.broadcast(
            "processes", process_service.get_all_processes()
        )
    except Exception:
        pass

    # Auto-setup: scaffold the default template group into the new BP and
    # kick off its deploy in the background. Best-effort — the BP was already
    # created; any failure is logged + reported via `setup_error`.
    automations_created: list[str] = []
    deploy_task_id: str | None = None
    setup_error: str | None = None
    # Everything downstream — template scaffold, deploy members, task label —
    # keys on the slug (the directory name), not the display name.
    slug = entry["name"]
    try:
        # The default BP is one frontend + one backend worker (the baked
        # `business-process` group). There is no internal/external frontend
        # split anymore — a frontend is reachable through Bailey and access
        # is controlled by the share button; developers add more frontends or
        # workers from the dashboard's Environment panel.
        group_id = os.environ.get("BITSWAN_DEFAULT_TEMPLATE_GROUP", "business-process")
        workspace_root = os.environ.get("BITSWAN_WORKSPACE_REPO_DIR", "/workspace-repo")
        created = await template_service.create_automation_from_template(
            workspace_root=workspace_root,
            bp=slug,
            group_id=group_id,
            copy=body.copy,
            created_by=body.created_by,
        )
        automations_created = [c["name"] for c in created.get("created", [])]

        # Inline cache refresh + broadcast (mirrors routes/templates.py) so
        # the new automation cards appear without waiting for the FS watcher.
        try:
            await automation_service.refresh(body.copy)
            automations = await automation_service.get_automations()
            data = [
                a.model_dump(mode="json") if hasattr(a, "model_dump") else a
                for a in automations
            ]
            await event_broadcaster.broadcast("automations", data)
        except Exception:
            logger.exception("Failed to broadcast automations after BP scaffold")

        stage = "live-dev" if body.copy else "dev"
        members = automation_service.members_for_bp(slug, copy=body.copy, stage=stage)
        res = await spawn_set_deploy(
            label=slug,
            members=members,
            stage=stage,
            copy=body.copy,
            service=automation_service,
        )
        if res.get("deploy"):
            deploy_task_id = res["deploy"]["task_id"]
        elif res.get("error"):
            setup_error = res["error"]
    except Exception as e:
        logger.exception("BP auto-setup failed for %s", name)
        setup_error = str(e)

    entry["automations_created"] = automations_created
    entry["deploy_task_id"] = deploy_task_id
    if setup_error:
        entry["setup_error"] = setup_error
    return entry


class RenameProcessRequest(BaseModel):
    # The new human-readable display name. The slug (URL path segment) is
    # immutable — it names the directory, git repo, and deployment ids.
    name: str
    copy: str | None = None
    # Recorded as the git author of the rename commit (injected by the
    # dashboard from the validated token), mirroring `created_by` on create.
    renamed_by: str | None = None


@router.patch("/{name}")
async def rename_process(name: str, body: RenameProcessRequest) -> dict:
    """Change a business process's display name.

    `{name}` is the slug; only the `name` key in the BP's `process.toml`
    changes, so URLs, API paths, and deployment ids are untouched. Renames
    in the main scope by default; pass `copy` for a copy-only BP (the
    display name shown in the dashboard is main's whenever the BP is in
    main — see `get_all_processes`).
    """
    if not _BP_DIR_RE.match(name):
        raise HTTPException(status_code=400, detail="Invalid process slug")
    new_name = _validated_display_name(body.name)
    if body.copy is not None and not _COPY_NAME_RE.match(body.copy):
        raise HTTPException(status_code=400, detail="Invalid copy name")

    try:
        entry = await process_service.rename_business_process(
            name=name, new_name=new_name, copy=body.copy, renamed_by=body.renamed_by
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to rename process: {e}")

    # Same push-the-snapshot dance as create: SSE consumers (the dashboard's
    # BP selector) pick the new display name up without a watcher tick.
    try:
        await event_broadcaster.broadcast(
            "processes", process_service.get_all_processes()
        )
    except Exception:
        pass

    return entry
