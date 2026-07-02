import asyncio
import json as _json
import logging
import os

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
)
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from pydantic import BaseModel

from app.deploy_manager import DeployStatus, DeployStep, deploy_manager
from app.event_broadcaster import event_broadcaster
from app.services.automation_service import AutomationService, make_hostname_label
from app.dependencies import get_automation_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/automations", tags=["automations"])

# Strong references to background deploy tasks — prevents GC before completion
_bg_tasks: set[asyncio.Task] = set()


def _spawn_bg(coro) -> asyncio.Task:
    t = asyncio.create_task(coro)
    _bg_tasks.add(t)
    t.add_done_callback(_bg_tasks.discard)
    return t


@router.get("/")
async def get_automations(
    automation_service: AutomationService = Depends(get_automation_service),
):
    # Now fully async using aiohttp Docker client
    return await automation_service.get_automations()


class StartDeployRequest(BaseModel):
    relative_path: str
    stage: str  # "dev" or "live-dev"
    copy: str | None = None


class DeployBPRequest(BaseModel):
    bp: str
    stage: str  # "dev" or "live-dev"
    copy: str | None = None
    deployed_by: str | None = None


class PromoteBPRequest(BaseModel):
    bp: str
    stage: str  # "staging" or "production"
    deployed_by: str | None = None


class RollbackBPRequest(BaseModel):
    stage: str  # "dev" | "staging" | "production"
    git_commit: str
    deployed_by: str | None = None
    kind: str = "deploy"  # "deploy" | "firewall"
    role: str | None = None  # caller's Bailey role (for production firewall gating)


@router.get("/business-processes/{bp}/history")
async def get_bp_history(
    bp: str,
    stage: str = Query("dev"),
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Deployment history for one BP stage (newest-first; `current` = live).
    Derived from the git log of bitswan.yaml."""
    return await automation_service.bp_history(bp, stage)


@router.get("/business-processes/{bp}/diff")
async def get_bp_diff(
    bp: str,
    from_sha: str = Query(..., alias="from"),
    to: str = Query(...),
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Unified diff of a BP's source between two commits (history "diff vs current")."""
    return await automation_service.bp_diff(bp, from_sha, to)


class ScaleBPRequest(BaseModel):
    stage: str
    replicas: int


@router.post("/business-processes/{bp}/scale")
async def scale_bp(
    bp: str,
    body: ScaleBPRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Scale every member container of a BP stage (Inspect → Scale)."""
    if body.replicas < 1:
        raise HTTPException(status_code=400, detail="replicas must be at least 1")
    return await automation_service.scale_business_process(
        bp, body.stage, body.replicas
    )


class BpSecretsRequest(BaseModel):
    # Secret NAMES are shared across stages; VALUES are per stage. The editor
    # sends every realm's {KEY: value} map: {dev, staging, production}.
    values: dict[str, dict[str, str]]
    deployed_by: str | None = None


@router.get("/business-processes/{bp}/secrets")
async def get_bp_secrets_route(
    bp: str,
    by: str | None = None,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """A BP's decrypted per-stage secrets: {dev, staging, production} each a
    {KEY: value} map (Deployments → Secrets). Production values are redacted
    unless `by` (a shim-verified email) resolves to admin/auditor."""
    return automation_service.read_bp_secrets(bp, by=by)


@router.put("/business-processes/{bp}/secrets")
async def put_bp_secrets_route(
    bp: str,
    body: BpSecretsRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Apply a BP's secrets: encrypt + version them in bitswan.yaml as one commit
    (so they roll back together) and re-derive each stage's env file. Names are
    shared across stages; values are per stage. Take effect on the next deploy."""
    return await automation_service.write_bp_secrets(bp, body.values, body.deployed_by)


class DrPolicyRequest(BaseModel):
    policy: str
    deployed_by: str | None = None


class DrTestRequest(BaseModel):
    by: str | None = None
    note: str | None = None
    snapshot: str | None = None
    deployed_by: str | None = None


@router.get("/user-role")
async def get_user_role_route(email: str):
    """The authoritative Bailey role for an email, resolved from the
    automation-server daemon (the same store the People & roles view uses,
    never SSO groups). The dashboard shim calls this with the identity it has
    already verified from the user's access token; gitops bridges to the daemon
    over its trusted local socket. Fails closed (500) if the daemon can't be
    reached, so the caller treats the user as unprivileged."""
    from app.utils import daemon_user_role

    return {"email": email, "role": daemon_user_role(email)}


@router.get("/business-processes/{bp}/dr")
async def get_bp_dr_route(
    bp: str,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """A BP's disaster-recovery status: test cadence policy, the manual
    recovery-test log (newest-first), and the derived overdue flag."""
    return automation_service.read_dr(bp)


@router.put("/business-processes/{bp}/dr/policy")
async def put_bp_dr_policy_route(
    bp: str,
    body: DrPolicyRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Set a BP's recovery-test cadence policy (versioned in bitswan.yaml)."""
    try:
        return await automation_service.write_dr_policy(
            bp, body.policy, body.deployed_by
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/business-processes/{bp}/dr/tests")
async def post_bp_dr_test_route(
    bp: str,
    body: DrTestRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Record a hand-performed recovery test for a BP (versioned in bitswan.yaml,
    prepended so the log stays newest-first). Only the backup currently restored
    into DR may be tested — otherwise 400."""
    try:
        return await automation_service.record_dr_test(
            bp, body.by, body.note, body.snapshot, body.deployed_by
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


class BackupRetentionRequest(BaseModel):
    daily: int = 7
    weekly: int = 0
    monthly: int = 3
    by: str | None = None


class BackupSwapRequest(BaseModel):
    by: str | None = None
    role: str | None = None


@router.get("/business-processes/{bp}/backups")
async def get_bp_backups_route(
    bp: str,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """A BP's backup state: which production slot is live (Production) vs standby
    (DR), the retention policy, and the recent audit log (newest-first)."""
    return automation_service.read_backups(bp)


@router.put("/business-processes/{bp}/backups/retention")
async def put_bp_backup_retention_route(
    bp: str,
    body: BackupRetentionRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Set the production backup retention policy (versioned + audited)."""
    return await automation_service.set_backup_retention(
        bp,
        {"daily": body.daily, "weekly": body.weekly, "monthly": body.monthly},
        body.by,
    )


@router.post("/business-processes/{bp}/backups/swap")
async def post_bp_backup_swap_route(
    bp: str,
    body: BackupSwapRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """DR go-live swap: flip which production slot is live and repoint the
    production ingress to it (zero downtime, no data moved)."""
    try:
        return await automation_service.swap_production_dr(bp, body.by, body.role)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.post("/business-processes/{bp}/backups/promote")
async def post_bp_zero_downtime_promote_route(
    bp: str,
    body: BackupSwapRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Zero-downtime production promote: stage the new version on the idle app
    slot (wired to the current live db), bring it up, repoint the ingress to
    it, and retire the old slot. The database never moves."""
    try:
        return await automation_service.zero_downtime_promote(bp, body.by)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


class SupplyChainWaiverRequest(BaseModel):
    # Out-of-scope markings live in the source tree, so they're authored against
    # a COPY (from the Checks tab) — never a deployment stage.
    copy: str | None = None
    package: str
    cve: str
    comment: str | None = None
    by: str | None = None


@router.get("/business-processes/{bp}/supply-chain")
async def get_bp_supply_chain(
    bp: str,
    stage: str = Query("dev"),
    automation_service: AutomationService = Depends(get_automation_service),
):
    """SBOM packages + CVEs (syft/grype) for the image(s) deployed to a BP stage,
    plus the out-of-scope waiver log."""
    return automation_service.read_supply_chain(bp, stage)


@router.get("/business-processes/{bp}/supply-chain/preview")
async def get_bp_supply_chain_preview(
    bp: str,
    copy: str | None = Query(None),
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Pre-deploy SBOM + CVEs for the image(s) a deploy of this BP WOULD build
    from the current source (Sync & Deploy → Checks). Builds the content-
    addressed image (cache hit when unchanged) and scans it; same response
    shape as the deployed supply-chain rollup."""
    return await automation_service.preview_supply_chain(bp, copy)


@router.post("/business-processes/{bp}/supply-chain/waivers")
async def post_bp_supply_chain_waiver(
    bp: str,
    body: SupplyChainWaiverRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Mark a CVE out of scope — stored in the copy's source tree (cve-waivers.yaml,
    committed) so it rides Sync & Deploy to main with the code."""
    return await automation_service.set_cve_waiver(
        bp, body.copy, body.package, body.cve, body.comment or "", body.by
    )


@router.delete("/business-processes/{bp}/supply-chain/waivers")
async def delete_bp_supply_chain_waiver(
    bp: str,
    body: SupplyChainWaiverRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Restore a previously out-of-scope CVE to in-scope (commit in the copy)."""
    return await automation_service.unset_cve_waiver(
        bp, body.copy, body.package, body.cve, body.by
    )


class FirewallRuleRequest(BaseModel):
    stage: str
    host: str
    status: str = "allowed"  # allowed | denied
    purpose: str | None = None
    gdpr: dict | None = None
    by: str | None = None
    role: str | None = None  # caller's Bailey role (admin/auditor) for prod gating


class FirewallDeleteRequest(BaseModel):
    stage: str
    host: str
    by: str | None = None
    role: str | None = None


class FirewallPromoteRequest(BaseModel):
    from_stage: str
    to_stage: str
    by: str | None = None
    role: str | None = None


@router.get("/business-processes/{bp}/firewall")
async def get_bp_firewall(
    bp: str,
    stage: str = Query("dev"),
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Egress allow-list rules + blocked/observed attempts for a BP stage."""
    return automation_service.read_firewall(bp, stage)


@router.put("/business-processes/{bp}/firewall/rules")
async def put_bp_firewall_rule(
    bp: str,
    body: FirewallRuleRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Allow/deny an outbound host (versioned in bitswan.yaml). Production
    changes require an admin/auditor role."""
    return await automation_service.set_firewall_rule(
        bp,
        body.stage,
        body.host,
        body.status,
        body.purpose or "",
        body.gdpr,
        body.by,
        body.role,
    )


@router.delete("/business-processes/{bp}/firewall/rules")
async def delete_bp_firewall_rule(
    bp: str,
    body: FirewallDeleteRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Remove a firewall rule (revoke/clear)."""
    return await automation_service.delete_firewall_rule(
        bp, body.stage, body.host, body.by, body.role
    )


@router.post("/business-processes/{bp}/firewall/promote")
async def promote_bp_firewall(
    bp: str,
    body: FirewallPromoteRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Pull firewall rules forward (dev→staging→production)."""
    return await automation_service.promote_firewall(
        bp, body.from_stage, body.to_stage, body.by, body.role
    )


@router.post("/business-processes/{bp}/firewall/dpa")
async def upload_bp_firewall_dpa(
    bp: str,
    stage: str = Form(...),
    host: str = Form(...),
    by: str | None = Form(None),
    role: str | None = Form(None),
    file: UploadFile = File(...),
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Upload a host's GDPR data-processing-agreement PDF; stored + versioned in
    the gitops repo under firewall-dpa/<bp>/. Production needs admin/auditor."""
    content = await file.read()
    return await automation_service.store_firewall_dpa(
        bp, stage, host, content, filename=file.filename, by=by, role=role
    )


@router.get("/business-processes/{bp}/firewall/dpa")
async def get_bp_firewall_dpa(
    bp: str,
    host: str = Query(...),
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Download a host's stored DPA PDF (shared across stages for the host)."""
    path = automation_service.firewall_dpa_path(bp, host)
    if not path:
        raise HTTPException(status_code=404, detail="No DPA on file for that host")
    return FileResponse(path, media_type="application/pdf")


@router.get("/business-processes/{bp}/files")
async def get_bp_files(
    bp: str,
    commit: str = Query(...),
    automation_service: AutomationService = Depends(get_automation_service),
):
    """The full source tree of a BP at a commit (Inspect → Files)."""
    return await automation_service.bp_file_tree(bp, commit)


@router.get("/business-processes/{bp}/file-content")
async def get_bp_file_content(
    bp: str,
    commit: str = Query(...),
    path: str = Query(...),
    automation_service: AutomationService = Depends(get_automation_service),
):
    """A single file's content from a BP's source at a commit (Inspect → Files)."""
    return await automation_service.bp_file_content(bp, commit, path)


@router.post("/business-processes/{bp}/rollback")
async def rollback_bp(
    bp: str,
    body: RollbackBPRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Roll a BP stage back to a prior state. `kind=deploy` (default) re-points
    the member deployments to a prior version; `kind=firewall` restores the
    stage's egress allow-list to a prior commit (production needs admin/auditor).
    Both come from the same git-derived history timeline."""
    if body.kind == "firewall":
        return await automation_service.rollback_firewall(
            bp=bp,
            stage=body.stage,
            git_commit=body.git_commit,
            by=body.deployed_by,
            role=body.role,
        )
    return await automation_service.rollback_business_process(
        bp=bp,
        stage=body.stage,
        git_commit=body.git_commit,
        deployed_by=body.deployed_by,
    )


@router.post("/start-deploy")
async def start_deploy(
    body: StartDeployRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Deploy an automation from the bind-mounted workspace.

    Replaces the editor's upload+deploy flow for environments where the
    workspace is co-located with gitops. The body is intentionally minimal
    (relative_path, stage, copy?) — gitops reads the automation source
    directly from `/workspace-repo`,
    computes the merged-tree checksum, materialises `<checksum>/` if needed,
    and kicks off the existing deploy pipeline.
    """
    prep = await automation_service.start_deploy_from_workspace(
        relative_path=body.relative_path,
        stage=body.stage,
        copy=body.copy,
    )

    _spawn_bg(
        _run_deploy_with_progress(
            prep["task_id"],
            prep["deployment_id"],
            automation_service,
            prep["deploy_kwargs"],
        )
    )

    workspace_name = os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace-local")
    gitops_domain = os.environ.get("BITSWAN_GITOPS_DOMAIN", "")
    url = ""
    if gitops_domain:
        source = prep["source"]
        label = make_hostname_label(
            workspace_name,
            source["automation_name"],
            source["context"],
            body.stage,
        )
        url = f"https://{label}.{gitops_domain}"

    return JSONResponse(
        status_code=202,
        content={
            "task_id": prep["task_id"],
            "deployment_id": prep["deployment_id"],
            "checksum": prep["checksum"],
            "url": url,
            "status": "pending",
        },
    )


@router.post("/deploy-bp")
async def deploy_bp(
    body: DeployBPRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Deploy ALL automations under one business process as a single unit.

    Enumerates the BP's member automations, reserves them all atomically
    (409 if any member is already deploying), then runs one batched deploy
    (prep all → one bitswan.yaml write → one `docker compose up`). Progress is
    tracked under a single BP-level task broadcast over the `deploy_progress`
    SSE event and pollable via `/automations/deploy-status/{task_id}`.
    """
    if body.stage not in ("dev", "live-dev"):
        raise HTTPException(
            status_code=400,
            detail="Stage must be one of: dev, live-dev",
        )

    members = automation_service.members_for_bp(
        body.bp, copy=body.copy, stage=body.stage
    )
    if not members:
        ctx = f" in copy '{body.copy}'" if body.copy else ""
        raise HTTPException(
            status_code=404,
            detail=f"No deployable automations under BP '{body.bp}'{ctx}",
        )

    deployment_ids = [
        automation_service.deployment_id_for(m, body.stage) for m in members
    ]

    task, conflict = await deploy_manager.create_bp_task(body.bp, deployment_ids)
    if task is None:
        raise HTTPException(
            status_code=409,
            detail=f"Deployment {conflict} is already in progress",
        )

    _spawn_bg(
        _run_bp_deploy_with_progress(
            task.task_id,
            body.bp,
            deployment_ids,
            automation_service,
            stage=body.stage,
            copy=body.copy,
            members=members,
            deployed_by=body.deployed_by,
        )
    )

    return JSONResponse(
        status_code=202,
        content={
            "task_id": task.task_id,
            "bp": body.bp,
            "deployment_ids": deployment_ids,
            "status": "pending",
        },
    )


@router.post("/promote-bp")
async def promote_bp(
    body: PromoteBPRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Promote ALL automations under one business process from the previous
    stage to `stage` as a single unit (dev→staging or staging→production).

    Re-deploys each member at its source stage's recorded checksum — no image
    builds. Reserves all target deployments atomically (409 if any is already
    deploying); progress is tracked under one BP-level task broadcast over the
    `deploy_progress` SSE event and pollable via
    `/automations/deploy-status/{task_id}`.
    """
    if body.stage not in ("staging", "production"):
        raise HTTPException(
            status_code=400,
            detail="Stage must be one of: staging, production",
        )

    members = automation_service.promotable_bp_members(body.bp, body.stage)
    if not members:
        source_stage = "dev" if body.stage == "staging" else "staging"
        raise HTTPException(
            status_code=404,
            detail=(f"No {source_stage} deployments to promote under BP '{body.bp}'"),
        )

    deployment_ids = [m["deployment_id"] for m in members]

    task, conflict = await deploy_manager.create_bp_task(body.bp, deployment_ids)
    if task is None:
        raise HTTPException(
            status_code=409,
            detail=f"Deployment {conflict} is already in progress",
        )

    _spawn_bg(
        _run_bp_promote_with_progress(
            task.task_id,
            body.bp,
            automation_service,
            stage=body.stage,
            members=members,
            deployed_by=body.deployed_by,
        )
    )

    return JSONResponse(
        status_code=202,
        content={
            "task_id": task.task_id,
            "bp": body.bp,
            "stage": body.stage,
            "deployment_ids": deployment_ids,
            "status": "pending",
        },
    )


@router.post("/deploy")
async def deploy_automations(
    automation_service: AutomationService = Depends(get_automation_service),
):
    return await automation_service.deploy_automations()


@router.post("/pull-and-deploy/{branch_name}")
async def pull_and_deploy(
    branch_name: str,
    automation_service: AutomationService = Depends(get_automation_service),
):
    return await automation_service.pull_and_deploy(branch_name)


async def _run_deploy_with_progress(
    task_id: str,
    deployment_id: str,
    automation_service: AutomationService,
    deploy_kwargs: dict,
):
    """Background coroutine that runs deploy_automation with progress broadcasting."""

    async def progress_callback(step: str, message: str):
        # Never set COMPLETED here — only _run_deploy_with_progress decides success/failure
        deploy_step = DeployStep.coerce(step)
        await deploy_manager.update_task(
            task_id,
            status=DeployStatus.IN_PROGRESS,
            step=deploy_step,
            message=message,
        )
        task = deploy_manager.get_task(task_id)
        if task:
            await event_broadcaster.broadcast("deploy_progress", task.to_dict())

    async def _broadcast_task():
        task = deploy_manager.get_task(task_id)
        if task:
            await event_broadcaster.broadcast("deploy_progress", task.to_dict())

    try:
        await deploy_manager.update_task(
            task_id, status=DeployStatus.IN_PROGRESS, message="Starting deployment..."
        )
        await _broadcast_task()

        await automation_service.deploy_automation(
            **deploy_kwargs, progress_callback=progress_callback
        )

        # deploy_automation returned without exception → success
        await deploy_manager.update_task(
            task_id,
            status=DeployStatus.COMPLETED,
            step=DeployStep.DONE,
            message="Deployment completed successfully",
        )
        await _broadcast_task()
    except Exception as exc:
        logger.exception("Deploy failed for %s (task %s)", deployment_id, task_id)
        error_detail = str(exc)
        if hasattr(exc, "detail"):
            error_detail = exc.detail
        await deploy_manager.update_task(
            task_id,
            status=DeployStatus.FAILED,
            error=error_detail,
            message="Deployment failed",
        )
        await _broadcast_task()
    finally:
        # Safety net: free the deployment lock however this ends — including
        # cancellation, which `except Exception` cannot catch and which would
        # otherwise leak the lock and 409 every future deploy.
        deploy_manager.release(task_id)


async def _run_bp_deploy_with_progress(
    task_id: str,
    bp: str,
    deployment_ids: list[str],
    automation_service: AutomationService,
    stage: str,
    copy: str | None,
    members: list[dict],
    deployed_by: str | None = None,
):
    """Background coroutine running a BP deploy with progress broadcasting.

    Mirrors `_run_deploy_with_progress` but drives `deploy_business_process`.
    On terminal status, `deploy_manager.update_task` releases every member lock.
    """

    async def progress_callback(step: str, message: str, current: int | None = None):
        deploy_step = DeployStep.coerce(step)
        if current is not None:
            await deploy_manager.set_current(task_id, current)
        await deploy_manager.update_task(
            task_id,
            status=DeployStatus.IN_PROGRESS,
            step=deploy_step,
            message=message,
        )
        task = deploy_manager.get_task(task_id)
        if task:
            await event_broadcaster.broadcast("deploy_progress", task.to_dict())

    async def _broadcast_task():
        task = deploy_manager.get_task(task_id)
        if task:
            await event_broadcaster.broadcast("deploy_progress", task.to_dict())

    try:
        await deploy_manager.update_task(
            task_id,
            status=DeployStatus.IN_PROGRESS,
            message=f"Deploying business process {bp}...",
        )
        await _broadcast_task()

        await automation_service.deploy_business_process(
            bp=bp,
            stage=stage,
            copy=copy,
            members=members,
            deployed_by=deployed_by,
            progress_callback=progress_callback,
        )

        await deploy_manager.update_task(
            task_id,
            status=DeployStatus.COMPLETED,
            step=DeployStep.DONE,
            message="Business process deployed successfully",
        )
        await _broadcast_task()
    except Exception as exc:
        logger.exception("BP deploy failed for %s (task %s)", bp, task_id)
        error_detail = str(exc)
        if hasattr(exc, "detail"):
            error_detail = exc.detail
        await deploy_manager.update_task(
            task_id,
            status=DeployStatus.FAILED,
            error=error_detail,
            message="Business process deployment failed",
        )
        await _broadcast_task()
    finally:
        # Safety net: free every member lock however this ends — including
        # cancellation, which `except Exception` cannot catch and which would
        # otherwise leak the locks and 409 every future deploy of this BP.
        deploy_manager.release(task_id)


async def _run_bp_promote_with_progress(
    task_id: str,
    bp: str,
    automation_service: AutomationService,
    stage: str,
    members: list[dict],
    deployed_by: str | None = None,
):
    """Background coroutine running a BP promotion with progress broadcasting.

    Mirrors `_run_bp_deploy_with_progress` but drives `promote_business_process`.
    On terminal status, `deploy_manager.update_task` releases every member lock.
    """

    async def progress_callback(step: str, message: str, current: int | None = None):
        deploy_step = DeployStep.coerce(step)
        if current is not None:
            await deploy_manager.set_current(task_id, current)
        await deploy_manager.update_task(
            task_id,
            status=DeployStatus.IN_PROGRESS,
            step=deploy_step,
            message=message,
        )
        task = deploy_manager.get_task(task_id)
        if task:
            await event_broadcaster.broadcast("deploy_progress", task.to_dict())

    async def _broadcast_task():
        task = deploy_manager.get_task(task_id)
        if task:
            await event_broadcaster.broadcast("deploy_progress", task.to_dict())

    try:
        await deploy_manager.update_task(
            task_id,
            status=DeployStatus.IN_PROGRESS,
            message=f"Promoting business process {bp} to {stage}...",
        )
        await _broadcast_task()

        await automation_service.promote_business_process(
            bp=bp,
            target_stage=stage,
            members=members,
            deployed_by=deployed_by,
            progress_callback=progress_callback,
        )

        await deploy_manager.update_task(
            task_id,
            status=DeployStatus.COMPLETED,
            step=DeployStep.DONE,
            message=f"Business process promoted to {stage} successfully",
        )
        await _broadcast_task()
    except Exception as exc:
        logger.exception("BP promote failed for %s (task %s)", bp, task_id)
        error_detail = str(exc)
        if hasattr(exc, "detail"):
            error_detail = exc.detail
        await deploy_manager.update_task(
            task_id,
            status=DeployStatus.FAILED,
            error=error_detail,
            message="Business process promotion failed",
        )
        await _broadcast_task()
    finally:
        # Safety net: free every member lock however this ends — including
        # cancellation, which `except Exception` cannot catch and which would
        # otherwise leak the locks and 409 every future promote of this BP.
        deploy_manager.release(task_id)


@router.get("/deploy-status/{task_id}")
async def get_deploy_status(task_id: str):
    """Poll fallback for SSE drops — returns current deploy task state."""
    task = deploy_manager.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Deploy task not found")
    return task.to_dict()


@router.post("/{deployment_id}/deploy")
async def deploy_automation(
    deployment_id: str,
    checksum: str | None = Form(None),
    stage: str | None = Form(None),
    relative_path: str | None = Form(None),
    services: str | None = Form(None),  # JSON: {"kafka": {"enabled": true}, ...}
    replicas: str | None = Form(None),
    deployed_by: str | None = Form(None),
    automation_name_field: str | None = Form(None, alias="automation_name"),
    context_field: str | None = Form(None, alias="context"),
    automation_service: AutomationService = Depends(get_automation_service),
):
    # Guard: reject if already deploying
    if deploy_manager.is_deploying(deployment_id):
        raise HTTPException(
            status_code=409,
            detail=f"Deployment {deployment_id} is already in progress",
        )

    # Validate stage if provided
    if stage is not None and stage not in [
        "dev",
        "staging",
        "production",
        "live-dev",
    ]:
        raise HTTPException(
            status_code=400,
            detail="Stage must be one of: dev, staging, production, live-dev",
        )

    replicas_int = int(replicas) if replicas else None

    services_dict = None
    if services:
        try:
            services_dict = _json.loads(services)
        except _json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid services JSON")

    # Create tracked deploy task
    task = await deploy_manager.create_task(deployment_id)
    if task is None:
        raise HTTPException(
            status_code=409,
            detail=f"Deployment {deployment_id} is already in progress",
        )

    deploy_kwargs = dict(
        deployment_id=deployment_id,
        checksum=checksum,
        stage=stage,
        relative_path=relative_path,
        automation_name=automation_name_field,
        context=context_field,
        services=services_dict,
        replicas=replicas_int,
        deployed_by=deployed_by,
    )

    # Spawn background task — returns 202 immediately
    _spawn_bg(
        _run_deploy_with_progress(
            task.task_id, deployment_id, automation_service, deploy_kwargs
        )
    )

    return JSONResponse(
        status_code=202,
        content={
            "task_id": task.task_id,
            "deployment_id": deployment_id,
            "status": "pending",
        },
    )


@router.post("/{deployment_id}/start")
async def start_automation(
    deployment_id: str,
    automation_service: AutomationService = Depends(get_automation_service),
):
    # Now fully async using aiohttp Docker client
    return await automation_service.start_automation(deployment_id)


@router.post("/{deployment_id}/stop")
async def stop_automation(
    deployment_id: str,
    automation_service: AutomationService = Depends(get_automation_service),
):
    return await automation_service.stop_automation(deployment_id)


@router.post("/{deployment_id}/restart")
async def restart_automation(
    deployment_id: str,
    automation_service: AutomationService = Depends(get_automation_service),
):
    # Now fully async using aiohttp Docker client
    return await automation_service.restart_automation(deployment_id)


@router.get("/{deployment_id}/logs/stream")
async def stream_automation_logs(
    deployment_id: str,
    lines: int = Query(200, ge=1, le=10000),
    since: int = Query(0, ge=0),
    automation_service: AutomationService = Depends(get_automation_service),
):
    return StreamingResponse(
        automation_service.stream_automation_logs(
            deployment_id, lines=lines, since=since
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/{deployment_id}/inspect")
async def inspect_automation(
    deployment_id: str,
    automation_service: AutomationService = Depends(get_automation_service),
):
    return await automation_service.inspect_automation(deployment_id)


@router.delete("/{deployment_id}")
async def delete_automation(
    deployment_id: str,
    automation_service: AutomationService = Depends(get_automation_service),
):
    return await automation_service.delete_automation(deployment_id)
