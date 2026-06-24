import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import logging
import os
import re
import threading
from typing import Any, Optional
import shlex
import subprocess
import shutil
import tarfile
import tempfile
import httpx

logger = logging.getLogger(__name__)

import humanize
import toml
import yaml
from fastapi import HTTPException

# Parse bitswan.yaml with libyaml's C loader when available — it is ~6x faster
# than the pure-Python SafeLoader and produces identical output. Falls back to
# the pure-Python loader if libyaml isn't installed.
_SAFE_LOADER = getattr(yaml, "CSafeLoader", yaml.SafeLoader)


def load_yaml(text: str):
    """Safe-load YAML text using the fast C loader when available."""
    return yaml.load(text, Loader=_SAFE_LOADER)


# Thread-safe git lock that works across both async and sync contexts
# Uses a threading.Lock as the underlying mechanism for cross-thread safety
_git_thread_lock = threading.Lock()


class GitLockContext:
    """
    Context manager for git lock that works in both async and sync contexts.
    Uses a threading.Lock internally for cross-thread safety (needed for background threads).
    """

    def __init__(self, timeout: float = 10.0):
        self.timeout = timeout
        self._acquired = False

    async def __aenter__(self):
        """Async context manager entry - acquires lock without blocking event loop."""
        loop = asyncio.get_event_loop()
        # Run the blocking lock acquisition in a thread pool to avoid blocking the event loop
        acquired = await loop.run_in_executor(
            None, lambda: _git_thread_lock.acquire(timeout=self.timeout)
        )
        if not acquired:
            raise Exception(f"Failed to acquire git lock within {self.timeout} seconds")
        self._acquired = True
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit - releases lock."""
        if self._acquired:
            _git_thread_lock.release()
            self._acquired = False
        return False

    def __enter__(self):
        """Sync context manager entry - for use in background threads."""
        acquired = _git_thread_lock.acquire(timeout=self.timeout)
        if not acquired:
            raise Exception(f"Failed to acquire git lock within {self.timeout} seconds")
        self._acquired = True
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Sync context manager exit - for use in background threads."""
        if self._acquired:
            _git_thread_lock.release()
            self._acquired = False
        return False


@dataclass
class ServiceDependency:
    """A declared infrastructure service dependency from automation.toml."""

    enabled: bool = True


KNOWN_STAGES = {"live-dev", "dev", "staging", "production"}

# Network realms: each gets its own set of infrastructure services (Kafka, CouchDB).
# live-dev shares the dev realm.
SERVICE_REALMS = {"dev", "staging", "production"}


@dataclass
class AutomationConfig:
    """Automation configuration from automation.toml."""

    id: str | None = (
        None  # Unique automation ID (used as Keycloak client_id when auth=True)
    )
    auth: bool = False  # Enable Keycloak authentication
    image: str = "bitswan/pipeline-runtime-environment:latest"
    expose: bool = False
    port: int = 8080
    # Where the source tree is mounted/baked inside the container.
    mount_path: str = "/app/"
    # CORS allowed domains for Keycloak client (optional)
    allowed_domains: list[str] | None = None
    # Infrastructure service dependencies
    services: dict[str, ServiceDependency] | None = None
    # Use host network for external access (Selenium testing)
    external_testing_network: bool = False


def parse_automation_toml(content: str) -> AutomationConfig | None:
    """Parse automation.toml content from a string and return AutomationConfig."""
    if not content or not content.strip():
        return None
    try:
        data = toml.loads(content)
    except toml.TomlDecodeError as e:
        raise ValueError(f"Syntax error in automation.toml: {e}") from e

    deployment = data.get("deployment", {})

    # Parse allowed_domains as a list (for CORS in Keycloak client)
    allowed_domains = deployment.get("allowed_domains")
    if isinstance(allowed_domains, list):
        allowed_domains = [str(d).strip() for d in allowed_domains if str(d).strip()]
    else:
        allowed_domains = None

    # Parse [services.*] sections
    services_data = data.get("services", {})
    services = None
    if services_data and isinstance(services_data, dict):
        services = {}
        for svc_type, svc_conf in services_data.items():
            if not isinstance(svc_conf, dict):
                continue
            services[svc_type] = ServiceDependency(
                enabled=svc_conf.get("enabled", True),
            )

    return AutomationConfig(
        id=deployment.get("id"),
        auth=deployment.get("auth", False),
        image=deployment.get("image", "bitswan/pipeline-runtime-environment:latest"),
        expose=deployment.get("expose", False),
        port=deployment.get("port", 8080),
        mount_path="/app/",
        allowed_domains=allowed_domains,
        services=services,
        external_testing_network=deployment.get("external-testing-network", False),
    )


def sanitize_automation_name(name: str) -> str:
    """Lowercase + replace each char outside [a-z0-9-] with '-', trim hyphens.

    Single shared implementation: deployment-id derivation (automation_service)
    and template scaffolding (template_service) must agree on the same output
    for a given input, otherwise scaffolded folders won't round-trip back to
    the same deployment id.
    """
    return re.sub(r"[^a-z0-9-]", "-", name.lower()).strip("-")


def read_automation_toml(source_dir: str) -> AutomationConfig | None:
    """Read automation.toml from a directory."""
    toml_path = os.path.join(source_dir, "automation.toml")
    if os.path.exists(toml_path):
        with open(toml_path, "r") as f:
            content = f.read()
        return parse_automation_toml(content)
    return None


def read_automation_config(source_dir: str) -> AutomationConfig:
    """Read an automation's configuration from automation.toml, or defaults
    when none is present."""
    return read_automation_toml(source_dir) or AutomationConfig()


async def wait_coroutine(*args, **kwargs) -> int:
    coro = await asyncio.create_subprocess_exec(*args, **kwargs)
    result = await coro.wait()
    return result


def _build_git_command(*command, cwd=None):
    """
    Build the command to execute, handling HOST_PATH case with nsenter if needed.
    Returns (exec_command, proc_kwargs) where exec_command is the command list
    and proc_kwargs are kwargs for subprocess execution.
    """
    host_path = os.environ.get("HOST_PATH")
    host_home = os.environ.get("HOST_HOME")
    host_user = os.environ.get("HOST_USER")

    # If all host environment variables are set, use nsenter to run git command on host
    if cwd and host_path and host_home and host_user:
        formatted_command = " ".join(shlex.quote(arg) for arg in command)
        host_command = (
            f"PATH={host_path} su - {host_user} -c "
            f'"cd {cwd} && PATH={host_path} HOME={host_home} {formatted_command}"'
        )
        exec_command = [
            "nsenter",
            "-t",
            "1",
            "-m",
            "-u",
            "-n",
            "-i",
            "sh",
            "-c",
            host_command,
        ]
        return exec_command, {}
    else:
        # Fallback to local git command
        return list(command), {"cwd": cwd}


async def call_git_command(*command, **kwargs) -> bool:
    cwd = kwargs.get("cwd")
    exec_command, proc_kwargs = _build_git_command(*command, cwd=cwd)
    result = await wait_coroutine(*exec_command, **proc_kwargs)
    return result == 0


async def call_git_command_with_output(*command, **kwargs) -> tuple[str, str, int]:
    """
    Execute a git command and return (stdout, stderr, return_code).
    Handles HOST_PATH case using nsenter if needed.
    """
    cwd = kwargs.get("cwd")
    exec_command, proc_kwargs = _build_git_command(*command, cwd=cwd)

    # Execute the command and capture output
    proc = await asyncio.create_subprocess_exec(
        *exec_command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        **proc_kwargs,
    )
    stdout, stderr = await proc.communicate()
    return stdout.decode(), stderr.decode(), proc.returncode


# ── bitswan.yaml deployment storage ────────────────────────────────────────
# On disk, deployments are grouped in a tree: business_processes[<bp>][<stage>]
# = { git_commit, deployed_at, deployed_by, history[], deployments{<id>: conf} }.
# In memory we ALSO expose the legacy FLAT `deployments` map (hydrated on read)
# so the many readers stay unchanged; `dump_bitswan_yaml` re-groups flat → tree
# on write and persists only the tree. (production stage key is "production";
# the flat conf keeps the canonical "" stage.)


def _tree_to_flat(bs_yaml: dict) -> dict:
    """Hydrate a flat {deployment_id: conf} map from the business_processes tree."""
    flat: dict = {}
    for bp, stages in (bs_yaml.get("business_processes") or {}).items():
        for stage, node in (stages or {}).items():
            for dep_id, conf in ((node or {}).get("deployments") or {}).items():
                c = dict(conf or {})
                c.setdefault("context", bp)
                c.setdefault("stage", "" if stage == "production" else stage)
                flat[dep_id] = c
    return flat


def _flat_to_tree(bs_yaml: dict) -> dict:
    """Group the flat `deployments` map into business_processes[bp][stage],
    preserving per-stage metadata (git_commit/deployed_*/history) already in the
    in-memory tree."""
    existing = bs_yaml.get("business_processes") or {}
    tree: dict = {}
    for dep_id, conf in (bs_yaml.get("deployments") or {}).items():
        conf = conf or {}
        bp = conf.get("context") or "ungrouped"
        stage = conf.get("stage") or "production"
        if stage == "":
            stage = "production"
        node = tree.setdefault(bp, {}).setdefault(stage, {})
        ex = (existing.get(bp, {}) or {}).get(stage, {}) or {}
        # The node's git_commit is the deployed source version — the key
        # bp_history uses to surface a deploy (see bp_history). Prefer the
        # source_commit recorded on the deployment itself: EVERY deploy path
        # stamps it (write_deployment_entries), whereas the node-level git_commit
        # is only set by write_bp_deploy. Without this, deploys made via the
        # set-deploy path (Sync & Deploy's auto-deploy) carried a
        # source_commit on the deployment but left the node's git_commit empty,
        # so they never appeared in the Deployments history ("not deployed yet").
        # Fall back to an existing tree value when a deployment has no
        # source_commit (e.g. live-dev).
        if conf.get("source_commit"):
            node["git_commit"] = conf["source_commit"]
        elif "git_commit" in ex and "git_commit" not in node:
            node["git_commit"] = ex["git_commit"]
        node.setdefault("deployments", {})[dep_id] = conf
    return tree


def dump_bitswan_yaml(bs_yaml: dict, f) -> None:
    """Persist bitswan.yaml with deployments grouped into the business_processes
    tree (the flat in-memory `deployments` map is dropped from disk)."""
    out = dict(bs_yaml)
    out["business_processes"] = _flat_to_tree(bs_yaml)
    out.pop("deployments", None)
    yaml.dump(out, f)


def read_bitswan_yaml(bitswan_dir: str) -> dict[str, Any] | None:
    bitswan_yaml_path = os.path.join(bitswan_dir, "bitswan.yaml")
    try:
        if os.path.exists(bitswan_yaml_path):
            with open(bitswan_yaml_path, "r") as f:
                bs_yaml: dict = yaml.load(f, Loader=_SAFE_LOADER)
            # Hydrate the flat `deployments` view from the tree so all readers
            # work unchanged. (Legacy flat-only files are returned as-is.)
            if isinstance(bs_yaml, dict) and bs_yaml.get("business_processes"):
                bs_yaml["deployments"] = _tree_to_flat(bs_yaml)
            return bs_yaml
    except Exception:
        return None


def calculate_uptime(created_at: str) -> str:
    created_at = datetime.fromisoformat(created_at)
    uptime = datetime.now(timezone.utc) - created_at
    return humanize.naturaldelta(uptime)


def generate_workspace_url(
    workspace_name: str,
    automation_name: str,
    context: str,
    stage: str,
    gitops_domain: str,
    full: bool = False,
    slot: str | None = None,
) -> str:
    from app.services.automation_service import make_hostname_label

    label = make_hostname_label(workspace_name, automation_name, context, stage, slot)
    url = f"{label}.{gitops_domain}"
    return f"https://{url}" if full else url


def workspace_route(
    automation_name: str,
    context: str,
    stage: str,
    port: str,
    slot: str | None = None,
    upstream_slot: str | None = None,
    host_stage: str | None = None,
) -> dict:
    """PURE: the daemon ingress route an exposed automation should have — no
    I/O. This is the single derivation of (hostname, upstream) for an exposed
    automation; `desired_ingress_routes` collects these into the declarative set
    the reconcile converges to, and `add_workspace_route_to_ingress` POSTs one.

    The HOSTNAME and the CONTAINER it resolves to are decoupled so a stable
    user-facing host can point at a blue-green slot's container:
      • host_stage overrides the hostname's stage — the DR host is `…-dr` while
        its container lives in the `production` realm.
      • slot adds a `-<slot>` suffix to the hostname (per-slot hosts only; the
        stable production/DR hosts pass slot=None).
      • upstream_slot picks the container's slot (defaults to slot) — the
        production host → the live slot, the DR host → the standby slot.
    """
    from app.services.automation_service import make_hostname_label

    gitops_domain = os.environ.get("BITSWAN_GITOPS_DOMAIN", "gitops.bitswan.space")
    workspace_name = os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace-local")
    container_slot = upstream_slot if upstream_slot is not None else slot
    hostname = generate_workspace_url(
        workspace_name,
        automation_name,
        context,
        host_stage or stage,
        gitops_domain,
        False,
        slot,
    )
    svc_name = make_hostname_label(
        workspace_name, automation_name, context, stage, container_slot
    )
    return {
        "hostname": hostname,
        "upstream": f"{svc_name}:{port}",
        "workspace_name": workspace_name,
        # Frontends inherit the workspace's Bailey ACL from the dashboard
        # endpoint, so every workspace member can share what they deploy.
        "parent_endpoint": f"{workspace_name}-dashboard.{gitops_domain}",
        "kind": "frontend",
        "stage": stage,
    }


def add_workspace_route_to_ingress(
    automation_name: str,
    context: str,
    stage: str,
    port: str,
    slot: str | None = None,
    upstream_slot: str | None = None,
    host_stage: str | None = None,
) -> bool:
    from app.services.automation_service import make_hostname_label

    gitops_domain = os.environ.get("BITSWAN_GITOPS_DOMAIN", "gitops.bitswan.space")
    workspace_name = os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace-local")
    # The HOSTNAME and the CONTAINER it resolves to are decoupled, so a stable
    # user-facing host can point at a blue-green slot's container:
    #   • host_stage overrides the hostname's stage — the DR host is `…-dr` while
    #     its container lives in the `production` realm.
    #   • slot adds a `-<slot>` suffix to the hostname (used only for per-slot
    #     hosts; the stable production/DR hosts pass slot=None).
    #   • upstream_slot picks the container's slot (defaults to slot) — the
    #     production host → the live slot, the DR host → the standby slot.
    container_slot = upstream_slot if upstream_slot is not None else slot
    hostname = generate_workspace_url(
        workspace_name,
        automation_name,
        context,
        host_stage or stage,
        gitops_domain,
        False,
        slot,
    )
    svc_name = make_hostname_label(
        workspace_name, automation_name, context, stage, container_slot
    )
    upstream = f"{svc_name}:{port}"
    # Frontends inherit the workspace's Bailey ACL from the dashboard
    # endpoint, so every workspace member can share what they deploy (see
    # the daemon's parent-delegation in acl.go). State the parent explicitly
    # rather than relying on the daemon's metadata fallback.
    parent_endpoint = f"{workspace_name}-dashboard.{gitops_domain}"
    # Only exposed automations (frontends) reach this path, so mark the
    # endpoint as a frontend for the Bailey launcher.
    return add_route_to_ingress(
        hostname,
        upstream,
        workspace_name,
        parent_endpoint=parent_endpoint,
        kind="frontend",
        stage=stage,
    )


def _ingress_client_and_base() -> tuple:
    """Return (httpx.Client, base_url) for the ingress daemon.

    Prefers the Unix socket (BITSWAN_INGRESS_SOCKET) — access is controlled
    by the docker-compose bind-mount, no token needed.
    Falls back to BITSWAN_INGRESS_URL for environments without the socket.
    """
    socket_path = os.environ.get(
        "BITSWAN_INGRESS_SOCKET", "/var/run/bitswan/automation-server.sock"
    )
    if os.path.exists(socket_path):
        # Hostname in the URL is ignored by UDS transport; use a placeholder.
        return httpx.Client(
            transport=httpx.HTTPTransport(uds=socket_path), timeout=10
        ), "http://daemon"
    base_url = os.environ.get(
        "BITSWAN_INGRESS_URL", "http://bitswan-automation-server-daemon:8080"
    )
    return httpx.Client(timeout=10), base_url


def daemon_user_role(email: str) -> str:
    """The authoritative Bailey role (admin|auditor|member|user) for an email,
    read from the automation-server daemon over the trusted local socket.

    The daemon's user_roles store is the single source of truth — the same
    `effectiveRole` the People & roles admin view shows — and is deliberately
    NOT derived from SSO groups. Callers pass an identity that an upstream shim
    has already verified (the dashboard validates the user's access token →
    email before asking). Raises on transport failure so callers fail CLOSED
    (treat as unprivileged) rather than guess a role.
    """
    email = (email or "").strip()
    if not email:
        return ""
    client, base = _ingress_client_and_base()
    try:
        resp = client.get(f"{base}/bailey/role", params={"email": email})
        resp.raise_for_status()
        return (resp.json() or {}).get("role") or ""
    finally:
        client.close()


def add_route_to_ingress(
    hostname: str,
    upstream: str,
    workspace_name: str = "",
    parent_endpoint: str = "",
    kind: str = "",
    stage: str = "",
) -> bool:
    body = {
        "hostname": hostname,
        "upstream": upstream,
        "workspace_name": workspace_name,
    }
    if parent_endpoint:
        body["parent_endpoint"] = parent_endpoint
    # kind classifies the endpoint for the Bailey launcher ("frontend" for
    # exposed automations, "service" otherwise). Explicit data — the daemon
    # never infers it from the hostname.
    if kind:
        body["kind"] = kind
    # stage is the automation's deployment stage; launcher/admin views filter
    # on it (e.g. only production frontends).
    if stage:
        body["stage"] = stage
    try:
        client, base = _ingress_client_and_base()
        with client:
            response = client.post(f"{base}/ingress/add-route", json=body)
        if response.status_code != 200:
            logger.warning(
                f"Ingress add-route failed for {hostname}: HTTP {response.status_code} — {response.text}"
            )
            return False
        return True
    except Exception as e:
        logger.warning(f"Ingress add-route request failed for {hostname}: {e}")
        return False


def repoint_route_in_ingress(
    hostname: str, upstream: str, workspace_name: str = ""
) -> bool:
    """Atomically repoint an EXISTING route's upstream (the blue-green swap /
    zero-downtime-promote primitive). Unlike add-route this does not touch TLS
    certs, the Bailey ACL, or OAuth redirect URIs — the route already exists;
    only the container it resolves to changes."""
    body = {
        "hostname": hostname,
        "upstream": upstream,
        "workspace_name": workspace_name,
    }
    try:
        client, base = _ingress_client_and_base()
        with client:
            response = client.post(f"{base}/ingress/repoint-route", json=body)
        if response.status_code != 200:
            logger.warning(
                f"Ingress repoint-route failed for {hostname}: "
                f"HTTP {response.status_code} — {response.text}"
            )
            return False
        return True
    except Exception as e:
        logger.warning(f"Ingress repoint-route request failed for {hostname}: {e}")
        return False


def remove_route_from_ingress(
    automation_name: str, context: str, stage: str, workspace_name: str
) -> bool:
    gitops_domain = os.environ.get("BITSWAN_GITOPS_DOMAIN", "gitops.bitswan.space")
    hostname = generate_workspace_url(
        workspace_name, automation_name, context, stage, gitops_domain, False
    )
    try:
        client, base = _ingress_client_and_base()
        with client:
            response = client.delete(f"{base}/ingress/remove-route/{hostname}")
        return response.status_code == 200
    except Exception:
        return False


def calculate_checksum(file_path):
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for byte_block in iter(lambda: f.read(4096), b""):
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest()


# Symlink targets we accept inside deploy-archive tarballs. Anything outside
# this allowlist (or any relative path that data_filter rejects) is dropped.
# Currently only React templates use absolute-target symlinks (committed
# `package.json` and `node_modules` pointing at /deps/...).
_ALLOWED_LINK_PREFIXES: tuple[str, ...] = ("/deps/",)


def bitswan_extract_filter(
    member: tarfile.TarInfo, dest_path: str
) -> tarfile.TarInfo | None:
    """Tar extraction filter for deploy archives.

    Always runs ``tarfile.data_filter`` first so the member's *name* (and
    every other piece of metadata) goes through PEP 706's traversal /
    absolute-path / mode / hardlink checks. The only policy we widen is
    on symlinks: ``data_filter`` rejects every absolute symlink target,
    but we permit those whose target is under ``_ALLOWED_LINK_PREFIXES``.
    """
    try:
        return tarfile.data_filter(member, dest_path)
    except tarfile.AbsoluteLinkError:
        # data_filter raises AbsoluteLinkError only after the member name
        # has already been validated (no traversal, not absolute, stays
        # inside dest). We override its decision strictly for symlinks
        # whose target is in the allowlist; hardlinks are never widened.
        if not member.issym():
            return None
        target = member.linkname or ""
        normalized = os.path.normpath(target)
        # Reject '..' segments even inside an allowlisted prefix — they
        # let the link reach back out of the allowed subtree.
        if any(part == ".." for part in normalized.split(os.sep)):
            return None
        if not any(
            normalized == p.rstrip("/") or normalized.startswith(p)
            for p in _ALLOWED_LINK_PREFIXES
        ):
            return None
        # Strip ownership and special permissions; keep mode predictable.
        member.uid = member.gid = 0
        member.uname = member.gname = ""
        member.mode = 0o755
        return member


def _calculate_git_blob_hash_from_content(content: bytes) -> str:
    """
    Calculate git blob hash from in-memory bytes. Used for symlinks, whose
    "blob content" is the link target string.
    """
    header = f"blob {len(content)}\0".encode("utf-8")
    return hashlib.sha1(header + content).hexdigest()


def _calculate_git_blob_hash(file_path: str) -> str:
    """
    Calculate git blob hash for a file (SHA1 of "blob <size>\\0<content>").
    """
    with open(file_path, "rb") as f:
        content = f.read()
    return _calculate_git_blob_hash_from_content(content)


def _calculate_git_tree_hash_recursive(
    dir_paths: list[str], relative_path: str = "", logger=None
) -> str:
    """
    Calculate git tree hash for a directory recursively.
    Implements git's tree object format directly without spawning git processes.
    Tree format: "tree <size>\\0<entries>" where each entry is "<mode> <name>\\0<20-byte-sha1>"

    Accepts multiple `dir_paths` and overlays them in order — later paths win
    on filename collisions. With a single path, this matches a plain
    single-dir walk. Empty input (or all-missing dirs) yields git's empty-tree
    SHA naturally from the tree-object encoding.
    """
    # name -> (source_path, is_directory, is_symlink); later dirs overwrite earlier
    entry_map: dict[str, tuple[str, bool, bool]] = {}

    for dir_path in dir_paths:
        full_dir = os.path.join(dir_path, relative_path) if relative_path else dir_path
        if not os.path.isdir(full_dir):
            continue
        for item in os.listdir(full_dir):
            if item == ".git":
                continue
            item_path = os.path.join(full_dir, item)
            # lstat-style check: symlinks must be detected before any os.path.is*
            # call that follows them. Symlinks are hashed git-style (mode 120000)
            # so the deploy archive's checksum reflects them faithfully — the
            # client-side calculation does the same.
            is_symlink = os.path.islink(item_path)
            if not is_symlink and not os.access(item_path, os.R_OK):
                if logger:
                    entry_relative_path = (
                        f"{relative_path}/{item}" if relative_path else item
                    )
                    logger.info(f"Skipping unreadable: {entry_relative_path}")
                continue
            if is_symlink:
                entry_map[item] = (item_path, False, True)
                continue
            is_dir = os.path.isdir(item_path)
            # Skip anything that's not a regular file or directory
            if not is_dir and not os.path.isfile(item_path):
                continue
            entry_map[item] = (item_path, is_dir, False)

    def _git_sort_key(name: str, is_dir: bool) -> bytes:
        key = f"{name}/" if is_dir else name
        return key.encode("utf-8")

    # Git-style ordering: symlinks sort like regular files (no trailing slash).
    items = sorted(entry_map.items(), key=lambda kv: _git_sort_key(kv[0], kv[1][1]))

    entries = []
    for name, (item_path, is_dir, is_symlink) in items:
        entry_relative_path = f"{relative_path}/{name}" if relative_path else name

        if is_symlink:
            target = os.readlink(item_path)
            blob_hash = _calculate_git_blob_hash_from_content(target.encode("utf-8"))
            entries.append({"mode": "120000", "name": name, "hash": blob_hash})
            if logger:
                logger.info(
                    f"CHECKSUM LINK: {entry_relative_path} -> 120000 {blob_hash} (target: {target})"
                )
        elif is_dir:
            tree_hash = _calculate_git_tree_hash_recursive(
                dir_paths, entry_relative_path, logger
            )
            entries.append({"mode": "040000", "name": name, "hash": tree_hash})
            if logger:
                logger.info(f"CHECKSUM DIR:  {entry_relative_path}/ -> {tree_hash}")
        else:
            blob_hash = _calculate_git_blob_hash(item_path)
            # Match git's executable detection: any of u/g/o +x flips the
            # mode to 100755. Keeps the checksum stable so the
            # deploy cache reacts to chmod +x/-x on files whose bits
            # round-trip through the tarball intact.
            file_mode = os.stat(item_path).st_mode
            mode = "100755" if file_mode & 0o111 else "100644"
            entries.append({"mode": mode, "name": name, "hash": blob_hash})
            if logger:
                logger.info(
                    f"CHECKSUM FILE: {entry_relative_path} -> {mode} {blob_hash}"
                )

    # Build tree object: "tree <size>\\0<entries>"
    entry_bytes = bytearray()
    for entry in entries:
        # Each entry: "<mode> <name>\\0<20-byte-sha1>"
        hash_bytes = bytes.fromhex(entry["hash"])
        entry_str = f"{entry['mode']} {entry['name']}\0"
        entry_bytes.extend(entry_str.encode("utf-8"))
        entry_bytes.extend(hash_bytes)

    tree_content = bytes(entry_bytes)
    tree_header = f"tree {len(tree_content)}\0".encode("utf-8")
    result_hash = hashlib.sha1(tree_header + tree_content).hexdigest()
    return result_hash


async def calculate_git_tree_hash(dir_paths: list[str]) -> str:
    """
    Calculate git tree hash for one or more directories using git's tree object
    format. Multiple directories are overlaid later-wins-on-collision
    (pre-merged-tar checksum). Implementation calculates the hash
    directly without spawning git processes, making it much more efficient.
    """
    import logging

    logger = logging.getLogger(__name__)
    logger.info(f"=== SERVER CHECKSUM CALCULATION START for {len(dir_paths)} dirs ===")
    for dp in dir_paths:
        logger.info(f"  - {dp}")

    # Run the recursive calculation in a thread pool to keep it async
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None, lambda: _calculate_git_tree_hash_recursive(dir_paths, "", logger)
    )

    logger.info(f"=== SERVER CHECKSUM CALCULATION END: {result} ===")
    return result


async def update_git(
    bitswan_home: str,
    bitswan_home_host: str,
    deployment_id: str,
    action: str,
    deployed_by: str | None = None,
    message: str | None = None,
    extra_paths: list[str] | None = None,
):
    """
    Update git repository with changes to bitswan.yaml.

    `extra_paths` are additional repo-relative paths to stage in the same commit
    (e.g. firewall DPA PDFs stored under firewall-dpa/<bp>/), so adjacent
    artifacts are versioned and pushed atomically with bitswan.yaml.

    Uses async lock with minimal hold time - only during the actual git operations
    that need to be atomic (add, commit). Pull and push are done with retries
    to handle concurrent access gracefully.
    """
    host_path = os.environ.get("HOST_PATH")

    if host_path:
        bitswan_dir = bitswan_home_host
    else:
        bitswan_dir = bitswan_home

    bitswan_yaml_path = os.path.join(bitswan_dir, "bitswan.yaml")

    # Check if we have a remote (this is a read-only operation, no lock needed)
    has_remote = await call_git_command(
        "git", "remote", "show", "origin", cwd=bitswan_dir
    )

    # Resolve the current branch so we can push/pull explicitly even when no
    # upstream is configured (e.g. on freshly-created copy branches).
    current_branch = None
    if has_remote:
        stdout, _, rc = await call_git_command_with_output(
            "git", "rev-parse", "--abbrev-ref", "HEAD", cwd=bitswan_dir
        )
        if rc == 0:
            current_branch = stdout.strip() or None

    # Use async lock with shorter timeout - operations should be fast
    async with GitLockContext(timeout=10.0):
        # Pull latest changes if we have a remote and the remote tracking
        # branch exists. Skip the pull for branches that only live locally
        # (e.g. new copy branches that have never been pushed).
        if has_remote and current_branch:
            await call_git_command(
                "git", "fetch", "origin", current_branch, cwd=bitswan_dir
            )
            _, _, rc = await call_git_command_with_output(
                "git",
                "rev-parse",
                "--verify",
                f"refs/remotes/origin/{current_branch}",
                cwd=bitswan_dir,
            )
            if rc == 0:
                res = await call_git_command(
                    "git",
                    "pull",
                    "--rebase=false",
                    "origin",
                    current_branch,
                    cwd=bitswan_dir,
                )
                if not res:
                    # Try to recover from merge conflicts by accepting ours for bitswan.yaml
                    await call_git_command(
                        "git", "checkout", "--ours", bitswan_yaml_path, cwd=bitswan_dir
                    )
                    await call_git_command(
                        "git", "add", bitswan_yaml_path, cwd=bitswan_dir
                    )

        # Stage and commit changes
        await call_git_command("git", "add", bitswan_yaml_path, cwd=bitswan_dir)

        # Also stage docker-compose.yaml if it exists (generated by AutomationService)
        # Check existence using the container path (bitswan_home), but add using bitswan_dir
        # which may be the host path when HOST_PATH is set.
        dc_container_path = os.path.join(bitswan_home, "docker-compose.yaml")
        if os.path.exists(dc_container_path):
            dc_git_path = os.path.join(bitswan_dir, "docker-compose.yaml")
            await call_git_command("git", "add", dc_git_path, cwd=bitswan_dir)

        # Stage any extra repo-relative artifacts (e.g. firewall DPA PDFs).
        for rel in extra_paths or []:
            await call_git_command(
                "git", "add", os.path.join(bitswan_dir, rel), cwd=bitswan_dir
            )

        # Attribute the commit to the operator who triggered the deploy/promote.
        # `deployed_by` is their email; use it for BOTH the author and the
        # committer so `git log --format='%an <%ae>|%cn <%ce>'` shows the
        # operator, not the gitops service identity. We set the committer via
        # `-c user.name/user.email` (which survive the nsenter/host path that
        # GIT_COMMITTER_* env vars would not) and the author via --author.
        if deployed_by:
            author = f"{deployed_by} <{deployed_by}>"
            ident_name = deployed_by
            ident_email = deployed_by
        else:
            author = "gitops <info@bitswan.space>"
            ident_name = "gitops"
            ident_email = "gitops@gitops.com"
        await call_git_command(
            "git",
            "-c",
            f"user.name={ident_name}",
            "-c",
            f"user.email={ident_email}",
            "commit",
            "--author",
            author,
            "-m",
            message or f"{action} deployment {deployment_id}",
            cwd=bitswan_dir,
        )

        subprocess.run(["chown", "-R", "1000:1000", "/gitops/gitops"], check=False)

        # Push changes if we have a remote. Use -u with an explicit branch so
        # the first push from a new branch sets its upstream instead of failing
        # with "no upstream branch".
        if has_remote:
            if current_branch:
                res = await call_git_command(
                    "git",
                    "push",
                    "-u",
                    "origin",
                    current_branch,
                    cwd=bitswan_dir,
                )
            else:
                res = await call_git_command("git", "push", cwd=bitswan_dir)
            if not res:
                raise Exception("Error pushing to git")


_COMPOSE_EVENT_STATES = (
    "Creating",
    "Created",
    "Starting",
    "Started",
    "Waiting",
    "Healthy",
    "Running",
    "Recreated",
)


def _compose_event_message(line: str) -> str | None:
    """Turn a `docker compose up` stderr line into a human deploy-progress
    message, or None if it carries no container state transition.

    Lines look like ` Container <name>  <State>` (plain text in non-TTY mode).
    We surface container lifecycle so a long container-start phase — e.g. the
    worker waiting on the egress firewall gateway's health gate before it can
    start — keeps the deploy UI moving instead of sitting on a static message.
    """
    s = line.strip()
    idx = s.find("Container ")
    if idx == -1:
        return None
    rest = s[idx + len("Container ") :].strip()
    parts = rest.rsplit(None, 1)
    if len(parts) != 2:
        return None
    name, state = parts[0].strip(), parts[1].strip()
    if state not in _COMPOSE_EVENT_STATES:
        return None
    return f"Starting containers… ({name} {state.lower()})"


async def ensure_docker_network(name: str) -> None:
    """Create a Docker network if it doesn't already exist (idempotent).

    The per-(workspace, stage) networks are declared `external: true` in the
    generated compose, so `docker compose up` fails unless they already exist.
    The daemon also creates them (and multi-homes the workspace sub-traefik
    across them) — this guards the ordering so a deploy never races ahead of
    the daemon. Safe to call concurrently: a create that loses the race to an
    already-existing network is ignored.
    """
    inspect = await asyncio.create_subprocess_exec(
        "docker",
        "network",
        "inspect",
        name,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    if await inspect.wait() == 0:
        return
    create = await asyncio.create_subprocess_exec(
        "docker",
        "network",
        "create",
        name,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    await create.communicate()  # ignore "already exists" lost-race errors


async def save_image(
    build_context_path: str,
    build_context_hash: str,
    image_tag: str,
    copy_context: bool = True,
    build_status: Optional[str] = None,
    log_file_path: Optional[str] = None,
):
    """
    Save and commit the build context (extracted zip contents) to git.
    Uses the build_context_hash as the directory name for deduplication.

    Uses async lock with minimal hold time for better concurrency.
    """

    bs_home = os.environ.get("BITSWAN_GITOPS_DIR", "/mnt/repo/pipeline")
    bitswan_dir = os.path.join(bs_home, "gitops")

    images_base_dir = os.path.join(bitswan_dir, "images")
    image_dir = os.path.join(images_base_dir, build_context_hash)
    source_dir = os.path.join(image_dir, "src")

    # File system operations don't need the git lock
    if not os.path.exists(images_base_dir):
        os.makedirs(images_base_dir, exist_ok=True)
        subprocess.run(["chown", "-R", "1000:1000", images_base_dir], check=False)

    # Create the specific image directory
    os.makedirs(image_dir, exist_ok=True)
    subprocess.run(["chown", "-R", "1000:1000", image_dir], check=False)

    # Copy the build context to the gitops directory if requested
    if copy_context:
        source_abs = os.path.abspath(build_context_path)
        destination_abs = os.path.abspath(source_dir)
        if source_abs != destination_abs:
            if os.path.exists(source_dir):
                shutil.rmtree(source_dir)
            shutil.copytree(build_context_path, source_dir)

    log_relative_path = None
    if log_file_path and os.path.exists(log_file_path):
        try:
            log_relative_path = os.path.relpath(log_file_path, bitswan_dir)
        except ValueError:
            log_relative_path = None

    # Check if we have a remote (read-only, no lock needed)
    has_remote = await call_git_command(
        "git", "remote", "show", "origin", cwd=bitswan_dir
    )

    # Use async lock for the actual git operations
    async with GitLockContext(timeout=10.0):
        if has_remote:
            res = await call_git_command(
                "git", "pull", "--rebase=false", cwd=bitswan_dir
            )
            if not res:
                # Non-fatal - we'll try to push anyway
                pass

        add_result = await call_git_command(
            "git", "add", os.path.join("images", build_context_hash), cwd=bitswan_dir
        )
        if not add_result:
            raise Exception("Error adding files to git")

        if log_relative_path:
            log_add_result = await call_git_command(
                "git",
                "add",
                log_relative_path,
                cwd=bitswan_dir,
            )
            if not log_add_result:
                raise Exception("Error adding log file to git")

        commit_message = f"Add build context {build_context_hash}"
        if image_tag:
            commit_message += f" for image {image_tag}"
        if build_status:
            commit_message += f" ({build_status})"
        await call_git_command(
            "git",
            "commit",
            "-m",
            commit_message,
            cwd=bitswan_dir,
        )

        subprocess.run(["chown", "-R", "1000:1000", "/gitops/gitops"], check=False)

        if has_remote:
            res = await call_git_command("git", "push", cwd=bitswan_dir)
            if not res:
                raise Exception("Error pushing to git")


async def merge_bitswan_yaml(src_path: str, dst_path: str):
    """
    Merge bitswan.yaml files by combining deployments from both files.
    """
    try:
        # Load existing bitswan.yaml if it exists
        existing_yaml = {}
        if os.path.exists(dst_path):
            with open(dst_path, "r") as f:
                existing_yaml = yaml.safe_load(f) or {}

        # Load new bitswan.yaml from worktree
        new_yaml = {}
        if os.path.exists(src_path):
            with open(src_path, "r") as f:
                new_yaml = yaml.safe_load(f) or {}

        # Merge deployments
        merged_yaml = existing_yaml.copy()
        if "deployments" not in merged_yaml:
            merged_yaml["deployments"] = {}

        if "deployments" in new_yaml:
            merged_yaml["deployments"].update(new_yaml["deployments"])

        # Write merged yaml
        with open(dst_path, "w") as f:
            yaml.dump(merged_yaml, f, default_flow_style=False, sort_keys=False)

    except Exception:
        shutil.copy2(src_path, dst_path)


async def merge_worktree(worktree_path: str, repo: str):
    for item in os.listdir(worktree_path):
        if item == ".git":
            continue

        src_path = os.path.join(worktree_path, item)
        dst_path = os.path.join(repo, item)

        if item == "bitswan.yaml":
            await merge_bitswan_yaml(src_path, dst_path)
            continue

        if os.path.exists(dst_path):
            if os.path.isdir(dst_path):
                shutil.rmtree(dst_path)
            else:
                os.remove(dst_path)

        if os.path.isdir(src_path):
            shutil.copytree(src_path, dst_path)
        else:
            shutil.copy2(src_path, dst_path)


async def copy_worktree(branch_name: str = None):
    """
    Create a temp worktree for the target branch, copy files to main repo, then clean up.
    This works regardless of whether the current directory is already a worktree.

    Uses async lock with optimized hold time - file copying is done outside the lock.
    """
    bs_home = os.environ.get("BITSWAN_GITOPS_DIR", "/mnt/repo/pipeline")
    repo = os.path.join(bs_home, "gitops")

    temp_dir = tempfile.mkdtemp(prefix=f"gitops_worktree_{branch_name}_")
    worktree_path = os.path.join(temp_dir, "worktree")

    try:
        # Use async lock for git operations
        async with GitLockContext(timeout=15.0):
            if not await call_git_command(
                "git", "fetch", "origin", "--prune", "--tags", cwd=repo
            ):
                raise HTTPException(
                    status_code=500, detail="Failed to fetch from origin"
                )
            if not await call_git_command(
                "git", "rev-parse", f"origin/{branch_name}", cwd=repo
            ):
                raise HTTPException(
                    status_code=404,
                    detail=f"Remote branch origin/{branch_name} not found",
                )

            if not await call_git_command(
                "git",
                "worktree",
                "add",
                worktree_path,
                f"origin/{branch_name}",
                cwd=repo,
            ):
                raise HTTPException(
                    status_code=409,
                    detail=f"Failed to create worktree for origin/{branch_name}",
                )
            if not await call_git_command("git", "reset", "--hard", "HEAD", cwd=repo):
                raise HTTPException(
                    status_code=409, detail="Failed to reset working tree"
                )

        # File merge operations don't need the git lock
        await merge_worktree(worktree_path, repo)

        # Re-acquire lock for staging and committing
        async with GitLockContext(timeout=10.0):
            if not await call_git_command("git", "add", "-A", cwd=repo):
                raise HTTPException(status_code=409, detail="Failed to stage files")

            msg = f"Switch to content from origin/{branch_name} using worktree"
            await call_git_command("git", "commit", "-m", msg, cwd=repo)

            has_remote = await call_git_command(
                "git", "remote", "show", "origin", cwd=repo
            )
            if has_remote:
                if not await call_git_command(
                    "git", "push", "-u", "origin", "HEAD", cwd=repo
                ):
                    print(
                        f"Warning: Push failed for branch {branch_name}, continuing anyway"
                    )

            # Remove worktree while holding lock to prevent conflicts
            try:
                if os.path.exists(worktree_path):
                    await call_git_command(
                        "git", "worktree", "remove", worktree_path, cwd=repo
                    )
            except Exception as e:
                print(f"Failed to remove worktree: {e}")

    finally:
        try:
            if os.path.exists(temp_dir):
                shutil.rmtree(temp_dir)
        except Exception as e:
            print(f"Failed to remove temp directory: {e}")
