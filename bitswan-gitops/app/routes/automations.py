import asyncio
import json as _json
import logging
import os
from typing import Annotated

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
from starlette.background import BackgroundTask

from pydantic import BaseModel

from app.deploy_manager import DeployStatus, DeployStep, deploy_manager
from app.event_broadcaster import event_broadcaster
from app.services.automation_service import AutomationService, make_hostname_label
from app.services.git_server import validate_bp_name
from app.dependencies import get_automation_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/automations", tags=["automations"])


def _require_valid_bp(bp: str) -> None:
    """Boundary guard for business-process names (#130): every route that takes
    a `bp` rejects unsafe names (path separators, `..`, leading `-`/`.`) BEFORE
    the name can reach a filesystem path or a git cwd."""
    try:
        validate_bp_name(bp)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


def _validated_bp(bp: str) -> str:
    """FastAPI dependency form of `_require_valid_bp` for `{bp}` path params."""
    _require_valid_bp(bp)
    return bp


# Annotate a route's `bp` path param with this to get the #130 guard.
ValidBp = Annotated[str, Depends(_validated_bp)]

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
    bp: ValidBp,
    stage: str = Query("dev"),
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Deployment history for one BP stage (newest-first; `current` = live).
    Derived from the git log of bitswan.yaml."""
    return await automation_service.bp_history(bp, stage)


@router.get("/business-processes/{bp}/diff")
async def get_bp_diff(
    bp: ValidBp,
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
    bp: ValidBp,
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
    bp: ValidBp,
    by: str | None = None,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """A BP's decrypted per-stage secrets: {dev, staging, production} each a
    {KEY: value} map (Deployments → Secrets). Production values are redacted
    unless `by` (a shim-verified email) resolves to admin/auditor."""
    return automation_service.read_bp_secrets(bp, by=by)


@router.put("/business-processes/{bp}/secrets")
async def put_bp_secrets_route(
    bp: ValidBp,
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


@router.get("/workspace-auditors")
async def get_workspace_auditors_route():
    """Every user in the workspace who can audit (admin or auditor role), as
    [{email, role}]. Backs the dashboard Audits panel's "ask an auditor" list.
    Resolved from the automation-server daemon (never SSO groups)."""
    from app.utils import daemon_auditors

    return {"users": daemon_auditors()}


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
    bp: ValidBp,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """A BP's disaster-recovery status: test cadence policy, the manual
    recovery-test log (newest-first), and the derived overdue flag."""
    return automation_service.read_dr(bp)


@router.put("/business-processes/{bp}/dr/policy")
async def put_bp_dr_policy_route(
    bp: ValidBp,
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
    bp: ValidBp,
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


class StagingFreezeRequest(BaseModel):
    frozen: bool
    by: str | None = None


class AuditPolicyRequest(BaseModel):
    required: int
    by: str | None = None


class AuditSignoffRequest(BaseModel):
    verdict: str  # "approve" | "reject"
    note: str | None = None
    by: str | None = None


@router.get("/business-processes/{bp}/staging-gate")
async def get_bp_staging_gate_route(
    bp: ValidBp,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """A BP's staging freeze + production-promotion audit state: frozen flag +
    who/when/which image, the audit policy (required sign-offs), the audit log
    (newest-first), and the derived `promotable` flag."""
    return automation_service.read_staging_gate(bp)


@router.put("/business-processes/{bp}/staging-gate/freeze")
async def put_bp_staging_freeze_route(
    bp: ValidBp,
    body: StagingFreezeRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Freeze/unfreeze staging (admin/auditor only, versioned in bitswan.yaml).
    Freezing locks the staging image for audit and closes dev→staging."""
    try:
        return await automation_service.set_staging_freeze(bp, body.frozen, body.by)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/business-processes/{bp}/staging-gate/policy")
async def put_bp_audit_policy_route(
    bp: ValidBp,
    body: AuditPolicyRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Set how many auditor sign-offs a frozen staging image needs before it can
    be promoted to Production (admin/auditor only; 0 = gating off)."""
    try:
        return await automation_service.set_audit_policy(bp, body.required, body.by)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/business-processes/{bp}/staging-gate/audits")
async def post_bp_audit_route(
    bp: ValidBp,
    body: AuditSignoffRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Record one audit sign-off (approve / request changes) on the frozen
    staging image (admin/auditor only, appended to the audit log in
    bitswan.yaml)."""
    try:
        return await automation_service.record_audit(
            bp, body.verdict, body.note, body.by
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


class BackupRetentionRequest(BaseModel):
    daily: int = 7
    weekly: int = 0
    monthly: int = 3
    by: str | None = None


class BackupSwapRequest(BaseModel):
    # Attribution only. The DR swap / zero-downtime promote role gate resolves
    # the caller's role authoritatively from `by` via the daemon store (BSY-03 /
    # #182) — a caller-supplied role is never trusted, so there is no role field.
    by: str | None = None


@router.get("/business-processes/{bp}/backups")
async def get_bp_backups_route(
    bp: ValidBp,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """A BP's backup state: which production slot is live (Production) vs standby
    (DR), the retention policy, and the recent audit log (newest-first)."""
    return automation_service.read_backups(bp)


@router.put("/business-processes/{bp}/backups/retention")
async def put_bp_backup_retention_route(
    bp: ValidBp,
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
    bp: ValidBp,
    body: BackupSwapRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """DR go-live swap: flip which production slot is live and repoint the
    production ingress to it (zero downtime, no data moved)."""
    try:
        return await automation_service.swap_production_dr(bp, body.by)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.post("/business-processes/{bp}/backups/promote")
async def post_bp_zero_downtime_promote_route(
    bp: ValidBp,
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
    bp: ValidBp,
    stage: str = Query("dev"),
    automation_service: AutomationService = Depends(get_automation_service),
):
    """SBOM packages + CVEs (syft/grype) for the image(s) deployed to a BP stage,
    plus the out-of-scope waiver log."""
    return automation_service.read_supply_chain(bp, stage)


@router.get("/business-processes/{bp}/supply-chain/preview")
async def get_bp_supply_chain_preview(
    bp: ValidBp,
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
    bp: ValidBp,
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
    bp: ValidBp,
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
    bp: ValidBp,
    stage: str = Query("dev"),
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Egress allow-list rules + blocked/observed attempts for a BP stage."""
    return automation_service.read_firewall(bp, stage)


@router.put("/business-processes/{bp}/firewall/rules")
async def put_bp_firewall_rule(
    bp: ValidBp,
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
    bp: ValidBp,
    body: FirewallDeleteRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Remove a firewall rule (revoke/clear)."""
    return await automation_service.delete_firewall_rule(
        bp, body.stage, body.host, body.by, body.role
    )


@router.post("/business-processes/{bp}/firewall/promote")
async def promote_bp_firewall(
    bp: ValidBp,
    body: FirewallPromoteRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Pull firewall rules forward (dev→staging→production)."""
    return await automation_service.promote_firewall(
        bp, body.from_stage, body.to_stage, body.by, body.role
    )


@router.post("/business-processes/{bp}/firewall/dpa")
async def upload_bp_firewall_dpa(
    bp: ValidBp,
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
    bp: ValidBp,
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
    bp: ValidBp,
    commit: str = Query(...),
    automation_service: AutomationService = Depends(get_automation_service),
):
    """The full source tree of a BP at a commit (Inspect → Files)."""
    return await automation_service.bp_file_tree(bp, commit)


@router.get("/business-processes/{bp}/file-content")
async def get_bp_file_content(
    bp: ValidBp,
    commit: str = Query(...),
    path: str = Query(...),
    automation_service: AutomationService = Depends(get_automation_service),
):
    """A single file's content from a BP's source at a commit (Inspect → Files)."""
    return await automation_service.bp_file_content(bp, commit, path)


@router.get("/business-processes/{bp}/bundle")
async def get_bp_bundle(
    bp: ValidBp,
    stage: str = Query(...),
    commit: str = Query(...),
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Download a deployment bundle (source at the commit + manifest,
    format ``bitswan-bp-bundle/2``) — restorable via POST /processes/from-bundle."""
    path = await automation_service.bundle_deployment(bp, stage, commit)
    filename = f"{bp}-{stage}-{commit[:8]}.tar.gz"
    return FileResponse(
        path,
        media_type="application/gzip",
        filename=filename,
        background=BackgroundTask(lambda: os.path.exists(path) and os.remove(path)),
    )


@router.get("/business-processes/{bp}/secrets-snapshot")
async def get_bp_secrets_snapshot(
    bp: ValidBp,
    commit: str = Query(...),
    stage: str = Query(...),
    by: str | None = None,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """A BP stage's decrypted secrets as they were at a bitswan.yaml revision
    (Inspect → Secrets snapshot). The values come from the encrypted blob in
    bitswan.yaml at `commit` — the same source a rollback restores. Production
    values are redacted unless `by` resolves to admin/auditor."""
    return await automation_service.read_bp_secrets_at(bp, commit, stage, by=by)


@router.post("/business-processes/{bp}/rollback")
async def rollback_bp(
    bp: ValidBp,
    body: RollbackBPRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Roll a BP back to a prior state. Rollback restores the BP's bitswan.yaml at
    `git_commit` — which holds everything (deployment images, secrets, firewall,
    backups) — so one flow covers every kind of change; a secret/deploy history
    entry rolls back the same way. `kind=firewall` keeps the role-gated egress
    rollback (production needs admin/auditor). All come from the same git-derived
    history timeline."""
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
    _require_valid_bp(body.bp)
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


class WakeLiveDevRequest(BaseModel):
    # The copy whose live-dev instance to rehydrate (None/"main" = the main copy).
    copy: str | None = None


@router.post("/business-processes/{bp}/wake-live-dev")
async def wake_live_dev_route(
    bp: ValidBp,
    body: WakeLiveDevRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Rehydrate an evicted live-dev instance — called when a user opens the BP
    in a copy (dashboard) or first hits its URL (the daemon gate). Starts the
    instance's stopped workers (or redeploys if cold-GC'd), stamps last-activity,
    and re-enforces the pool cap. Idempotent: a running instance is a no-op
    (well, a cheap restart). Returns the deployment_ids so the caller can poll
    health / show a loading screen."""
    copy = body.copy
    context = f"copy-{copy}-{bp}" if copy and copy != "main" else bp
    return await automation_service.wake_live_dev(context)


class StageActionRequest(BaseModel):
    stage: str
    copy: str | None = None


def _context_for(bp: str, copy: str | None) -> str:
    return f"copy-{copy}-{bp}" if copy and copy != "main" else bp


@router.post("/business-processes/{bp}/sleep")
async def sleep_bp_stage(
    bp: ValidBp,
    body: StageActionRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Manually put a BP stage to sleep — mark its members inactive + remove their
    containers so it costs nothing. On-demand stages wake on URL access; any stage
    can be woken with the /wake endpoint. Manual memory management + a way to test
    the on-demand path."""
    context = _context_for(bp, body.copy)
    stage = "" if body.stage == "production" else body.stage
    return await automation_service.sleep_context_stage(context, stage)


@router.post("/business-processes/{bp}/wake")
async def wake_bp_stage(
    bp: ValidBp,
    body: StageActionRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Manually wake a slept BP stage — re-activate its members + redeploy."""
    context = _context_for(bp, body.copy)
    stage = "" if body.stage == "production" else body.stage
    return await automation_service.wake_context_stage(context, stage)


class WakeByHostRequest(BaseModel):
    host: str


@router.post("/wake-by-host")
async def wake_by_host_route(
    body: WakeByHostRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Rehydrate the live-dev instance serving `host` — called by the daemon gate
    when a request hits a dehydrated live-dev URL (scale-from-zero). Resolves the
    host to its instance and starts it; the gate meanwhile serves a loading page
    that retries until the container is healthy. No-op for unknown/non-live-dev
    hosts."""
    return await automation_service.wake_by_host(body.host)


@router.get("/on-demand-host")
async def on_demand_host_route(
    host: str,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Non-waking scale-from-zero check for the daemon gate: is `host` an
    on-demand deployment? bitswan.yaml (the single source of truth) is read on
    each call — no shadow state to drift. The gate uses this for
    staging/production hosts (whose names lack the '-dev' suffix that marks
    dev/live-dev as always on-demand) to decide, on a 5xx, whether to show the
    wake-on-access loading page + rehydrate or pass the hard error through."""
    return {"on_demand": automation_service.host_is_on_demand(host)}


class EvictDeploymentsRequest(BaseModel):
    deployment_ids: list[str]
    # Why they're being evicted — "memory-pressure" (the automatic budget sweep,
    # the default) or "manual" (an operator's Sleep from the Resource page). Flows
    # to the sleep-reason state + logs so a sleeping stage is attributable.
    reason: str = "memory-pressure"


@router.get("/mem-groups")
async def mem_groups_route(
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Deployment groups (bp, stage, reserved, policy) from bitswan.yaml. The
    daemon merges these with the running inventory so the admin Resource page can
    show SLEEPING (deployed-but-zero-container) BPs, not just running ones."""
    return automation_service.mem_groups()


@router.post("/evict-ephemeral")
async def evict_ephemeral_route(
    body: EvictDeploymentsRequest,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """Evict specific on-demand deployments (mark inactive + remove containers) —
    called by the daemon's global memory sweep under pressure. Returns the evicted
    ids + their ingress hosts so the daemon can mark them dehydrated for wake."""
    return await automation_service.evict_deployments(
        body.deployment_ids, reason=body.reason
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
    _require_valid_bp(body.bp)
    if body.stage not in ("staging", "production"):
        raise HTTPException(
            status_code=400,
            detail="Stage must be one of: staging, production",
        )

    # Freeze + audit gate — fail synchronously (403/409) before reserving any
    # deployment. Re-enforced authoritatively inside promote_business_process.
    automation_service._assert_promotable(body.bp, body.stage, body.deployed_by)

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

    # This per-deployment route is dev/live-dev ONLY. Promoting to staging or
    # production MUST go through the gated /promote-bp path (freeze + N sign-offs
    # + admin/auditor), so reject anything else here — including a missing stage,
    # which would otherwise map to production. Security fix BSY-01 / issue #180:
    # the deprecated per-automation promote bypassed that gate.
    if stage not in ["dev", "live-dev"]:
        raise HTTPException(
            status_code=400,
            detail=(
                "Stage must be 'dev' or 'live-dev'; promote to staging or "
                "production through the gated /promote-bp route"
            ),
        )

    # Containment guard (#134): checksum / relative_path are written verbatim
    # into bitswan.yaml and later joined onto the gitops / workspace roots by
    # the infra driver to build bind-mount sources. Reject escaping values
    # here so the caller gets a synchronous 400 instead of a failed task.
    automation_service.validate_deploy_source_refs(
        checksum=checksum, relative_path=relative_path
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
    by: str | None = None,
    automation_service: AutomationService = Depends(get_automation_service),
):
    """The deployment's containers with their env. Secret env values are masked
    server-side unless `by` (a shim-verified email, same contract as the
    secrets routes) resolves to a role allowed to see them: production secrets
    need admin/auditor, other stages any known role. Fails closed."""
    return await automation_service.inspect_automation(deployment_id, by=by)


@router.delete("/{deployment_id}")
async def delete_automation(
    deployment_id: str,
    remove_source: bool = Query(False),
    automation_service: AutomationService = Depends(get_automation_service),
):
    return await automation_service.delete_automation(
        deployment_id, remove_source=remove_source
    )
