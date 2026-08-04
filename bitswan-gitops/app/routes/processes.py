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

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
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


@router.get("/")
async def list_processes() -> dict:
    """Flat list of every known BP — same entries the `processes` SSE event
    broadcasts (id, name/slug, display_name, in_main, copies). REST so
    request/response consumers get it too: the automation-server daemon reads
    it to label a BP's endpoints with the human-readable name (#319)."""
    return {"processes": process_service.get_all_processes()}


class DeleteProcessRequest(BaseModel):
    # Injected by the dashboard proxy from the validated token — attribution
    # for the "Delete business process" commit + the queue task.
    deleted_by: str | None = None


@router.delete("/{slug}", status_code=202)
async def delete_process(
    slug: str,
    body: DeleteProcessRequest | None = None,
    automation_service: AutomationService = Depends(get_automation_service),
) -> dict:
    """Delete a business process — guarded, asynchronous, idempotent.

    Refuses (409) while the BP has staging/production deployments (the user
    tears those down first) or while any of its deployments is mid-deploy.
    404 only when NOTHING of the BP remains (yaml entries, clone dirs, bare
    repo, database registry) — so re-issuing after a partial failure finishes
    the teardown. Otherwise 202 + a task_queue task id; the heavy teardown
    (containers, DBs across all copies, git) runs serialized on the queue.
    Keeps snapshots, backups and the per-BP deploy repo history (audit).
    """
    from app.deploy_manager import deploy_manager
    from app.services import bp_delete
    from app.task_queue import task_queue
    from app.utils import read_bitswan_yaml

    if not _BP_DIR_RE.match(slug):
        raise HTTPException(status_code=400, detail="Invalid business process name")
    deleted_by = (body.deleted_by or None) if body else None

    bs_yaml = read_bitswan_yaml(automation_service.gitops_dir) or {}
    protected = bp_delete.protected_deployments(bs_yaml, slug)
    if protected:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "bp_has_protected_deployments",
                "deployments": protected,
            },
        )
    deploying = sorted(
        did
        for did in bp_delete.bp_deployments(bs_yaml, slug)
        if deploy_manager.is_deploying(did)
    )
    if deploying:
        raise HTTPException(
            status_code=409,
            detail={"error": "deploy_in_progress", "deployments": deploying},
        )
    if not bp_delete.bp_has_remnants(bs_yaml, slug):
        raise HTTPException(
            status_code=404, detail=f"No business process '{slug}' found"
        )

    async def _run() -> dict:
        return await bp_delete.delete_business_process(
            slug, deleted_by, automation_service
        )

    task_id = task_queue.submit(
        "delete-bp", _run, requester_email=deleted_by, label=slug
    )
    return {"task_id": task_id, "bp": slug, "status": "pending"}


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

    # A BP is born in MAIN (skeleton scaffold + published to the repo's main), so
    # it is in_main and copy-switchable immediately; the requesting copy is
    # materialized from main below, after the template automations are also added
    # to main. (Historically it rode the copy's branch and main stayed empty until
    # Sync & Deploy — leaving a fresh BP invisible to every other copy.)
    if body.copy is not None:
        copy_root = os.path.join(
            os.environ.get("BITSWAN_COPIES_DIR", "/copies"), body.copy
        )
        if not os.path.isdir(copy_root):
            raise HTTPException(
                status_code=400, detail=f"copy '{body.copy}' does not exist"
            )
    try:
        entry = await process_service.create_business_process(
            name=name, created_by=body.created_by
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
        # Scaffold the template into MAIN (copy=None) so the whole BP skeleton —
        # process.toml + frontend/backend — lands in the repo's main first.
        created = await template_service.create_automation_from_template(
            workspace_root=workspace_root,
            bp=slug,
            group_id=group_id,
            copy=None,
            created_by=body.created_by,
        )
        automations_created = [c["name"] for c in created.get("created", [])]

        # Now that main carries the full skeleton, materialize the requesting copy
        # as a clone of main (branch = copy). This is what makes the BP switchable
        # into other copies immediately; the user's later edits ride this branch
        # until Sync & Deploy, exactly as before.
        if body.copy:
            from app.services.bp_git import clone_bp_into_copy

            # `clone_bp_into_copy(copy_path, copy, bp, …)` keys `bp` on the SLUG
            # (bp_bare_repo_path(bp)) — NOT the human-readable display name. Passing
            # `name` here materialized the copy under the wrong id (or not at all),
            # so `copies/<copy>/<slug>` never appeared, the BP's `copies` omitted the
            # requesting copy, and the dashboard rendered the read-only README
            # instead of the editable spec (bpInWt=false). Use the slug.
            await clone_bp_into_copy(copy_root, body.copy, slug, base="main")
            entry["copies"] = [body.copy]
            entry["has_copies"] = True
            entry["in_main"] = True

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


# Cap the buffered upload: bundles are source-only (no docker images), so even
# a large BP is a few MB — 100 MB is generous headroom, not an invitation.
_MAX_BUNDLE_BYTES = 100 * 1024 * 1024


@router.post("/from-bundle")
async def create_process_from_bundle(
    file: UploadFile = File(...),
    name: str | None = Form(None),
    copy: str | None = Form(None),
    created_by: str | None = Form(None),
    automation_service: AutomationService = Depends(get_automation_service),
) -> dict:
    """Restore a business process from a downloaded deployment bundle
    (issue #82 — the Inspect → Download bundle archive had no way back in).

    Multipart: `file` is the ``bitswan-bp-bundle/2`` tar.gz; `name` optionally
    overrides the bundle's display name (omit to keep it); `copy`/`created_by`
    behave exactly like create. The bundle's source tree becomes a NEW BP —
    fresh process-id and deployment ids, so it never collides with the BP it
    was bundled from — and the same post-create auto-setup runs, EXCEPT the
    template scaffold (the source already carries the member automations):
    the copy is materialized from main and a deploy of the restored members is
    kicked off in the background (images rebuild, databases provision fresh).
    """
    if not (file.filename or "").endswith((".tar.gz", ".tgz")):
        raise HTTPException(status_code=400, detail="File must be a .tar.gz bundle")
    if name is not None:
        name = _validated_display_name(name)
    if copy is not None and not _COPY_NAME_RE.match(copy):
        raise HTTPException(status_code=400, detail="Invalid copy name")
    if copy is not None:
        copy_root = os.path.join(os.environ.get("BITSWAN_COPIES_DIR", "/copies"), copy)
        if not os.path.isdir(copy_root):
            raise HTTPException(status_code=400, detail=f"copy '{copy}' does not exist")

    # Buffer with a hard cap — a bundle that big is not a source-only bundle.
    data = bytearray()
    while chunk := await file.read(1024 * 1024):
        data.extend(chunk)
        if len(data) > _MAX_BUNDLE_BYTES:
            raise HTTPException(status_code=413, detail="Bundle too large (max 100 MB)")

    try:
        entry = await process_service.create_business_process_from_bundle(
            bundle=bytes(data), name=name, created_by=created_by
        )
    except FileExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to restore process: {e}")

    # Same post-create dance as create_process, minus the template scaffold
    # (the bundle's source already carries the member automations).
    try:
        await event_broadcaster.broadcast(
            "processes", process_service.get_all_processes()
        )
    except Exception:
        pass

    deploy_task_id: str | None = None
    setup_error: str | None = None
    slug = entry["name"]
    try:
        if copy:
            from app.services.bp_git import clone_bp_into_copy

            await clone_bp_into_copy(copy_root, copy, slug, base="main")
            entry["copies"] = [copy]
            entry["has_copies"] = True
            entry["in_main"] = True

        try:
            await automation_service.refresh(copy)
            automations = await automation_service.get_automations()
            data_out = [
                a.model_dump(mode="json") if hasattr(a, "model_dump") else a
                for a in automations
            ]
            await event_broadcaster.broadcast("automations", data_out)
        except Exception:
            logger.exception("Failed to broadcast automations after BP restore")

        stage = "live-dev" if copy else "dev"
        members = automation_service.members_for_bp(slug, copy=copy, stage=stage)
        res = await spawn_set_deploy(
            label=slug,
            members=members,
            stage=stage,
            copy=copy,
            service=automation_service,
        )
        if res.get("deploy"):
            deploy_task_id = res["deploy"]["task_id"]
        elif res.get("error"):
            setup_error = res["error"]
    except Exception as e:
        logger.exception("BP restore auto-setup failed for %s", slug)
        setup_error = str(e)

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
