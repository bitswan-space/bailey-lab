import asyncio
import hmac
import logging
import os
import re

from fastapi import APIRouter, Depends, HTTPException, Query, Security
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from app.dependencies import get_automation_service
from app.utils import DaemonAgentBrowserError, daemon_agent_browser
from app.services.automation_service import (
    AutomationService,
    make_hostname_label,
    scan_workspace_sources,
)
# (git operations now run in each copy via normal git against the embedded
# git server — the agent no longer proxies commit/sync through this service.)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agent", tags=["agent"])

# Strong references to background deploy tasks — prevents GC before completion
_bg_tasks: set[asyncio.Task] = set()


def _spawn_bg(coro) -> asyncio.Task:
    t = asyncio.create_task(coro)
    _bg_tasks.add(t)
    t.add_done_callback(_bg_tasks.discard)
    return t


security = HTTPBearer()

# Pattern for valid per-copy live-dev deployment IDs
# Format: {name}-copy-{copy}-{bp}-live-dev
LIVE_DEV_PATTERN = re.compile(r"^.+-copy-.+-live-dev$")

# Cached agent secret — resolved lazily from the coding agent container
_cached_agent_secret: str | None = None


def _resolve_agent_secret() -> str:
    """Get the agent secret, discovering it from the running coding agent container if needed."""
    global _cached_agent_secret

    # 1. Already cached
    if _cached_agent_secret:
        return _cached_agent_secret

    # 2. Set in our environment (e.g. by ensure_coding_agent)
    from_env = os.environ.get("BITSWAN_GITOPS_AGENT_SECRET", "")
    if from_env:
        _cached_agent_secret = from_env
        return from_env

    # 3. Discover from the running coding agent container
    workspace_name = os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace")
    agent_container_name = f"{workspace_name}-coding-agent"
    try:
        import subprocess

        result = subprocess.run(
            [
                "docker",
                "inspect",
                "--format",
                "{{range .Config.Env}}{{println .}}{{end}}",
                agent_container_name,
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                if line.startswith("BITSWAN_GITOPS_AGENT_SECRET="):
                    secret = line.split("=", 1)[1]
                    if secret:
                        _cached_agent_secret = secret
                        os.environ["BITSWAN_GITOPS_AGENT_SECRET"] = secret
                        logger.info(
                            "Discovered agent secret from coding agent container"
                        )
                        return secret
    except Exception as e:
        logger.debug("Failed to inspect coding agent container: %s", e)

    return ""


def verify_agent_token(
    credentials: HTTPAuthorizationCredentials = Security(security),
):
    agent_secret = _resolve_agent_secret()
    if not agent_secret or not hmac.compare_digest(
        credentials.credentials.encode(), agent_secret.encode()
    ):
        raise HTTPException(status_code=401, detail="Invalid agent token")


def _validate_deployment_id(deployment_id: str):
    """Validate that deployment_id matches the *-copy-*-live-dev pattern."""
    if not LIVE_DEV_PATTERN.match(deployment_id):
        raise HTTPException(
            status_code=403,
            detail=f"Deployment '{deployment_id}' is not a valid live-dev copy deployment",
        )


def _get_workspace_dir() -> str:
    """Return the workspace repository directory (the main git repo)."""
    return os.environ.get("BITSWAN_WORKSPACE_REPO_DIR", "/workspace-repo")


# --- Deployment endpoints ---


def _scan_automations(copy: str | None = None) -> list[dict]:
    """Scan the filesystem for automation sources (automation.toml).

    Thin wrapper over `scan_workspace_sources` that keeps the existing
    `_get_workspace_dir()` resolution behaviour.
    """
    return scan_workspace_sources(_get_workspace_dir(), copy)


@router.get("/deployments")
async def list_agent_deployments(
    copy: str = Query(None),
    _token=Depends(verify_agent_token),
):
    """List deployments for a copy, including those not yet started."""
    if not copy:
        raise HTTPException(status_code=400, detail="copy parameter is required")

    # Scan filesystem for all automation sources in this copy
    sources = _scan_automations(copy)

    # Query running containers to get their state
    workspace_name = os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace-local")
    gitops_domain = os.environ.get("BITSWAN_GITOPS_DOMAIN", "")
    running_states: dict[str, str] = {}

    try:
        containers = await get_automation_service().get_containers()
        for container in containers:
            labels = container.get("Labels", {})
            dep_id = labels.get("gitops.deployment_id", "")
            if f"-copy-{copy}" in dep_id and dep_id.endswith("-live-dev"):
                running_states[dep_id] = container.get("State", "unknown")
    except Exception:
        pass  # If the query fails, we still show sources as "not deployed"

    def _make_url(src):
        if gitops_domain:
            label = make_hostname_label(
                workspace_name, src["automation_name"], src["context"], src["stage"]
            )
            return f"https://{label}.{gitops_domain}"
        return ""

    # Merge: filesystem sources + running state
    result = []
    for src in sources:
        dep_id = src["deployment_id"]
        state = running_states.pop(dep_id, "not deployed")
        result.append(
            {
                "deployment_id": dep_id,
                "state": state,
                "automation_name": src["automation_name"],
                "context": src["context"],
                "stage": src["stage"],
                "relative_path": src["relative_path"],
                "copy": src["copy"],
                "url": _make_url(src),
            }
        )

    # Include any running containers not found on filesystem (orphaned)
    for dep_id, state in running_states.items():
        orphan = {"automation_name": dep_id, "context": "", "stage": "live-dev"}
        result.append(
            {
                "deployment_id": dep_id,
                "state": state,
                "automation_name": dep_id,
                "context": "",
                "stage": "live-dev",
                "relative_path": None,
                "copy": copy,
                "url": _make_url(orphan),
            }
        )

    return result


class StartDeploymentRequest(BaseModel):
    relative_path: str
    copy: str | None = None


@router.post("/deployments/start")
async def start_agent_deployment(
    body: StartDeploymentRequest,
    automation_service: AutomationService = Depends(get_automation_service),
    _token=Depends(verify_agent_token),
):
    """Start a live-dev deployment for an automation."""
    sources = _scan_automations(body.copy)
    source = next(
        (s for s in sources if s["relative_path"] == body.relative_path), None
    )
    if not source:
        ctx = f" in copy '{body.copy}'" if body.copy else ""
        raise HTTPException(
            status_code=404,
            detail=f"No automation source at '{body.relative_path}'{ctx}",
        )

    deployment_id = source["deployment_id"]

    # Guard: reject if already deploying
    from app.deploy_manager import deploy_manager

    if deploy_manager.is_deploying(deployment_id):
        raise HTTPException(
            status_code=409,
            detail=f"Deployment {deployment_id} is already in progress",
        )

    task = await deploy_manager.create_task(deployment_id)
    if task is None:
        raise HTTPException(
            status_code=409,
            detail=f"Deployment {deployment_id} is already in progress",
        )

    # Only send minimal info — the gitops service reads automation.toml
    # directly from the workspace filesystem for live-dev config
    deploy_kwargs = dict(
        deployment_id=deployment_id,
        checksum="live-dev",
        stage="live-dev",
        relative_path=source["relative_path"],
        automation_name=source["automation_name"],
        context=source["context"],
        deployed_by="agent@bitswan.local",
    )

    async def _run_deploy():
        try:
            await deploy_manager.update_task(
                task.task_id, message="Starting live-dev deployment..."
            )
            await automation_service.deploy_automation(**deploy_kwargs)
            await deploy_manager.update_task(
                task.task_id, message="Live-dev deployment completed"
            )
        except Exception as exc:
            logger.exception(
                "Live-dev deploy failed for %s (task %s)",
                deployment_id,
                task.task_id,
            )
            await deploy_manager.update_task(
                task.task_id, error=str(exc), message="Deployment failed"
            )

    _spawn_bg(_run_deploy())

    workspace_name = os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace-local")
    gitops_domain = os.environ.get("BITSWAN_GITOPS_DOMAIN", "")
    url = ""
    if gitops_domain:
        label = make_hostname_label(
            workspace_name,
            source["automation_name"],
            source["context"],
            source["stage"],
        )
        url = f"https://{label}.{gitops_domain}"

    return {
        "task_id": task.task_id,
        "deployment_id": deployment_id,
        "url": url,
        "status": "pending",
    }


@router.get("/deployments/{deployment_id}/inspect")
async def inspect_deployment(
    deployment_id: str,
    _token=Depends(verify_agent_token),
):
    """Full inspect of a deployment container."""
    _validate_deployment_id(deployment_id)

    svc = get_automation_service()
    containers = await svc.get_container(deployment_id)
    if not containers:
        raise HTTPException(
            status_code=404, detail=f"No container found for '{deployment_id}'"
        )
    try:
        info = await svc.infra_driver.container_inspect(
            svc._workspace_ctx(), containers[0].get("Id")
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Docker inspect error: {str(e)}")

    state = info.get("State", {})
    config = info.get("Config", {})
    host_config = info.get("HostConfig", {})
    network_settings = info.get("NetworkSettings", {})

    # Extract useful fields
    networks = {}
    for net_name, net_info in network_settings.get("Networks", {}).items():
        networks[net_name] = {
            "ip": net_info.get("IPAddress", ""),
            "aliases": net_info.get("Aliases", []),
        }

    mounts = []
    for m in info.get("Mounts", []):
        mounts.append(
            {
                "source": m.get("Source", ""),
                "destination": m.get("Destination", ""),
                "mode": m.get("Mode", ""),
                "rw": m.get("RW", True),
            }
        )

    ports = {}
    for port, bindings in (network_settings.get("Ports") or {}).items():
        if bindings:
            ports[port] = [
                {"host_ip": b.get("HostIp", ""), "host_port": b.get("HostPort", "")}
                for b in bindings
            ]
        else:
            ports[port] = None

    return {
        "deployment_id": deployment_id,
        "container_id": info.get("Id", "")[:12],
        "container_name": info.get("Name", "").lstrip("/"),
        "image": config.get("Image", ""),
        "state": {
            "status": state.get("Status", ""),
            "running": state.get("Running", False),
            "started_at": state.get("StartedAt", ""),
            "finished_at": state.get("FinishedAt", ""),
            "exit_code": state.get("ExitCode", 0),
            "restarting": state.get("Restarting", False),
        },
        "networks": networks,
        "ports": ports,
        "mounts": mounts,
        "labels": config.get("Labels", {}),
        "restart_policy": host_config.get("RestartPolicy", {}).get("Name", ""),
    }


@router.get("/deployments/{deployment_id}/env")
async def get_deployment_env(
    deployment_id: str,
    _token=Depends(verify_agent_token),
):
    """Get environment variables for a deployment container (from docker inspect)."""
    _validate_deployment_id(deployment_id)

    svc = get_automation_service()
    containers = await svc.get_container(deployment_id)
    if not containers:
        raise HTTPException(
            status_code=404, detail=f"No container found for '{deployment_id}'"
        )
    try:
        info = await svc.infra_driver.container_inspect(
            svc._workspace_ctx(), containers[0].get("Id")
        )
        env_list = info.get("Config", {}).get("Env", [])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Docker inspect error: {str(e)}")

    # Parse "KEY=VALUE" into dict
    env_vars = {}
    for entry in env_list:
        key, _, value = entry.partition("=")
        env_vars[key] = value

    return {"deployment_id": deployment_id, "env": env_vars}


@router.get("/deployments/{deployment_id}/logs")
async def stream_deployment_logs(
    deployment_id: str,
    lines: int = Query(200, ge=1, le=10000),
    since: int = Query(0, ge=0),
    automation_service: AutomationService = Depends(get_automation_service),
    _token=Depends(verify_agent_token),
):
    _validate_deployment_id(deployment_id)
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


@router.post("/deployments/{deployment_id}/restart")
async def restart_deployment(
    deployment_id: str,
    automation_service: AutomationService = Depends(get_automation_service),
    _token=Depends(verify_agent_token),
):
    _validate_deployment_id(deployment_id)
    return await automation_service.restart_automation(deployment_id)


@router.post("/deployments/{deployment_id}/build-and-restart")
async def build_and_restart_deployment(
    deployment_id: str,
    automation_service: AutomationService = Depends(get_automation_service),
    _token=Depends(verify_agent_token),
):
    """Build image and restart deployment. Streams ndjson progress."""
    _validate_deployment_id(deployment_id)

    from app.deploy_manager import deploy_manager

    if deploy_manager.is_deploying(deployment_id):
        raise HTTPException(
            status_code=409,
            detail=f"Deployment {deployment_id} is already in progress",
        )

    import json as _json
    import shutil as _shutil

    async def _stream():
        from app.services.automation_service import read_bitswan_yaml

        def _ndjson(**kwargs):
            return _json.dumps(kwargs) + "\n"

        yield _ndjson(status="Looking up deployment...")
        bs_yaml = read_bitswan_yaml(automation_service.gitops_dir)
        dep_conf = (bs_yaml or {}).get("deployments", {}).get(deployment_id, {})
        relative_path = dep_conf.get("relative_path", "")

        # Build image if image/ directory exists
        if relative_path:
            source_dir = os.path.join(
                automation_service.workspace_repo_dir, relative_path
            )
            image_dir = os.path.join(source_dir, "image")
            if os.path.isdir(image_dir) and os.path.isfile(
                os.path.join(image_dir, "Dockerfile")
            ):
                from app.utils import calculate_git_tree_hash
                import toml as _toml

                # Compute content hash and build disambiguated tag
                # matching the editor scheme: internal/{ws}-{bp}-{name}:sha{hash}
                checksum = await calculate_git_tree_hash([image_dir])
                auto_name = os.path.basename(source_dir)
                ws_name = automation_service.workspace_name or "workspace"
                # Extract BP name from relative_path
                # e.g. "copies/test2/foobar/backend" → bp = "foobar"
                # e.g. "copies/main/foobar/backend" → bp = "foobar"
                rel_parts = relative_path.replace("\\", "/").split("/")
                if len(rel_parts) >= 2 and rel_parts[0] == "copies":
                    bp_name = rel_parts[2] if len(rel_parts) >= 4 else ""
                else:
                    bp_name = rel_parts[0] if len(rel_parts) >= 2 else ""
                bp_sanitized = (
                    re.sub(r"[^a-z0-9-]", "-", bp_name.lower()).strip("-")
                    if bp_name
                    else ""
                )
                full_image_name = (
                    f"{ws_name}-{bp_sanitized}-{auto_name}"
                    if bp_sanitized
                    else f"{ws_name}-{auto_name}"
                )
                full_tag = f"internal/{full_image_name}:sha{checksum}"

                yield _ndjson(status=f"Building image {full_tag}...")

                # Build on the driver (gitops has no docker.sock). Materialize the
                # image/ context onto the shared gitops volume (the only path the
                # driver can read), then stream the driver's build-log lines as
                # ndjson via a queue (its progress callback runs concurrently).
                from app.services.infra_driver_client import (
                    BuildRequest,
                    InfraDriverError,
                )

                gitops_root = os.environ.get("BITSWAN_GITOPS_DIR", "/gitops")
                build_ctx_dir = os.path.join(
                    gitops_root, "gitops", ".builds", "agent-" + checksum
                )

                def _materialize():
                    _shutil.rmtree(build_ctx_dir, ignore_errors=True)
                    _shutil.copytree(image_dir, build_ctx_dir, symlinks=True)

                await asyncio.to_thread(_materialize)

                q: asyncio.Queue = asyncio.Queue()

                async def _prog(line: str):
                    await q.put(re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", line))

                async def _run_build():
                    try:
                        await automation_service.infra_driver.build_image(
                            BuildRequest(
                                ctx=automation_service._workspace_ctx(),
                                tag=full_tag,
                                source_path=build_ctx_dir,
                                dockerfile="Dockerfile",
                                source_sha=checksum,
                            ),
                            progress_callback=_prog,
                        )
                        await q.put(None)
                    except InfraDriverError as e:
                        await q.put({"error": str(e)})
                        await q.put(None)

                build_task = asyncio.create_task(_run_build())
                build_error = None
                while True:
                    item = await q.get()
                    if item is None:
                        break
                    if isinstance(item, dict) and "error" in item:
                        build_error = item["error"]
                        yield _json.dumps(item) + "\n"
                    else:
                        yield _json.dumps({"stream": item}) + "\n"
                await build_task

                if build_error:
                    return

                # Update automation.toml with the new image tag
                automation_toml_path = os.path.join(source_dir, "automation.toml")
                if os.path.isfile(automation_toml_path):
                    with open(automation_toml_path, "r") as f:
                        config = _toml.load(f)
                    config.setdefault("deployment", {})["image"] = full_tag
                    with open(automation_toml_path, "w") as f:
                        _toml.dump(config, f)
                    yield _ndjson(status=f"Updated automation.toml: image = {full_tag}")

                yield _ndjson(status=f"Image built: {full_tag}")

        yield _ndjson(status="Deploying...")
        try:
            await automation_service.deploy_automation(
                deployment_id=deployment_id, stage="live-dev"
            )
            yield _ndjson(status="Deploy completed successfully")
        except Exception as exc:
            yield _ndjson(error=str(exc))

    return StreamingResponse(_stream(), media_type="application/x-ndjson")


# --- Docker exec endpoint ---


class ExecRequest(BaseModel):
    command: list[str]


@router.post("/deployments/{deployment_id}/exec")
async def exec_in_deployment(
    deployment_id: str,
    body: ExecRequest,
    _token=Depends(verify_agent_token),
):
    _validate_deployment_id(deployment_id)

    svc = get_automation_service()
    containers = await svc.get_container(deployment_id)
    if not containers:
        raise HTTPException(
            status_code=404,
            detail=f"No running container found for deployment '{deployment_id}'",
        )

    from app.services.infra_driver_client import ExecSpec, InfraDriverError

    out_chunks: list[bytes] = []
    err_chunks: list[bytes] = []

    async def on_stdout(d: bytes):
        out_chunks.append(d)

    async def on_stderr(d: bytes):
        err_chunks.append(d)

    try:
        exit_code = await svc.infra_driver.exec(
            svc._workspace_ctx(),
            ExecSpec(container=containers[0].get("Id"), cmd=body.command),
            on_stdout=on_stdout,
            on_stderr=on_stderr,
        )
    except InfraDriverError as e:
        raise HTTPException(status_code=500, detail=f"Docker exec error: {str(e)}")

    output = (b"".join(out_chunks) + b"".join(err_chunks)).decode("utf-8", "replace")
    return {
        "exit_code": exit_code,
        "output": output,
    }


# --- browser (#210) --------------------------------------------------------
#
# The coding agent drives a real browser at a live-dev frontend, signed in as a
# test user it invented. gitops is the relay: the agent's container reaches
# nothing but this API, and the daemon holds everything with authority — the
# identities, the session cookie, the live-dev rule and the signing key.
#
# What gitops contributes is the part only it knows: which deployment the agent
# means, what hostname that deployment is published at, and whether it is asleep
# and needs waking before a browser arrives.


class AgentIdentityRequest(BaseModel):
    label: str
    email: str | None = None
    groups: list[str] = []


class AgentBrowserSessionRequest(BaseModel):
    label: str
    deployment_id: str


def _workspace_name() -> str:
    return os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace-local")


def _daemon_error(e: DaemonAgentBrowserError) -> HTTPException:
    """Pass the daemon's own refusal through with its status. A 403 from the
    live-dev rule has to reach the agent as a 403 with the reason it gave, not
    as a generic gateway error — the agent acts on the reason."""
    if 400 <= e.status < 500:
        return HTTPException(status_code=e.status, detail=e.detail)
    return HTTPException(status_code=502, detail=f"the daemon refused: {e.detail}")


@router.get("/browser/identities")
async def list_agent_identities(_token=Depends(verify_agent_token)):
    """The test users this workspace has, with the groups each carries."""
    try:
        return daemon_agent_browser(
            "GET", "identities", params={"workspace": _workspace_name()}
        )
    except DaemonAgentBrowserError as e:
        raise _daemon_error(e)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"daemon unreachable: {e}")


@router.post("/browser/identities")
async def create_agent_identity(
    body: AgentIdentityRequest, _token=Depends(verify_agent_token)
):
    """Create (or redefine) one test user. Groups are whatever the agent asks
    for: they exist only in the server's own agent issuer, so naming one grants
    nothing anywhere else."""
    try:
        return daemon_agent_browser(
            "POST",
            "identities",
            json_body={
                "label": body.label,
                "email": body.email or "",
                "groups": body.groups,
                "workspace": _workspace_name(),
            },
        )
    except DaemonAgentBrowserError as e:
        raise _daemon_error(e)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"daemon unreachable: {e}")


@router.delete("/browser/identities/{label}")
async def delete_agent_identity(label: str, _token=Depends(verify_agent_token)):
    try:
        return daemon_agent_browser(
            "DELETE",
            "identities",
            params={"label": label, "workspace": _workspace_name()},
        )
    except DaemonAgentBrowserError as e:
        raise _daemon_error(e)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"daemon unreachable: {e}")


def _live_dev_source(deployment_id: str, copy: str | None = None) -> dict:
    """The scanned source behind a live-dev deployment id, or a 404/400.

    Refusing anything but live-dev here, before the daemon is asked, is the
    same two-layer guard the deploy routes use: a synchronous, specific refusal
    at the edge, and the authoritative one at the far end.
    """
    if not LIVE_DEV_PATTERN.match(deployment_id):
        raise HTTPException(
            status_code=400,
            detail=(
                "the browser only opens live-dev deployments — "
                f"'{deployment_id}' is not one"
            ),
        )
    for src in _scan_automations(copy):
        if src["deployment_id"] == deployment_id:
            return src
    raise HTTPException(
        status_code=404, detail=f"no live-dev deployment '{deployment_id}' in this copy"
    )


@router.post("/browser/session")
async def create_agent_browser_session(
    body: AgentBrowserSessionRequest,
    copy: str = Query(None),
    automation_service: AutomationService = Depends(get_automation_service),
    _token=Depends(verify_agent_token),
):
    """Hand the agent a browser session for one live-dev deployment: the URL a
    person would visit, and the cookie that signs the browser in as the named
    test user.

    The deployment is woken first. A live-dev instance sleeps when the pool is
    under pressure, and a browser arriving at a sleeping one gets the platform's
    loading page instead of the app — which the agent would report as a bug in
    the app.
    """
    src = _live_dev_source(body.deployment_id, copy)
    host = (
        make_hostname_label(
            _workspace_name(),
            src["automation_name"],
            src["context"],
            src["stage"],
        )
        + "."
        + os.environ.get("BITSWAN_GITOPS_DOMAIN", "")
    )
    if host.endswith("."):
        raise HTTPException(
            status_code=409,
            detail="this workspace has no domain yet, so it publishes no URLs",
        )
    try:
        await automation_service.wake_live_dev(src["context"], src["stage"])
    except Exception as e:  # noqa: BLE001 — a wake failure is worth saying, not fatal
        logger.warning("agent browser: waking %s failed: %s", src["context"], e)
    required_group = await _required_group(body.deployment_id)
    try:
        out = daemon_agent_browser(
            "POST",
            "session",
            json_body={
                "label": body.label,
                "endpoint_host": host,
                "workspace": _workspace_name(),
            },
        )
    except DaemonAgentBrowserError as e:
        raise _daemon_error(e)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"daemon unreachable: {e}")
    out["deployment_id"] = body.deployment_id
    if required_group:
        out["required_group"] = required_group
    return out


async def _required_group(deployment_id: str) -> str:
    """The group this deployment's code checks for, read from the running
    container's environment.

    Worth the lookup: an app that verifies a token then checks a group answers
    403 to a test user who carries the wrong one, which reads like a bug in the
    app rather than a detail of how the identity was made up. Best-effort — a
    deployment that is not running yet simply yields nothing.
    """
    try:
        svc = get_automation_service()
        containers = await svc.get_container(deployment_id)
        if not containers:
            return ""
        info = await svc.infra_driver.container_inspect(
            svc._workspace_ctx(), containers[0].get("Id")
        )
        for entry in info.get("Config", {}).get("Env", []) or []:
            key, _, value = entry.partition("=")
            if key == "BITSWAN_ALLOWED_GROUP":
                return value
    except Exception as e:  # noqa: BLE001 - a hint is never worth failing over
        logger.debug("could not read the required group for %s: %s", deployment_id, e)
    return ""
