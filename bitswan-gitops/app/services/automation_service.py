import asyncio
import copy
import hashlib
import logging
import os
import json
import re
import shutil
import subprocess
import tarfile
import tempfile
import uuid
import yaml
import requests
from datetime import date, datetime
from functools import lru_cache
from typing import Any, Callable
from app.models import DeployedAutomation
from app.utils import (
    AutomationConfig,
    calculate_git_tree_hash,
    docker_compose_up,
    generate_workspace_url,
    read_bitswan_yaml,
    reconcile_ingress,
    workspace_route,
    dump_bitswan_yaml,
    load_yaml,
    read_automation_config,
    sanitize_automation_name,
    update_git,
    call_git_command,
    call_git_command_with_output,
    copy_worktree,
    GitLockContext,
)
from app.async_docker import get_async_docker_client, DockerError
from app.deploy_manager import deploy_manager
from app.services.image_service import ImageService
from app.services import bp_secrets
from app.services import supply_chain_service
from app.services import firewall_service
from app.services.oauth2_helpers import (
    OAUTH2_PROXY_PATH,
    copy_oauth2_proxy_to_container,
    is_oauth2_proxy_running,
)
from fastapi import HTTPException

logger = logging.getLogger(__name__)


@lru_cache(maxsize=2048)
def _parse_revision_bitswan(gitops_dir: str, sha: str) -> dict:
    """Whole parsed `bitswan.yaml` at a git commit.

    A commit's content is immutable, so this is memoized by (gitops_dir, sha):
    deployment history derives from the git log of bitswan.yaml and re-reads the
    same revisions on every page load (and once per stage), so caching the parse
    turns repeat loads into pure cache hits. Returns {} if the revision is
    missing or unparseable. Uses the fast libyaml loader via load_yaml.
    """
    proc = subprocess.run(
        ["git", "show", f"{sha}:bitswan.yaml"],
        cwd=gitops_dir,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return {}
    try:
        y = load_yaml(proc.stdout) or {}
    except Exception:
        return {}
    return y if isinstance(y, dict) else {}


def _parse_revision_business_processes(gitops_dir: str, sha: str) -> dict:
    """Parsed `business_processes` map from `bitswan.yaml` at a git commit."""
    return _parse_revision_bitswan(gitops_dir, sha).get("business_processes") or {}


def _parse_revision_firewall_realm(
    gitops_dir: str, sha: str, bp: str, realm: str
) -> dict:
    """The `firewall[bp][realm]` node (rules + posture) at a git commit, or {}.
    Firewall rules are versioned in bitswan.yaml just like deployments, so each
    distinct state across commits is one audit-log / rollback point."""
    fw = _parse_revision_bitswan(gitops_dir, sha).get("firewall") or {}
    return ((fw.get(bp) or {}).get(realm) or {}) if isinstance(fw, dict) else {}


def _parse_revision_backups(gitops_dir: str, sha: str, bp: str) -> dict:
    """The `backups[bp]` node (live_slot + retention + audit log) at a git
    commit, or {}. Backup-domain actions (create/restore/swap/retention) are
    versioned in bitswan.yaml like deployments and firewall, so each distinct
    state across commits is one audit-log entry in the deployment history."""
    bk = _parse_revision_bitswan(gitops_dir, sha).get("backups") or {}
    return (bk.get(bp) or {}) if isinstance(bk, dict) else {}


def _short_hash(context: str) -> str:
    """Deterministic 4-char hash for a context string."""
    return hashlib.sha256(context.encode()).hexdigest()[:4]


def update_automation_toml_image(toml_path: str, new_image_value: str) -> None:
    """Rewrite the `image` field under `[deployment]` in `automation.toml`,
    preserving the rest of the file's formatting. Creates the file (and the
    section) if missing.
    """
    if not os.path.exists(toml_path):
        os.makedirs(os.path.dirname(toml_path), exist_ok=True)
        with open(toml_path, "w") as f:
            f.write(f'[deployment]\nimage = "{new_image_value}"\n')
        return

    with open(toml_path, "r") as f:
        content = f.read()

    newline = "\r\n" if "\r\n" in content else "\n"
    lines = content.split(newline) if newline in content else content.split("\n")

    section_re = re.compile(r"^\s*\[(.+?)\]\s*$")
    image_re = re.compile(r"^\s*image\s*=\s*")

    in_deployment = False
    image_line_idx = -1
    deployment_section_idx = -1
    for i, raw in enumerate(lines):
        m = section_re.match(raw)
        if m:
            in_deployment = m.group(1).strip().lower() == "deployment"
            if in_deployment:
                deployment_section_idx = i
            continue
        if in_deployment and image_re.match(raw):
            image_line_idx = i
            break

    expected_line = f'image = "{new_image_value}"'

    if image_line_idx >= 0:
        existing = lines[image_line_idx].strip()
        if existing == expected_line:
            return
        # Preserve leading whitespace.
        leading_ws_len = len(lines[image_line_idx]) - len(
            lines[image_line_idx].lstrip()
        )
        lines[image_line_idx] = lines[image_line_idx][:leading_ws_len] + expected_line
    elif deployment_section_idx >= 0:
        lines.insert(deployment_section_idx + 1, expected_line)
    else:
        if lines and lines[-1] != "":
            lines.append("")
        lines.append("[deployment]")
        lines.append(expected_line)

    with open(toml_path, "w") as f:
        f.write(newline.join(lines))


# Directories never considered as automation sources during workspace scans.
_SCAN_SKIP_DIRS = {"templates", ".git"}


def _copies_dir() -> str:
    """Base directory (inside the gitops container) holding the per-copy
    checkouts. Each copy is an independent clone of the canonical repo; the
    `main` copy is the default-branch scope."""
    return os.environ.get("BITSWAN_COPIES_DIR", "/copies")


def scan_workspace_sources(workspace_root: str, copy: str | None = None) -> list[dict]:
    """Walk the filesystem for automation sources marked by `automation.toml`.

    Scans the `main` copy when `copy` is None, or the named copy otherwise.
    Returns one dict per automation directory with enough metadata for both
    deploy-time use and dashboard discovery.

    Each entry:
        deployment_id  — id matching the existing live-dev format
        automation_name — sanitized basename
        display_name    — original directory name (unsanitized)
        context         — BP name (or "copy-{name}-{bp}" for non-main copies)
        stage           — always "live-dev" (caller may override)
        relative_path   — volume-relative path under the workspace, always
                          "copies/<copy>/<rel>" (copy is "main" for the default)
        source_path     — absolute filesystem path
        copy            — the copy name (None for the main copy)

    `workspace_root` is accepted for backwards compatibility but no longer used
    to locate sources — copies live under BITSWAN_COPIES_DIR.
    """
    scope = copy or "main"
    scan_root = os.path.join(_copies_dir(), scope)
    if not os.path.isdir(scan_root):
        return []

    results: list[dict] = []
    seen_ids: set[str] = set()
    for root, dirs, files in os.walk(scan_root):
        dirs[:] = [d for d in dirs if d not in _SCAN_SKIP_DIRS]
        if "automation.toml" not in files:
            continue

        rel_path = os.path.relpath(root, scan_root)
        source_name = os.path.basename(root)
        sanitized = sanitize_automation_name(source_name)
        rel_parts = rel_path.replace("\\", "/").split("/")
        bp_name = sanitize_automation_name(rel_parts[0]) if len(rel_parts) >= 2 else ""
        bp_prefix = f"{bp_name}-" if bp_name else ""

        if copy:
            bp_suffix = f"-{bp_name}" if bp_name else ""
            context = f"copy-{copy}{bp_suffix}"
            deployment_id = f"{sanitized}-{context}-live-dev"
            relative_path = f"copies/{copy}/{rel_path}"
        else:
            # main copy: unprefixed, matching legacy main-repo deployment ids.
            context = bp_name
            deployment_id = f"{sanitized}-{bp_prefix}live-dev"
            relative_path = f"copies/main/{rel_path}"

        if deployment_id in seen_ids:
            continue
        seen_ids.add(deployment_id)
        results.append(
            {
                "deployment_id": deployment_id,
                "automation_name": sanitized,
                "display_name": source_name,
                "context": context,
                "stage": "live-dev",
                "relative_path": relative_path,
                "source_path": root,
                "copy": copy,
            }
        )
    return results


MAX_NAME_LEN = 24


def make_hostname_label(
    workspace_name: str,
    automation_name: str,
    context: str,
    stage: str,
    slot: str | None = None,
) -> str:
    """Build a DNS hostname label from structured components.

    No string parsing — components are passed in directly.
    workspace_name and automation_name are each capped at 24 chars to
    guarantee the result fits within the 63-char DNS label limit.

    `slot` ('a'/'b') is the blue-green production slot. It is appended as a
    trailing segment so each slot's containers get a distinct, stable name
    (`…-a` / `…-b`); the ingress repoint switches which slot the production
    hostname resolves to. Non-production deployments pass slot=None and are
    byte-identical to before.
    """
    ws = workspace_name[:MAX_NAME_LEN]
    an = automation_name[:MAX_NAME_LEN]
    suffix = f"-{slot}" if slot else ""
    if context:
        h = _short_hash(context)
        base = f"{ws}-{an}-{h}-{stage}" if stage else f"{ws}-{an}-{h}"
    else:
        base = f"{ws}-{an}-{stage}" if stage else f"{ws}-{an}"
    return f"{base}{suffix}"


class AutomationService:
    def __init__(self):
        self.bs_home = os.environ.get("BITSWAN_GITOPS_DIR", "/mnt/repo/pipeline")
        self.bs_home_host = os.environ.get(
            "BITSWAN_GITOPS_DIR_HOST", "/home/root/.config/bitswan/local-gitops/"
        )
        self.workspace_id = os.environ.get("BITSWAN_WORKSPACE_ID")
        self.workspace_name = os.environ.get(
            "BITSWAN_WORKSPACE_NAME", "workspace-local"
        )
        self.aoc_url = os.environ.get("BITSWAN_AOC_URL")
        self.aoc_token = os.environ.get("BITSWAN_AOC_TOKEN")
        self.gitops_domain = os.environ.get("BITSWAN_GITOPS_DOMAIN")
        self.workspace_name = os.environ.get("BITSWAN_WORKSPACE_NAME")
        self.oauth2_proxy_path = OAUTH2_PROXY_PATH
        self.certs_dir_host = os.environ.get("BITSWAN_CERTS_DIR")
        self.gitops_dir = os.path.join(self.bs_home, "gitops")
        self.gitops_dir_host = os.path.join(self.bs_home_host, "gitops")
        self.secrets_dir = os.path.join(self.bs_home, "secrets")
        # Workspace directory for live-dev mode (source code mounting).
        self.workspace_dir = os.path.join(self.bs_home, "workspace")
        self.workspace_dir_host = os.path.join(self.bs_home_host, "workspace")
        # Workspace repo directory (mounted at /workspace-repo in container)
        # Used to read automation.toml for live-dev config
        self.workspace_repo_dir = os.environ.get(
            "BITSWAN_WORKSPACE_REPO_DIR", "/workspace-repo"
        )
        # Cache full history per deployment_id: {deployment_id: (commit_hash, [entries])}
        self._history_cache: dict[str, tuple[str, list]] = {}
        # Scope-keyed cache mirroring ProcessService._cache. Key = copy
        # name, or None for main. Holds STATIC entries (yaml + filesystem
        # scan); Docker container state is overlaid live by get_automations()
        # so we don't have to couple this cache to Docker events. Refreshed
        # by the filesystem watchers in app/lifespan.py whenever
        # bitswan.yaml or any automation.toml changes.
        self._cache: dict[str | None, list[DeployedAutomation]] = {}

    async def warm_history_cache(self):
        """Pre-warm the history cache for all known deployments."""
        logger = logging.getLogger(__name__)
        bs_yaml = read_bitswan_yaml(self.gitops_dir)
        if not bs_yaml or "deployments" not in bs_yaml:
            logger.info("History cache warm-up: no deployments found, skipping")
            return

        deployment_ids = list(bs_yaml["deployments"].keys())
        logger.info(
            f"History cache warm-up: warming {len(deployment_ids)} deployment(s)"
        )
        for deployment_id in deployment_ids:
            try:
                await self.get_automation_history(deployment_id)
            except Exception as e:
                logger.warning(
                    f"History cache warm-up: failed for {deployment_id}: {e}"
                )
        logger.info("History cache warm-up: done")

    async def get_container(self, deployment_id) -> list[dict]:
        """Get containers for a specific deployment using async Docker client."""
        docker_client = get_async_docker_client()
        containers = await docker_client.list_containers(
            all=True,
            filters={
                "label": [
                    f"gitops.deployment_id={deployment_id}",
                    f"gitops.workspace={self.workspace_name}",
                ]
            },
        )
        return containers

    async def inspect_automation(self, deployment_id: str) -> list[dict]:
        """Get full docker inspect for all containers of a deployment."""
        containers = await self.get_container(deployment_id)
        if not containers:
            return []
        docker_client = get_async_docker_client()
        results = []
        for container in containers:
            container_id = container.get("Id") or container.get("id")
            if container_id:
                try:
                    inspect_data = await docker_client.get_container(container_id)
                    results.append(inspect_data)
                except Exception:
                    pass  # container may have been removed
        return results

    async def get_containers(self) -> list[dict]:
        """Get all gitops containers using async Docker client."""
        docker_client = get_async_docker_client()
        containers = await docker_client.list_containers(
            all=True,
            filters={
                "label": [
                    "gitops.deployment_id",
                    f"gitops.workspace={self.workspace_name}",
                ]
            },
        )
        return containers

    def _yaml_scope(self, relative_path: str | None) -> str | None:
        """Classify a `bitswan.yaml` deployment into a cache scope.

        Main scope = `None` — paths not under `copies/`, or under the `main`
        copy (`copies/main/...`).
        Copy scope = the copy's name, parsed out of `copies/<copy>/...`.
        """
        if not relative_path:
            return None
        norm = relative_path.replace("\\", "/").lstrip("/")
        if not norm.startswith("copies/"):
            return None
        rest = norm[len("copies/") :]
        copy = rest.split("/", 1)[0]
        if not copy or copy == "main":
            return None
        return copy

    def _build_static_entries(
        self, scope: str | None, bs_yaml: dict | None
    ) -> list[DeployedAutomation]:
        """Build the static (yaml + scan) entries for a single scope.

        Container/state/status/url fields are left blank — Docker overlay
        is applied live by `get_automations()` so we don't have to couple
        the cache to Docker events.
        """

        def _expose_for(rel_or_dir: str | None) -> bool:
            """Read [deployment] expose from an automation's directory. Frontends
            (expose=true) vs worker containers (expose=false) — definition-based,
            so undeployed automations classify correctly. Best-effort."""
            if not rel_or_dir:
                return False
            d = (
                rel_or_dir
                if os.path.isabs(rel_or_dir)
                else os.path.join(self.workspace_repo_dir, rel_or_dir)
            )
            try:
                cfg = read_automation_config(d)
                return bool(cfg and cfg.expose)
            except Exception:
                return False

        deployments = (bs_yaml or {}).get("deployments", {}) or {}
        deployed: list[DeployedAutomation] = []
        for deployment_id, cfg in deployments.items():
            if self._yaml_scope(cfg.get("relative_path")) != scope:
                continue
            deployed.append(
                DeployedAutomation(
                    container_id=None,
                    endpoint_name=None,
                    created_at=None,
                    name=deployment_id,
                    state=None,
                    status=None,
                    deployment_id=deployment_id,
                    active=cfg.get("active", False),
                    automation_url=None,
                    relative_path=cfg.get("relative_path", None),
                    # Production is persisted as an empty-string stage in
                    # bitswan.yaml; normalise it back to "production" so SSE/REST
                    # consumers see a canonical stage value (clients filter on
                    # exactly "dev"|"staging"|"production").
                    stage=(cfg.get("stage") or "production"),
                    automation_name=cfg.get("automation_name", None),
                    context=cfg.get("context", None),
                    version_hash=cfg.get("checksum", None),
                    replicas=cfg.get("replicas", 1),
                    expose=_expose_for(cfg.get("relative_path")),
                )
            )

        # Discoverable: on-disk automations not represented in bitswan.yaml,
        # matched by (automation_name, relative_path) — same key as before.
        deployed_keys = {
            ((d.automation_name or "").lower(), (d.relative_path or "").rstrip("/"))
            for d in deployed
        }
        discoverable: list[DeployedAutomation] = []
        for src in scan_workspace_sources(self.workspace_repo_dir, copy=scope):
            key = (src["automation_name"], src["relative_path"].rstrip("/"))
            if key in deployed_keys:
                continue
            discoverable.append(
                DeployedAutomation(
                    container_id=None,
                    endpoint_name=None,
                    created_at=None,
                    name=src["display_name"],
                    state=None,
                    status=None,
                    deployment_id=None,
                    active=False,
                    automation_url=None,
                    relative_path=src["relative_path"],
                    stage=None,
                    automation_name=src["automation_name"],
                    context=src["context"],
                    version_hash=None,
                    replicas=1,
                    expose=_expose_for(src.get("source_path")),
                )
            )

        return deployed + discoverable

    async def refresh(self, copy: str | None = None) -> list[DeployedAutomation]:
        """Recompute one scope's static automation list and cache it."""
        bs_yaml = read_bitswan_yaml(self.gitops_dir) or {"deployments": {}}
        entries = self._build_static_entries(copy, bs_yaml)
        self._cache[copy] = entries
        return entries

    async def refresh_all(self) -> None:
        """Refresh main + every other copy on disk; drop stale scope keys."""
        bs_yaml = read_bitswan_yaml(self.gitops_dir) or {"deployments": {}}
        self._cache[None] = self._build_static_entries(None, bs_yaml)

        copies_root = _copies_dir()
        live: set[str] = set()
        if os.path.isdir(copies_root):
            for entry in os.listdir(copies_root):
                if entry.startswith("."):
                    continue
                # The `main` copy is the None scope, refreshed above.
                if entry == "main":
                    continue
                if not os.path.isdir(os.path.join(copies_root, entry)):
                    continue
                live.add(entry)
                self._cache[entry] = self._build_static_entries(entry, bs_yaml)

        # Forget copy scopes that have disappeared since the last refresh.
        for stale in [k for k in self._cache.keys() if k is not None and k not in live]:
            self._cache.pop(stale, None)

    def forget_copy(self, copy: str) -> None:
        self._cache.pop(copy, None)

    def _apply_docker_overlay(
        self,
        entries: list[DeployedAutomation],
        containers: list[dict],
        info: dict,
        bs_yaml: dict,
    ) -> None:
        """Fill in container_id/state/status/created_at/automation_url/endpoint_name
        on the cached static entries — in place, since each `get_automations()`
        call constructs fresh DeployedAutomation copies from the cache snapshot.
        """
        gitops_domain = os.environ.get("BITSWAN_GITOPS_DOMAIN", None)
        dep_configs = (bs_yaml or {}).get("deployments", {}) or {}
        by_id = {a.deployment_id: a for a in entries if a.deployment_id}

        for container in containers:
            labels = container.get("Labels", {})
            deployment_id = labels.get("gitops.deployment_id")
            if not deployment_id:
                continue
            # Blue-green production runs two distinct container sets per member.
            # The LIVE slot's container is labelled with the bare deployment_id
            # and overlays its base entry; a STANDBY/idle slot's container is
            # labelled `<dep_id>@<slot>` and has no base entry — surface it as a
            # SEPARATE automation (cloned from the base) so the DR stage shows
            # its own container, never the live one. Its public URL is the stable
            # `-dr` host (the ingress route the swap repoints), not a slot host.
            base_id = deployment_id.split("@")[0]
            slot = deployment_id.split("@")[1] if "@" in deployment_id else None
            if deployment_id not in by_id:
                if slot and base_id in by_id:
                    a = by_id[base_id].model_copy()
                    a.deployment_id = deployment_id
                    entries.append(a)
                    by_id[deployment_id] = a
                else:
                    continue
            else:
                a = by_id[deployment_id]

            label = labels.get("gitops.intended_exposed", "false")
            dep_conf = dep_configs.get(base_id, {})
            url = generate_workspace_url(
                self.workspace_name,
                dep_conf.get("automation_name", base_id),
                dep_conf.get("context", ""),
                # Standby slot's stable user-facing URL is the `-dr` host; the
                # live slot keeps the canonical production URL.
                "dr" if slot else (dep_conf.get("stage", "production") or "production"),
                gitops_domain,
                True,
            )
            if label != "true":
                url = None

            created_str = container.get("Created")
            created_at = None
            if created_str:
                try:
                    created_at = datetime.utcfromtimestamp(created_str)
                except (ValueError, TypeError):
                    pass

            a.container_id = container.get("Id")
            a.endpoint_name = info.get("Name")
            a.created_at = created_at
            a.state = container.get("State", "unknown")
            a.status = container.get("Status", "")
            a.automation_url = url

    async def get_automations(self) -> list[DeployedAutomation]:
        """Return every automation across all scopes, with live Docker state.

        Reads the scope-keyed static cache built by `refresh()` / `refresh_all()`;
        Docker container state is fetched on each call and overlaid in place
        (cheap — one Docker API call). The cache is warmed on first use if a
        startup warmup hasn't run yet.
        """
        if not self._cache:
            await self.refresh_all()

        # Re-read bitswan.yaml for the overlay (URL generation needs the
        # current deployment config). The cache itself was built from the
        # same file, so the cost is minor.
        bs_yaml = read_bitswan_yaml(self.gitops_dir) or {"deployments": {}}

        # Deep-copy each entry so the overlay doesn't mutate cached objects.
        result: list[DeployedAutomation] = []
        for entries in self._cache.values():
            for a in entries:
                result.append(a.model_copy() if hasattr(a, "model_copy") else a)

        docker_client = get_async_docker_client()
        info = await docker_client.info()
        containers = await self.get_containers()
        self._apply_docker_overlay(result, containers, info, bs_yaml)
        return result

    async def materialize_merged_tree(self, dirs: list[str], checksum: str) -> str:
        """Copy `dirs` (later-wins-on-collision) into `gitops_dir/<checksum>/`
        and commit. No-op if the target directory already exists. Returns the
        absolute output path.

        Source files come from the workspace bind-mount (not from an upload).
        Symlinks are preserved verbatim (same as the hash function), so the
        materialized tree round-trips through `calculate_git_tree_hash` to
        the same digest.
        """
        output_dir = os.path.join(self.gitops_dir, checksum)
        if os.path.exists(output_dir) and os.listdir(output_dir):
            return output_dir

        tmp_dir = output_dir + ".tmp"
        if os.path.exists(tmp_dir):
            shutil.rmtree(tmp_dir)
        os.makedirs(tmp_dir, exist_ok=True)

        try:
            self._copy_merged_tree_sync(dirs, tmp_dir)
            if os.path.exists(output_dir):
                shutil.rmtree(output_dir)
            os.rename(tmp_dir, output_dir)
        except Exception:
            if os.path.exists(tmp_dir):
                shutil.rmtree(tmp_dir, ignore_errors=True)
            raise

        async with GitLockContext(timeout=10.0):
            await call_git_command("git", "add", f"{checksum}", cwd=self.gitops_dir)
            await call_git_command(
                "git",
                "commit",
                "-m",
                f"Add asset {checksum} (workspace-mounted)",
                cwd=self.gitops_dir,
            )
            # Push is best-effort — there may be no remote configured in dev.
            try:
                await call_git_command("git", "push", cwd=self.gitops_dir)
            except Exception:
                logger.warning(
                    "git push failed after materialize_merged_tree; continuing"
                )

        return output_dir

    @staticmethod
    def _copy_merged_tree_sync(dirs: list[str], dest_root: str) -> None:
        """Walk `dirs` in order, writing each entry into `dest_root` with
        later-wins semantics. Mirrors the entry-map logic in
        `calculate_git_tree_hash` so the materialized tree hashes back
        to the same checksum.
        """

        def walk(rel: str) -> None:
            entries: dict[str, tuple[str, bool, bool]] = {}
            for d in dirs:
                full = os.path.join(d, rel) if rel else d
                if not os.path.isdir(full):
                    continue
                for name in os.listdir(full):
                    if name == ".git":
                        continue
                    src = os.path.join(full, name)
                    is_symlink = os.path.islink(src)
                    if is_symlink:
                        entries[name] = (src, False, True)
                        continue
                    is_dir = os.path.isdir(src)
                    if not is_dir and not os.path.isfile(src):
                        continue
                    if not os.access(src, os.R_OK):
                        continue
                    entries[name] = (src, is_dir, False)

            for name, (src, is_dir, is_symlink) in entries.items():
                dest = (
                    os.path.join(dest_root, rel, name)
                    if rel
                    else os.path.join(dest_root, name)
                )
                # If dest exists with a different type than the incoming
                # entry, remove it so the write below succeeds. Mirrors the
                # hash overlay's type-aware later-wins behavior.
                if os.path.lexists(dest):
                    dest_is_link = os.path.islink(dest)
                    dest_is_dir = (not dest_is_link) and os.path.isdir(dest)
                    incoming_is_real_dir = is_dir and not is_symlink
                    if dest_is_dir != incoming_is_real_dir:
                        if dest_is_dir:
                            shutil.rmtree(dest)
                        else:
                            os.unlink(dest)
                if is_symlink:
                    target = os.readlink(src)
                    if os.path.lexists(dest):
                        os.unlink(dest)
                    os.symlink(target, dest)
                elif is_dir:
                    os.makedirs(dest, exist_ok=True)
                    walk(f"{rel}/{name}" if rel else name)
                else:
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                    shutil.copy2(src, dest, follow_symlinks=False)

        walk("")

    async def _ensure_automation_image(
        self,
        source_dir: str,
        progress_callback: Callable[..., Any] | None = None,
    ) -> str | None:
        """Build the automation's image from `<source_dir>/image/Dockerfile` and
        write the resulting tag into `<source_dir>/automation.toml`.

        Build algorithm:

          * Image content-addressed by the git-tree hash of the `image/`
            subdirectory.
          * Tag template: `internal/{workspace}-{bp}-{automation}:sha{checksum}`.
          * Skips the build if an image with the same tag is already present.
          * Updates `automation.toml` so subsequent deploys pick up the
            freshly-built tag.

        Returns the resolved image tag, or `None` if the automation has no
        `image/` directory (in which case `deploy_automation` falls back to
        the runtime-environment default).
        """
        image_dir = os.path.join(source_dir, "image")
        if not os.path.isfile(os.path.join(image_dir, "Dockerfile")):
            return None

        auto_name = sanitize_automation_name(
            os.path.basename(source_dir.rstrip(os.sep))
        )
        parent = os.path.dirname(source_dir.rstrip(os.sep))
        bp_name = sanitize_automation_name(os.path.basename(parent))
        workspace = self.workspace_name or "workspace"
        tag_root = f"{workspace}-{bp_name}-{auto_name}"

        image_checksum = await calculate_git_tree_hash([image_dir])
        full_tag = f"internal/{tag_root}:sha{image_checksum}"

        image_service = ImageService()
        existing_status = image_service._get_build_status(image_checksum)
        images = await image_service.get_images()
        already_built = any(
            im.get("tag") == full_tag and im.get("build_status") in (None, "ready")
            for im in images
        )

        if not already_built and existing_status != "building":
            logger.info(f"Building automation image {full_tag} from {image_dir}")
            await image_service.create_image(
                tag_root,
                build_context_path=image_dir,
                checksum=image_checksum,
            )

        if not already_built:
            # Poll until the build finishes (or fails). The 5-minute deadline
            # bounds a stuck build. On every tick we surface the latest build
            # log line as progress — a docker build of a real image takes
            # minutes, and without this the deploy task message would stay on
            # "Preparing …" the whole time and the dashboard toast would go dark
            # (no on-screen progress for >15s). Reporting the build-step tail
            # every ~2s keeps the operator informed without changing what the
            # build itself does.
            deadline = asyncio.get_event_loop().time() + 5 * 60
            last_reported = None
            while True:
                status = image_service._get_build_status(image_checksum)
                if status == "ready":
                    break
                if status == "failed":
                    raise HTTPException(
                        status_code=500,
                        detail=f"Image build failed for {full_tag}",
                    )
                if asyncio.get_event_loop().time() >= deadline:
                    raise HTTPException(
                        status_code=504,
                        detail=f"Image build timed out for {full_tag}",
                    )
                if progress_callback is not None:
                    tail = image_service.build_log_tail(image_checksum)
                    msg = (
                        f"Building image for {auto_name}: {tail}"
                        if tail
                        else f"Building image for {auto_name}…"
                    )
                    if msg != last_reported:
                        last_reported = msg
                        try:
                            await progress_callback("building_images", msg, None)
                        except Exception:
                            # Progress is best-effort telemetry — never let a
                            # reporting hiccup abort a real build.
                            logger.debug("build progress report failed", exc_info=True)
                await asyncio.sleep(2)

        # Write the resolved tag into automation.toml so the rest of the
        # deploy pipeline sees the up-to-date image.
        update_automation_toml_image(
            os.path.join(source_dir, "automation.toml"), full_tag
        )
        return full_tag

    async def _bake_source_image(
        self,
        source_dir: str,
        dirs_to_merge: list[str],
        base_image: str,
        mount_path: str,
        source_sha: str,
    ) -> tuple[str, str | None]:
        """Bake the merged source tree into a docker image as a final COPY layer.

        Builds `internal/<ws>-<bp>-<auto>-app:sha<source_sha>` =
        ``FROM <base_image>`` + ``COPY . <mount_path>``. Content-addressed by
        `source_sha` (the merged-tree git hash) so an unchanged source reuses the
        cached image — no rebuild. Replaces the old materialize-and-mount path for
        promoted stages: the source now lives INSIDE the image. Returns
        (full_tag, image_id)."""
        import docker

        auto_name = sanitize_automation_name(
            os.path.basename(source_dir.rstrip(os.sep))
        )
        parent = os.path.dirname(source_dir.rstrip(os.sep))
        bp_name = sanitize_automation_name(os.path.basename(parent))
        ws = self.workspace_name or "workspace"
        tag_root = f"internal/{ws}-{bp_name}-{auto_name}-app"
        full_tag = f"{tag_root}:sha{source_sha}"
        mp = mount_path or "/app"

        def _build_sync() -> str | None:
            client = docker.from_env()
            # Dedup: an image for this exact source already exists — reuse it.
            try:
                return client.images.get(full_tag).id
            except docker.errors.ImageNotFound:
                pass
            ctx = tempfile.mkdtemp(prefix=".bswn-bake-")
            try:
                # Merge the source dirs (later-wins). symlinks=True PRESERVES
                # symlinks (e.g. go.mod → /deps/go.mod, an absolute path the
                # runtime base provides) — `COPY . <mp>` keeps them as symlinks
                # in the image, resolving at runtime. Following them here would
                # fail (the target only exists inside the running container).
                for d in dirs_to_merge:
                    if os.path.isdir(d):
                        shutil.copytree(d, ctx, dirs_exist_ok=True, symlinks=True)
                with open(os.path.join(ctx, ".dockerignore"), "w") as f:
                    f.write("image/\nDockerfile\n.dockerignore\n")
                with open(os.path.join(ctx, "Dockerfile"), "w") as f:
                    f.write(f"FROM {base_image}\nCOPY . {mp}\n")
                image, _logs = client.images.build(
                    path=ctx, tag=full_tag, rm=True, pull=False
                )
                client.images.get(full_tag).tag(tag_root, "latest")
                return image.id
            finally:
                shutil.rmtree(ctx, ignore_errors=True)

        try:
            image_id = await asyncio.to_thread(_build_sync)
        except docker.errors.BuildError as e:
            raise HTTPException(
                status_code=500,
                detail=f"Source image build failed for {full_tag}: {e}",
            )
        return full_tag, image_id

    async def _source_commit(self, source_dir: str) -> str | None:
        """Git commit of the source tree being deployed (the copy/main HEAD), so a
        baked image maps back to exact source."""
        out, _, rc = await call_git_command_with_output(
            "git", "rev-parse", "HEAD", cwd=source_dir
        )
        return out.strip() if rc == 0 else None

    @staticmethod
    def deployment_id_for(source: dict, stage: str) -> str:
        """Resolve the deployment_id for a scanned source at a given stage.

        The scanner's `deployment_id` always ends with `-live-dev`; for the
        `dev` stage rewrite the suffix to the canonical id format
        (sanitized-{bp_prefix}{stage}).
        """
        if stage == "dev":
            return source["deployment_id"].removesuffix("-live-dev") + "-dev"
        return source["deployment_id"]

    async def prep_deploy_source(
        self,
        relative_path: str,
        stage: str,
        copy: str | None = None,
        progress_callback: Callable[..., Any] | None = None,
    ) -> dict:
        """Build + materialize one automation source, ready for deployment.

        Pure prep — NO deploy task, NO bitswan.yaml write, NO compose-up:
          * discover the source via `scan_workspace_sources` (so the
            deployment_id format stays canonical),
          * build the per-automation runtime image if it ships an
            `image/Dockerfile` (`_ensure_automation_image`),
          * compute the merged-tree checksum (with `bitswan_lib`) and
            materialize `<gitops_dir>/<checksum>/` (skipped for live-dev).

        Returns: {deployment_id, checksum, stage, relative_path,
                  automation_name, context, source}.
        Raises HTTPException on bad stage / missing source / image-build or
        materialize failure. Used by both `start_deploy_from_workspace` (single)
        and `deploy_business_process` (BP).
        """
        if stage not in {"dev", "live-dev"}:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported stage '{stage}' (allowed: dev, live-dev)",
            )

        # For dev stage we scan from the main workspace (no copy); for
        # live-dev we honour `copy`.
        scan_copy = copy if stage == "live-dev" else None
        sources = scan_workspace_sources(self.workspace_repo_dir, copy=scan_copy)
        source = next((s for s in sources if s["relative_path"] == relative_path), None)
        if not source:
            ctx = f" in copy '{copy}'" if copy else ""
            raise HTTPException(
                status_code=404,
                detail=f"No automation source at '{relative_path}'{ctx}",
            )

        deployment_id = self.deployment_id_for(source, stage)

        # Resolve source dir + optional bitswan_lib for the merge.
        source_dir = os.path.realpath(
            os.path.join(self.workspace_repo_dir, relative_path)
        )
        ws_root_real = os.path.realpath(self.workspace_repo_dir)
        if not (
            source_dir == ws_root_real or source_dir.startswith(ws_root_real + os.sep)
        ):
            raise HTTPException(status_code=400, detail="Source escapes workspace")
        bitswan_lib_dir = os.path.join(self.workspace_repo_dir, "bitswan_lib")
        dirs_to_merge = [source_dir]
        if os.path.isdir(bitswan_lib_dir):
            dirs_to_merge.append(bitswan_lib_dir)

        # Build the per-automation runtime image if the source ships a
        # Dockerfile under `image/`. This MUST run before the
        # checksum/materialize step: it writes the resolved image tag into the
        # source `automation.toml`, and the dev-stage deploy reads the
        # automation config from the materialized `<checksum>/` tree. Building
        # afterwards would materialize a stale config and silently fall back to
        # the default runtime image.
        try:
            base_tag = await self._ensure_automation_image(
                source_dir, progress_callback=progress_callback
            )
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Image build failed: {exc}",
            )

        # live-dev keeps the bind-mount of the live workspace tree (instant edit
        # loop). Promoted stages (dev/staging/production) BAKE the source into
        # the image so a deployment is a single immutable artifact identified by
        # its image id + source git commit — no mounted blob tree.
        if stage == "live-dev":
            checksum = "live-dev"
            image = None
            image_id = None
            source_commit = None
        else:
            auto_conf = read_automation_config(source_dir)
            base_image = base_tag or auto_conf.image
            checksum = await calculate_git_tree_hash(dirs_to_merge)
            image, image_id = await self._bake_source_image(
                source_dir, dirs_to_merge, base_image, auto_conf.mount_path, checksum
            )
            source_commit = await self._source_commit(source_dir)
            # First build of this image → SBOM (syft) + CVE scan (grype) in the
            # background; the daily job refreshes CVEs later. Never blocks deploy.
            if image and image_id:
                supply_chain_service.spawn_scan(image, image_id)

        return {
            "deployment_id": deployment_id,
            "checksum": checksum,
            "image": image,
            "image_id": image_id,
            "source_commit": source_commit,
            "stage": stage,
            "relative_path": source["relative_path"],
            "automation_name": source["automation_name"],
            "context": source["context"],
            "source": source,
        }

    async def start_deploy_from_workspace(
        self,
        relative_path: str,
        stage: str,
        copy: str | None = None,
    ) -> dict:
        """Deploy a single automation directly from the bind-mounted workspace.

        Thin wrapper over `prep_deploy_source` that additionally reserves the
        deploy task. Discovers the source, merges `bitswan_lib`, materializes
        the merged tree under `<gitops_dir>/<checksum>/`, and returns the
        kwargs the deploy pipeline (`deploy_automation`) consumes.

        `stage="live-dev"` skips materialization and uses the literal
        "live-dev" checksum, matching the existing `start-live-dev` endpoint.
        """
        prep = await self.prep_deploy_source(relative_path, stage, copy)
        deployment_id = prep["deployment_id"]

        task = await deploy_manager.create_task(deployment_id)
        if task is None:
            raise HTTPException(
                status_code=409,
                detail=f"Deployment {deployment_id} is already in progress",
            )

        deploy_kwargs = dict(
            deployment_id=deployment_id,
            checksum=prep["checksum"],
            stage=stage,
            relative_path=prep["relative_path"],
            automation_name=prep["automation_name"],
            context=prep["context"],
        )

        return {
            "deployment_id": deployment_id,
            "task_id": task.task_id,
            "checksum": prep["checksum"],
            "deploy_kwargs": deploy_kwargs,
            "source": prep["source"],
        }

    def members_for_bp(
        self, bp: str, copy: str | None = None, stage: str = "dev"
    ) -> list[dict]:
        """Scan for every automation source under one business process.

        BP membership = automations whose first path segment (after stripping
        the `copies/<copy>/` prefix) matches `bp`. Comparison is done through
        `sanitize_automation_name` on both sides so a raw directory name and
        its sanitized form both match. Returns the scanner dicts (same shape
        as `scan_workspace_sources`).
        """
        scan_copy = copy if stage == "live-dev" else None
        sources = scan_workspace_sources(self.workspace_repo_dir, copy=scan_copy)
        bp_key = sanitize_automation_name(bp)
        out: list[dict] = []
        for s in sources:
            parts = (s.get("relative_path") or "").replace("\\", "/").split("/")
            if len(parts) >= 2 and parts[0] == "copies":
                parts = parts[2:]  # drop "copies/<copy>" (incl. the main copy)
            if parts and sanitize_automation_name(parts[0]) == bp_key:
                out.append(s)
        return out

    async def write_deployment_entries(
        self,
        members: list[dict],
        deployed_by: str | None = None,
        commit_subject: str | None = None,
        report: Callable[..., Any] | None = None,
    ) -> dict:
        """Upsert several deployment entries into bitswan.yaml in ONE write +
        ONE git commit, then auto-enable their declared infra services.

        Each member dict carries: deployment_id, checksum, stage,
        relative_path, automation_name, context (+ optional services/replicas).
        Mirrors the per-field mapping `deploy_automation` does, but batched.
        Returns the re-read bs_yaml.
        """

        async def _report(step: str, message: str):
            if report is not None:
                await report(step, message)

        bs_yaml = read_bitswan_yaml(self.gitops_dir) or {"deployments": {}}

        # First-deploy gating for per-BP databases: must look at bitswan.yaml
        # BEFORE these members are written into it (a BP that already has
        # deployments at the target realm keeps its data on the shared DB and
        # is never auto-migrated).
        from app.services.bp_databases import register_new_bps_for_members

        register_new_bps_for_members(bs_yaml, members)

        deployments = bs_yaml.setdefault("deployments", {})

        for m in members:
            deployment_id = m["deployment_id"]

            # Clean up old-format copy entries for the same automation
            # (same logic as deploy_automation's per-deployment cleanup).
            if (
                "-copy-" in deployment_id
                and m.get("stage") == "live-dev"
                and m.get("relative_path")
            ):
                stale = [
                    k
                    for k, v in deployments.items()
                    if k != deployment_id
                    and "-copy-" in k
                    and k.endswith("-live-dev")
                    and (v or {}).get("relative_path") == m["relative_path"]
                ]
                for k in stale:
                    del deployments[k]

            dep = deployments.setdefault(deployment_id, {})
            if m.get("checksum") is not None:
                dep["checksum"] = m["checksum"]
            if m.get("stage") is not None:
                # Map production to empty string (canonical persisted form).
                dep["stage"] = "" if m["stage"] == "production" else m["stage"]
            if m.get("automation_name") is not None:
                dep["automation_name"] = m["automation_name"]
            if m.get("context") is not None:
                dep["context"] = m["context"]
            if m.get("relative_path") is not None:
                dep["relative_path"] = m["relative_path"]
            if m.get("services") is not None:
                dep["services"] = m["services"]
            if m.get("replicas") is not None:
                dep["replicas"] = m["replicas"]
            # Image-baked deploys: the source lives inside the image. Record the
            # baked image ref, its resolved id, and the source git commit so a
            # deployment maps back to exact source (and promote/rollback reuse it).
            if m.get("image") is not None:
                dep["image"] = m["image"]
            if m.get("image_id") is not None:
                dep["image_id"] = m["image_id"]
            if m.get("source_commit") is not None:
                dep["source_commit"] = m["source_commit"]
            if "active" not in dep:
                dep["active"] = True

        # Remove stale live-dev entries that lack relative_path.
        stale_live_devs = [
            k
            for k, v in deployments.items()
            if (v or {}).get("stage") == "live-dev"
            and not (v or {}).get("relative_path")
        ]
        for k in stale_live_devs:
            logger.warning("Removing stale live-dev entry: %s", k)
            del deployments[k]

        bitswan_yaml_path = os.path.join(self.gitops_dir, "bitswan.yaml")
        with open(bitswan_yaml_path, "w") as f:
            dump_bitswan_yaml(bs_yaml, f)

        await update_git(
            self.gitops_dir,
            self.gitops_dir_host,
            members[0]["deployment_id"] if members else "all",
            "deploy",
            deployed_by=deployed_by,
            message=commit_subject,
        )

        bs_yaml = read_bitswan_yaml(self.gitops_dir)

        # Auto-enable the union of declared services, grouped by stage.
        by_stage: dict[str, dict] = {}
        for m in members:
            dep_conf = bs_yaml.get("deployments", {}).get(m["deployment_id"], {}) or {}
            deploy_services = m.get("services") or dep_conf.get("services")
            deploy_stage = m.get("stage") or dep_conf.get("stage") or "production"
            if deploy_stage == "":
                deploy_stage = "production"
            if not deploy_services:
                auto_conf = self.resolve_automation_config(dep_conf)
                if auto_conf.services:
                    deploy_services = {
                        svc_name: {"enabled": svc_dep.enabled}
                        for svc_name, svc_dep in auto_conf.services.items()
                    }
            if deploy_services:
                by_stage.setdefault(deploy_stage, {}).update(deploy_services)

        if by_stage:
            await _report("enabling_services", "Enabling declared services...")
            for svc_stage, services in by_stage.items():
                await self.enable_services(services, svc_stage)

        return bs_yaml

    async def write_bp_deploy(
        self,
        bp: str,
        stage: str,
        git_commit: str | None,
        members: list[dict],
        deployed_by: str | None,
        source: str,
        status: str = "deployed",
    ) -> None:
        """Stamp the BP stage's shared source git commit onto the tree and commit
        — that git commit IS the deployment-history record (see `bp_history`).
        No history list is kept in bitswan.yaml; git is the source of truth. The
        commit subject (`<source> <bp> → <stage>`) lets history infer the kind
        (deploy / promote / rollback)."""
        stage_key = "production" if stage in ("", "production") else stage
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        tree = bs.setdefault("business_processes", {})
        node = tree.setdefault(bp, {}).setdefault(stage_key, {})
        node["git_commit"] = git_commit
        bitswan_yaml_path = os.path.join(self.gitops_dir, "bitswan.yaml")
        with open(bitswan_yaml_path, "w") as f:
            dump_bitswan_yaml(bs, f)
        await update_git(
            self.gitops_dir,
            self.gitops_dir_host,
            bp,
            "deploy",
            deployed_by=deployed_by,
            message=f"{source} {bp} → {stage_key} @ {(git_commit or '')[:8]}",
        )

    async def bp_history(self, bp: str, stage: str, limit: int = 200) -> dict:
        """Deployment + firewall history for one BP stage, derived from the GIT
        LOG of bitswan.yaml (no history is stored in the file). Two interleaved
        timelines share the audit log:

        * deploy events — each distinct state of business_processes[bp][stage].
        * firewall events — each distinct state of firewall[bp][realm].rules.

        Both are detected by comparing the *parsed state* across commits (never
        by parsing the commit subject), so a firewall approve/deny/promote/revoke
        shows up here and is a rollback point too. Newest-first; `current` = the
        newest *deploy* entry's commit (the live version — firewall events never
        change which version is live)."""
        stage_key = "production" if stage in ("", "production") else stage
        realm = bp_secrets.realm_for_stage(stage_key)
        out, _, rc = await call_git_command_with_output(
            "git",
            "log",
            f"-{limit}",
            "--reverse",
            "--format=%H%x1f%aI%x1f%ae%x1f%s",
            "--",
            "bitswan.yaml",
            cwd=self.gitops_dir,
        )
        entries: list[dict] = []
        prev_dep_key = None
        prev_fw_key: tuple | None = None
        prev_bk_key: str | None = None
        for line in (out or "").splitlines():
            parts = line.split("\x1f")
            if len(parts) != 4:
                continue
            sha, date, author, subject = parts
            # Memoized git-show + parse, shared across stages and repeat loads
            # (a commit's bitswan.yaml is immutable). This is the hot path —
            # see _parse_revision_bitswan.
            bps = _parse_revision_business_processes(self.gitops_dir, sha)
            node = (bps.get(bp, {}) or {}).get(stage_key) or {}
            src = node.get("git_commit")
            members = {
                k: {
                    "image": (v or {}).get("image"),
                    "image_id": (v or {}).get("image_id"),
                }
                for k, v in (node.get("deployments") or {}).items()
            }
            # ── deploy event: a changed (source, member-images) tuple ──────────
            dep_key = (
                src,
                tuple(sorted((k, m["image_id"]) for k, m in members.items())),
            )
            if src and dep_key != prev_dep_key:
                low = subject.lower()
                if "rollback" in low:
                    status, source = "rolled-back", "rollback"
                elif "promote" in low:
                    status = "deployed"
                    source = "staging" if stage_key == "production" else "dev"
                else:
                    status, source = "deployed", "deploy"
                entries.append(
                    {
                        "commit": sha,  # the deploy-event id (rollback key)
                        "source_commit": src,  # the deployed source version
                        "deployed_at": date,
                        "deployed_by": author,
                        "status": status,
                        "source": source,
                        "members": members,
                    }
                )
            emitted_deploy = src and dep_key != prev_dep_key
            if src:
                prev_dep_key = dep_key

            # ── firewall event: a changed rule set for this realm ──────────────
            fw_node = _parse_revision_firewall_realm(self.gitops_dir, sha, bp, realm)
            fw_rules = fw_node.get("rules") or {}
            fw_key = tuple(
                sorted((h, (r or {}).get("status")) for h, r in fw_rules.items())
            )
            # Emit when the rule set actually changed and there is (or was)
            # something to show — skips the long pre-firewall prefix of history.
            # `not emitted_deploy` keeps one entry per commit (deploy and firewall
            # changes always land in separate commits, but guard anyway).
            if fw_key != prev_fw_key and (fw_key or prev_fw_key) and not emitted_deploy:
                entries.append(
                    {
                        "commit": sha,
                        "source_commit": None,
                        "deployed_at": date,
                        "deployed_by": author,
                        "status": "firewall",
                        "source": "firewall",
                        "members": {},
                        "firewall": {
                            "realm": realm,
                            "summary": subject,
                            "allowed": sum(
                                1
                                for r in fw_rules.values()
                                if (r or {}).get("status") == "allowed"
                            ),
                            "denied": sum(
                                1
                                for r in fw_rules.values()
                                if (r or {}).get("status") == "denied"
                            ),
                        },
                    }
                )
            prev_fw_key = fw_key

            # ── backup event: a new backup-domain action for this BP ───────────
            # created/restored/swapped/retention, detected by the newest audit
            # log entry's id changing. Production-domain actions (restore-to-DR,
            # swap, retention) surface on the production timeline; a `created`
            # snapshot surfaces on the stage it captured. Older entries with no
            # stage default to production (where the blue-green/DR UI lives).
            bk_node = _parse_revision_backups(self.gitops_dir, sha, bp)
            bk_log = bk_node.get("log") or []
            bk_top = bk_log[0] if bk_log else None
            bk_key = (bk_top or {}).get("id")
            if (
                bk_top
                and bk_key != prev_bk_key
                and not emitted_deploy
                and (bk_top.get("stage") or "production") == stage_key
            ):
                entries.append(
                    {
                        "commit": sha,
                        "source_commit": None,
                        "deployed_at": date,
                        "deployed_by": author,
                        "status": "backup",
                        "source": "backup",
                        "members": {},
                        "backup": {
                            "action": bk_top.get("action"),
                            "detail": bk_top.get("detail"),
                            "summary": subject,
                        },
                    }
                )
            prev_bk_key = bk_key
        entries.reverse()  # newest-first
        current = next(
            (e["commit"] for e in entries if e["source"] not in ("firewall", "backup")),
            None,
        )
        return {
            "bp": bp,
            "stage": stage_key,
            "current": current,
            "history": entries,
        }

    async def rollback_business_process(
        self,
        bp: str,
        stage: str,
        git_commit: str,
        deployed_by: str | None = None,
        progress_callback: Callable[..., Any] | None = None,
    ) -> dict:
        """Roll a BP stage back to a prior deployment. `git_commit` is the history
        entry's id — the bitswan.yaml commit sha. We read that revision, re-point
        ALL the BP's member deployments to the images it recorded (as a group),
        and redeploy. The redeploy's own git commit becomes the new history
        entry (subject "rollback …")."""
        stage_key = "production" if stage in ("", "production") else stage
        content, _, rc = await call_git_command_with_output(
            "git", "show", f"{git_commit}:bitswan.yaml", cwd=self.gitops_dir
        )
        if rc != 0:
            raise HTTPException(
                status_code=404, detail=f"No such revision {git_commit[:8]}"
            )
        try:
            y = yaml.safe_load(content) or {}
        except Exception:
            raise HTTPException(status_code=500, detail="Could not parse that revision")
        node = ((y.get("business_processes") or {}).get(bp, {}) or {}).get(stage_key)
        target = (node or {}).get("deployments") or {}
        if not target:
            raise HTTPException(
                status_code=404,
                detail=f"No deployment for {bp}/{stage_key} at {git_commit[:8]}",
            )
        target_src = (node or {}).get("git_commit")

        # Re-point the (flat, hydrated) deployment entries to the historical
        # images; dump regroups them into the tree.
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        deployments = bs.setdefault("deployments", {})
        for dep_id, mi in target.items():
            dep = deployments.get(dep_id)
            if dep is None:
                continue
            dep["image"] = (mi or {}).get("image")
            dep["image_id"] = (mi or {}).get("image_id")
            dep["source_commit"] = target_src
        tree = bs.setdefault("business_processes", {})
        tree.setdefault(bp, {}).setdefault(stage_key, {})["git_commit"] = target_src
        path = os.path.join(self.gitops_dir, "bitswan.yaml")
        with open(path, "w") as f:
            dump_bitswan_yaml(bs, f)
        await update_git(
            self.gitops_dir,
            self.gitops_dir_host,
            bp,
            "deploy",
            deployed_by=deployed_by,
            message=f"rollback {bp} → {stage_key} @ {(target_src or '')[:8]}",
        )
        deployment_ids = list(target.keys())
        result = await self.apply_compose_for_deployments(
            deployment_ids, deployed_by=deployed_by, report=progress_callback
        )
        return {
            "message": "Rolled back",
            "bp": bp,
            "stage": stage_key,
            "git_commit": target_src,
            "deployment_ids": deployment_ids,
            "result": result,
        }

    async def bp_diff(self, bp: str, from_sha: str, to_sha: str) -> dict:
        """Unified diff of a BP's source between two commits (the history view's
        "diff vs current"). Scoped to the BP's directory, computed in copies/main
        where the canonical source lives."""
        main = os.path.join(os.environ.get("BITSWAN_COPIES_DIR", "/copies"), "main")
        out, _, rc = await call_git_command_with_output(
            "git",
            "diff",
            "--no-color",
            f"{from_sha}..{to_sha}",
            "--",
            f"{bp}/",
            cwd=main,
        )
        return {"diff": out if rc == 0 else "", "from": from_sha, "to": to_sha}

    def _bp_stage_members(self, bp: str, stage: str) -> dict:
        """The {deployment_id: {image, image_id}} map for a BP at a stage."""
        return self._bp_stage_node(bp, stage).get("deployments") or {}

    def _bp_stage_node(self, bp: str, stage: str) -> dict:
        """The business_processes[bp][stage] node ({git_commit, deployments})."""
        stage_key = "production" if stage in ("", "production") else stage
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        return ((bs.get("business_processes") or {}).get(bp, {}) or {}).get(
            stage_key
        ) or {}

    def bp_stage_commit(self, bp: str, stage: str) -> str | None:
        """The git commit a BP's stage is currently deployed at, or None when
        the stage has never been deployed."""
        return self._bp_stage_node(bp, stage).get("git_commit")

    def read_bp_secrets(self, bp: str) -> dict:
        """Decrypted per-stage secrets for a BP: {dev, staging, production} each
        a {KEY: value} map. Each stage is independent (dev covers live-dev)."""
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        enc = (bs.get("secrets") or {}).get(bp) or {}
        out: dict[str, dict] = {}
        for realm in bp_secrets.REALMS:
            blob = enc.get(realm)
            out[realm] = (
                bp_secrets.decrypt_secrets(self.secrets_dir, blob) if blob else {}
            )
        return out

    async def write_bp_secrets(
        self,
        bp: str,
        values_by_realm: dict,
        deployed_by: str | None = None,
    ) -> dict:
        """Encrypt + version a BP's secrets in bitswan.yaml as ONE commit.

        Secret *names* are shared across stages; *values* are per stage, so the
        caller sends every realm's {KEY: value} map and we persist them together
        — one rollback point captures the whole secret state. Each realm gets its
        own AES blob (per-stage storage), and we re-derive each realm's plaintext
        env file. Values apply on the next deploy of that stage."""
        cleaned = {
            realm: bp_secrets.normalise_values(values_by_realm.get(realm) or {})
            for realm in bp_secrets.REALMS
        }
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        enc = bs.setdefault("secrets", {}).setdefault(bp, {})
        for realm, clean in cleaned.items():
            enc[realm] = bp_secrets.encrypt_secrets(self.secrets_dir, clean)
        path = os.path.join(self.gitops_dir, "bitswan.yaml")
        with open(path, "w") as f:
            dump_bitswan_yaml(bs, f)
        await update_git(
            self.gitops_dir,
            self.gitops_dir_host,
            bp,
            "secrets",
            deployed_by=deployed_by,
            message=f"secrets {bp}",
        )
        for realm, clean in cleaned.items():
            bp_secrets.materialize_env(self.secrets_dir, bp, realm, clean)
        return self.read_bp_secrets(bp)

    # -- disaster-recovery test log ---------------------------------------------
    # A per-BP, hand-kept log of manual recovery tests (someone restored a
    # snapshot and verified the data by hand). Persisted in bitswan.yaml under
    # the top-level `disaster_recovery` key, versioned in git like secrets.

    # Recovery-test cadence policies → window in days. A BP is "overdue" when
    # the last manual test is older than its policy window (or there is none).
    DR_POLICY_WINDOW_DAYS = {
        "monthly": 30,
        "quarterly": 91,
        "semi-annually": 182,
        "annually": 365,
    }
    DR_DEFAULT_POLICY = "quarterly"

    def read_dr(self, bp: str) -> dict:
        """A BP's disaster-recovery status: its test cadence policy, the manual
        recovery-test log (newest-first), and a derived overdue flag.

        `days_since` is the age in days of the newest test (None when there are
        no tests); `overdue` is True when that age exceeds the policy window —
        or when no test has ever been recorded."""
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        record = (bs.get("disaster_recovery") or {}).get(bp) or {}
        policy = record.get("policy") or self.DR_DEFAULT_POLICY
        window_days = self.DR_POLICY_WINDOW_DAYS.get(
            policy, self.DR_POLICY_WINDOW_DAYS[self.DR_DEFAULT_POLICY]
        )
        # Tests are stored newest-first (record_dr_test prepends).
        tests = list(record.get("tests") or [])

        days_since: int | None = None
        last: dict | None = None
        if tests:
            newest = tests[0]
            last = {
                "by": newest.get("by"),
                "at": newest.get("at"),
                "date": newest.get("date"),
            }
            try:
                test_date = date.fromisoformat(newest["date"])
                days_since = (date.today() - test_date).days
            except (KeyError, ValueError, TypeError):
                days_since = None

        overdue = days_since is None or days_since > window_days
        # The Production backup currently restored into the DR standby db (set
        # by record_dr_restore). Only this backup can be recovery-tested — you
        # can only verify what is actually loaded into DR right now.
        restored = record.get("restored") or None
        return {
            "policy": policy,
            "window_days": window_days,
            "tests": tests,
            "last": last,
            "days_since": days_since,
            "overdue": overdue,
            "restored": restored,
        }

    async def record_dr_restore(
        self, bp: str, snapshot: str, by: str | None, deployed_by: str | None = None
    ) -> dict:
        """Record which Production backup is currently restored into the DR
        standby db. This is what gates recovery-testing: only the restored
        backup may be marked recovery-tested. Versioned in bitswan.yaml."""
        today = date.today()
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        record = bs.setdefault("disaster_recovery", {}).setdefault(bp, {})
        record["restored"] = {
            "snapshot": snapshot,
            "by": by or "unknown",
            "at": today.strftime("%b %-d, %Y"),
            "date": today.isoformat(),
        }
        path = os.path.join(self.gitops_dir, "bitswan.yaml")
        with open(path, "w") as f:
            dump_bitswan_yaml(bs, f)
        await update_git(
            self.gitops_dir,
            self.gitops_dir_host,
            bp,
            "dr",
            # Attribute to the operator: prefer an explicit deployer, else the
            # `by` actor that triggered the restore (so the commit isn't gitops).
            deployed_by=deployed_by or by,
            message=f"dr restore {bp} → {snapshot}",
        )
        return self.read_dr(bp)

    async def write_dr_policy(
        self, bp: str, policy: str, deployed_by: str | None = None
    ) -> dict:
        """Set a BP's recovery-test cadence policy, versioned in bitswan.yaml as
        one commit. Returns the updated DR status."""
        if policy not in self.DR_POLICY_WINDOW_DAYS:
            raise ValueError(
                f"Invalid DR policy '{policy}': must be one of "
                f"{sorted(self.DR_POLICY_WINDOW_DAYS)}"
            )
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        record = bs.setdefault("disaster_recovery", {}).setdefault(bp, {})
        record["policy"] = policy
        path = os.path.join(self.gitops_dir, "bitswan.yaml")
        with open(path, "w") as f:
            dump_bitswan_yaml(bs, f)
        await update_git(
            self.gitops_dir,
            self.gitops_dir_host,
            bp,
            "dr",
            deployed_by=deployed_by,
            message=f"dr policy {bp} → {policy}",
        )
        return self.read_dr(bp)

    async def record_dr_test(
        self,
        bp: str,
        by: str | None,
        note: str | None,
        snapshot: str | None,
        deployed_by: str | None = None,
    ) -> dict:
        """Record a hand-performed recovery test for a BP, versioned in
        bitswan.yaml as one commit. Prepended so the log is newest-first.
        Returns the updated DR status.

        A test may only be recorded against the backup that is *currently
        restored* into the DR standby db — you can only verify what is actually
        loaded into DR right now. Raises ValueError otherwise."""
        bs_pre = read_bitswan_yaml(self.gitops_dir) or {}
        restored = ((bs_pre.get("disaster_recovery") or {}).get(bp) or {}).get(
            "restored"
        ) or {}
        restored_snap = restored.get("snapshot")
        if not restored_snap:
            raise ValueError(
                "No backup is restored into Disaster Recovery yet. Restore a "
                "Production backup into DR, verify the data, then mark it "
                "recovery-tested."
            )
        if snapshot and snapshot != restored_snap:
            raise ValueError(
                "Only the backup currently restored into Disaster Recovery "
                f"({restored_snap}) can be marked recovery-tested. Restore "
                "this backup into DR first."
            )
        snapshot = snapshot or restored_snap
        today = date.today()
        note_text = (f'Tested against "{snapshot}". ' if snapshot else "") + (
            note or "Recovery procedure performed and data verified by hand."
        )
        test = {
            "id": f"dr{uuid.uuid4().hex}",
            "by": by or "unknown",
            "at": today.strftime("%b %-d, %Y"),
            "date": today.isoformat(),
            # The specific backup that was recovery-tested, so the Backups list
            # can mark it tested. None when a test is recorded without one.
            "snapshot": snapshot,
            "note": note_text,
            "verified": True,
        }
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        record = bs.setdefault("disaster_recovery", {}).setdefault(bp, {})
        record.setdefault("tests", []).insert(0, test)
        path = os.path.join(self.gitops_dir, "bitswan.yaml")
        with open(path, "w") as f:
            dump_bitswan_yaml(bs, f)
        await update_git(
            self.gitops_dir,
            self.gitops_dir_host,
            bp,
            "dr",
            deployed_by=deployed_by,
            message=f"dr recovery test {bp}",
        )
        return self.read_dr(bp)

    # ── Backups: blue-green production (3 app slots over 2 DBs) + audit ───────
    # A production BP has TWO persistent logical databases (db 1 and db 2) and
    # up to THREE app-container slots (a/b/c). Two pointers drive everything:
    #   • live_db   (1|2)   — which DB is Production; the other is the DR standby.
    #   • live_slot (a|b|c) — which app slot the production ingress serves.
    # `slots` records each ACTIVE app slot's DB wiring ({a: {db: 1}, ...}); a
    # slot absent from `slots` is idle (no containers). Steady state runs two
    # slots — the live one (wired to live_db) and the DR one (wired to the
    # standby db) — leaving one idle as the zero-downtime-promote buffer.
    #
    # Two operations, one ingress-repoint primitive:
    #   • DR swap     — flip live_db, repoint ingress to the slot on that DB.
    #                   DR ↔ Production trade places; no data moved.
    #   • Zero-downtime promote — bring the idle slot up with the new image
    #                   wired to the CURRENT live_db, repoint ingress to it,
    #                   retire the old live slot (→ idle). The DB never moves.
    # Restores only ever write the STANDBY db (never live). State + a bounded
    # audit log live in bitswan.yaml under `backups` (versioned like
    # secrets/firewall/dr); the git log is the full audit trail.
    BACKUP_DEFAULT_RETENTION = {"daily": 7, "weekly": 0, "monthly": 3}
    APP_SLOTS = ("a", "b", "c")

    @staticmethod
    def _other_db(db: int) -> int:
        return 2 if db == 1 else 1

    def read_backups(self, bp: str) -> dict:
        """A BP's blue-green state: the live vs standby DB, which app slot is
        live, the DR slot (active slot wired to the standby db), the idle
        slots, the full slot→db wiring, retention policy, and audit log."""
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        rec = (bs.get("backups") or {}).get(bp) or {}
        live_db = int(rec.get("live_db") or 1)
        standby_db = self._other_db(live_db)
        # Default fresh wiring: slot a is live on db1, slot b is DR on db2,
        # slot c idle (the promote buffer).
        slots = rec.get("slots") or {"a": {"db": 1}, "b": {"db": 2}}
        live_slot = rec.get("live_slot") or next(
            (s for s, m in slots.items() if (m or {}).get("db") == live_db), "a"
        )
        dr_slot = next(
            (
                s
                for s, m in slots.items()
                if (m or {}).get("db") == standby_db and s != live_slot
            ),
            None,
        )
        idle_slots = [s for s in self.APP_SLOTS if s not in slots]
        return {
            "bp": bp,
            "live_db": live_db,
            "standby_db": standby_db,
            "live_slot": live_slot,
            "dr_slot": dr_slot,
            "idle_slots": idle_slots,
            "slots": {s: dict(m or {}) for s, m in slots.items()},
            "retention": {
                **self.BACKUP_DEFAULT_RETENTION,
                **(rec.get("retention") or {}),
            },
            "log": list(rec.get("log") or []),
        }

    def live_slot(self, bp: str) -> str:
        return self.read_backups(bp)["live_slot"]

    def live_db(self, bp: str) -> int:
        return self.read_backups(bp)["live_db"]

    def standby_db(self, bp: str) -> int:
        return self.read_backups(bp)["standby_db"]

    def slot_db(self, bp: str, slot: str) -> int | None:
        """Which DB (1|2) an app slot is wired to, or None if the slot is idle."""
        m = self.read_backups(bp)["slots"].get(slot)
        return int(m["db"]) if m and m.get("db") else None

    def _append_backup_log(
        self,
        rec: dict,
        action: str,
        detail: str,
        by: str | None,
        stage: str | None = None,
    ) -> None:
        today = date.today()
        rec.setdefault("log", []).insert(
            0,
            {
                "id": uuid.uuid4().hex,
                "action": action,  # created | restored | swapped | retention
                "detail": detail,
                "by": by or "unknown",
                # Which stage's deployment-history timeline this event belongs
                # to. Production-domain actions (restore-to-DR, swap, retention)
                # are "production"; a `created` snapshot carries its own stage.
                "stage": stage or "production",
                "at": today.strftime("%b %-d, %Y"),
                "date": today.isoformat(),
            },
        )
        del rec["log"][50:]  # bounded; git history is the full audit trail

    async def _save_and_commit_backups(
        self, bs: dict, bp: str, by: str | None, message: str
    ) -> None:
        path = os.path.join(self.gitops_dir, "bitswan.yaml")
        with open(path, "w") as f:
            dump_bitswan_yaml(bs, f)
        await update_git(
            self.gitops_dir,
            self.gitops_dir_host,
            bp,
            "backups",
            deployed_by=by,
            message=message,
        )

    async def record_backup_event(
        self,
        bp: str,
        action: str,
        detail: str,
        by: str | None = None,
        stage: str | None = None,
    ) -> dict:
        """Audit a backup-domain event (created/restored) in bitswan.yaml."""
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        rec = bs.setdefault("backups", {}).setdefault(bp, {})
        self._append_backup_log(rec, action, detail, by, stage)
        await self._save_and_commit_backups(
            bs, bp, by, f"backup {action} {bp}: {detail}"
        )
        return self.read_backups(bp)

    async def set_backup_retention(
        self, bp: str, retention: dict, by: str | None = None
    ) -> dict:
        """Set the production backup retention policy (daily/weekly/monthly counts)."""
        clean = {
            k: max(0, int((retention or {}).get(k, 0) or 0))
            for k in ("daily", "weekly", "monthly")
        }
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        rec = bs.setdefault("backups", {}).setdefault(bp, {})
        rec["retention"] = clean
        desc = (
            ", ".join(f"{v} {k}" for k, v in clean.items() if v)
            or "no automatic backups"
        )
        self._append_backup_log(rec, "retention", f"retention policy → {desc}", by)
        await self._save_and_commit_backups(
            bs, bp, by, f"backup retention {bp}: {desc}"
        )
        return self.read_backups(bp)

    def _apply_ingress(self) -> None:
        """Reconcile the daemon's ingress to the routes derived from the CURRENT
        bitswan.yaml. This is how ingress changes after a state write (swap /
        promote): the route moves because the desired set changed — `-production`
        follows `live_slot`, `-dr` follows the standby slot — NOT because we poke
        the daemon out of band. Best-effort: the recorded state is authoritative,
        and re-applying bitswan.yaml repairs any ingress that lagged."""
        try:
            bs_yaml = read_bitswan_yaml(self.gitops_dir) or {}
            _dc, _infra, routes = self.generate_docker_compose(bs_yaml)
            reconcile_ingress(self.workspace_name, routes)
        except Exception as e:  # noqa: BLE001 — recorded state wins; re-apply fixes
            logging.warning("ingress apply deferred: %s", e)

    async def swap_production_dr(
        self, bp: str, by: str | None = None, role: str | None = None
    ) -> dict:
        """The DR go-live swap: flip live_db/live_slot in bitswan.yaml so the
        standby (DR) slot becomes Production, then APPLY — the ingress reconcile
        repoints `-production` → the new live slot and `-dr` → the new standby.
        Zero downtime, no data moved — DR and Production trade places. Audited.

        The pointer flip + audit are authoritative; the ingress apply is
        best-effort (a transient ingress error must not desync the recorded
        state — re-applying bitswan.yaml re-asserts it)."""
        cur = self.read_backups(bp)
        target_slot = cur["dr_slot"]
        if not target_slot:
            raise ValueError(
                f"{bp} has no DR slot provisioned on the standby db "
                f"(db {cur['standby_db']}) — nothing to swap to"
            )
        new_live_db = cur["standby_db"]
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        rec = bs.setdefault("backups", {}).setdefault(bp, {})
        rec["live_db"] = new_live_db
        rec["live_slot"] = target_slot
        self._append_backup_log(
            rec,
            "swapped",
            (
                f"Production → slot {target_slot} on db{new_live_db} "
                f"(was slot {cur['live_slot']} on db{cur['live_db']}); DR ↔ Production"
            ),
            by,
        )
        await self._save_and_commit_backups(
            bs,
            bp,
            by,
            f"swap production/DR {bp}: → slot {target_slot} (db{new_live_db})",
        )
        # Apply: the ingress reconcile repoints both stable hosts from the new
        # backups state (-production → new live slot, -dr → new standby). No
        # out-of-band repoint — applying bitswan.yaml moves the routes.
        self._apply_ingress()
        return self.read_backups(bp)

    async def begin_zero_downtime_promote(self, bp: str, by: str | None = None) -> dict:
        """Record the slot transition for a zero-downtime promote and return
        which idle slot the new version should be brought up on (wired to the
        CURRENT live db — a promote never moves data). The caller deploys the
        new image into that slot, health-checks it, then calls
        `finish_zero_downtime_promote` to repoint ingress + retire the old slot."""
        cur = self.read_backups(bp)
        if not cur["idle_slots"]:
            raise ValueError(
                f"{bp} has no idle app slot free for a zero-downtime promote "
                f"(slots in use: {sorted(cur['slots'])})"
            )
        target_slot = cur["idle_slots"][0]
        live_db = cur["live_db"]
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        rec = bs.setdefault("backups", {}).setdefault(bp, {})
        rec.setdefault("slots", dict(cur["slots"]))
        rec["slots"][target_slot] = {"db": live_db, "state": "staging"}
        self._append_backup_log(
            rec,
            "promote-staging",
            f"staging new version on slot {target_slot} (db{live_db})",
            by,
        )
        await self._save_and_commit_backups(
            bs, bp, by, f"promote {bp}: staging slot {target_slot} (db{live_db})"
        )
        return {"target_slot": target_slot, "live_db": live_db, **self.read_backups(bp)}

    async def finish_zero_downtime_promote(
        self, bp: str, target_slot: str, by: str | None = None
    ) -> dict:
        """Cut over a staged promote: repoint the production ingress to
        `target_slot`, make it live, and retire the previously-live slot to
        idle. The db is unchanged (live_db stays)."""
        cur = self.read_backups(bp)
        old_live = cur["live_slot"]
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        rec = bs.setdefault("backups", {}).setdefault(bp, {})
        slots = rec.setdefault("slots", dict(cur["slots"]))
        if target_slot in slots:
            slots[target_slot] = {"db": cur["live_db"]}  # promoted to live
        rec["live_slot"] = target_slot
        if old_live != target_slot:
            slots.pop(old_live, None)  # retire old live slot → idle
        self._append_backup_log(
            rec,
            "promoted",
            f"zero-downtime promote: slot {old_live} → {target_slot} (db{cur['live_db']})",
            by,
        )
        await self._save_and_commit_backups(
            bs, bp, by, f"promote {bp}: slot {old_live} → {target_slot}"
        )
        # Apply: the ingress reconcile repoints -production → the new live slot
        # from the updated backups state. (The orchestrator also re-applies
        # compose afterwards to retire the old slot's containers.)
        self._apply_ingress()
        return self.read_backups(bp)

    async def zero_downtime_promote(
        self, bp: str, by: str | None = None, report: Callable[..., Any] | None = None
    ) -> dict:
        """Zero-downtime production promote, end to end:

        1. stage the new version on the idle app slot, wired to the CURRENT
           live db (begin_zero_downtime_promote);
        2. regenerate + apply compose — brings the staged slot's containers up
           beside the live slot (it is NOT on the production ingress yet);
        3. cut the ingress over to the staged slot + retire the old live slot
           (finish_zero_downtime_promote — the repoint);
        4. re-apply compose to remove the retired slot's containers.

        The db never moves: the new code talks to the same live db throughout.
        """
        staged = await self.begin_zero_downtime_promote(bp, by)
        target_slot = staged["target_slot"]
        dep_ids = list(self._bp_stage_members(bp, "production").keys())
        if report:
            await report("staging", f"Bringing up new version on slot {target_slot}…")
        await self.apply_compose_for_deployments(dep_ids, deployed_by=by, report=report)
        if report:
            await report(
                "cutover", f"Repointing production ingress to slot {target_slot}…"
            )
        result = await self.finish_zero_downtime_promote(bp, target_slot, by)
        # Retire the old slot's now-idle containers on the next apply.
        await self.apply_compose_for_deployments(dep_ids, deployed_by=by, report=report)
        return result

    # ── Supply chain (SBOM + CVEs) ───────────────────────────────────────────
    def read_supply_chain(self, bp: str, stage: str) -> dict:
        """SBOM + CVE rollup for the image(s) deployed to a BP stage, with the
        out-of-scope markings. Packages and CVEs are merged (deduped) across the
        stage's member images. Out-of-scope markings are a CODE property — they
        live in the source tree (`cve-waivers.yaml`) and are read here from
        `main` (read-only; they are authored from the Checks tab on a copy).
        `status`: ok | pending (scan not done yet) | unavailable | not-deployed."""
        from app.services import cve_waivers

        realm = bp_secrets.realm_for_stage(stage)
        deployments = self._bp_stage_node(bp, stage).get("deployments") or {}
        image_ids = [
            (d or {}).get("image_id")
            for d in deployments.values()
            if (d or {}).get("image_id")
        ]
        # Lazily (re)trigger a scan for any deployed image that has no completed
        # scan yet. The deploy path fires the scan, but a scan can be missing —
        # e.g. the image was promoted verbatim (built before the vuln DB landed)
        # or the cache was cleared — leaving the panel stuck on "pending". Viewing
        # the panel then kicks the scan off (background, never blocks the read),
        # so a subsequent poll resolves to a real result. We pass the docker image
        # ref (`image`) so syft/grype can resolve it, keyed by `image_id`.
        for d in deployments.values():
            iid = (d or {}).get("image_id")
            ref = (d or {}).get("image") or iid
            if not iid:
                continue
            scan = supply_chain_service.read_image_scan(iid)
            if scan.get("status") not in ("ok", "unavailable"):
                supply_chain_service.spawn_scan(ref, iid)
        return self._supply_chain_report(
            bp, realm, image_ids, cve_waivers.waiver_list(bp, None)
        )

    def _supply_chain_report(
        self, bp: str, realm: str, image_ids: list[str], waivers: list[dict]
    ) -> dict:
        """Merge the cached SBOM + CVE scans of `image_ids` into one deduped
        report, carrying the source-tree out-of-scope markings. Shared by the
        deployed-image rollup (read_supply_chain) and the pre-build preview
        (Checks tab), so both render through the identical SupplyChainReport
        shape."""
        merged: dict[tuple, dict] = {}
        statuses: list[str] = []
        scanned_ats: list[str] = []
        for iid in image_ids:
            scan = supply_chain_service.read_image_scan(iid)
            statuses.append(scan.get("status"))
            if scan.get("scanned_at"):
                scanned_ats.append(scan["scanned_at"])
            for p in scan.get("packages", []):
                entry = merged.setdefault(
                    (p["name"], p["version"]),
                    {
                        "name": p["name"],
                        "version": p["version"],
                        "type": p.get("type", ""),
                        "cves": {},
                    },
                )
                for c in p.get("cves", []):
                    entry["cves"][c["id"]] = c["severity"]
        packages = [
            {
                "name": e["name"],
                "version": e["version"],
                "type": e["type"],
                "cves": [
                    {"id": cid, "severity": sev}
                    for cid, sev in sorted(e["cves"].items())
                ],
            }
            for e in sorted(merged.values(), key=lambda x: x["name"].lower())
        ]
        if not image_ids:
            status = "not-deployed"
        elif any(s == "ok" for s in statuses):
            status = "ok"
        elif any(s == "unavailable" for s in statuses):
            status = "unavailable"
        else:
            status = "pending"
        return {
            "bp": bp,
            "stage": realm,
            "status": status,
            "scanned_at": min(scanned_ats) if scanned_ats else None,
            "image_count": len(image_ids),
            "packages": packages,
            "waivers": waivers,
        }

    async def _bake_source_for_scan(
        self, relative_path: str
    ) -> tuple[str | None, str | None]:
        """Bake one automation source's content-addressed image and return
        (image_ref, image_id). Resolves base image + merge dirs exactly as the
        deploy path does, so the produced tag/hash is identical — an unchanged
        source is a cache hit, and the result IS the image a deploy would ship."""
        source_dir = os.path.realpath(
            os.path.join(self.workspace_repo_dir, relative_path)
        )
        ws_root_real = os.path.realpath(self.workspace_repo_dir)
        if not (
            source_dir == ws_root_real or source_dir.startswith(ws_root_real + os.sep)
        ):
            raise HTTPException(status_code=400, detail="Source escapes workspace")
        bitswan_lib_dir = os.path.join(self.workspace_repo_dir, "bitswan_lib")
        dirs_to_merge = [source_dir]
        if os.path.isdir(bitswan_lib_dir):
            dirs_to_merge.append(bitswan_lib_dir)
        base_tag = await self._ensure_automation_image(source_dir)
        auto_conf = read_automation_config(source_dir)
        base_image = base_tag or auto_conf.image
        checksum = await calculate_git_tree_hash(dirs_to_merge)
        return await self._bake_source_image(
            source_dir, dirs_to_merge, base_image, auto_conf.mount_path, checksum
        )

    async def preview_supply_chain(self, bp: str, copy: str | None = None) -> dict:
        """SBOM + CVE preview for the image(s) a deploy of `bp` WOULD build from
        the current source (the Sync & Deploy → Checks tab). Bakes each member
        automation's image — content-addressed, so it's the exact artifact a
        deploy produces and reuses the cache when unchanged — kicks off a
        syft+grype scan, and merges via the shared `_supply_chain_report` so it
        renders through the identical SupplyChainReport shape as the deployed
        rollup. Out-of-scope markings are read from this copy's source tree."""
        from app.services.bp_databases import derive_bp_and_copy
        from app.services import cve_waivers

        sources = scan_workspace_sources(self.workspace_repo_dir, copy=copy)
        members = [
            s for s in sources if derive_bp_and_copy(s.get("relative_path"))[0] == bp
        ]
        image_ids: list[str] = []
        for s in members:
            image, image_id = await self._bake_source_for_scan(s["relative_path"])
            if image and image_id:
                supply_chain_service.spawn_scan(image, image_id)
                image_ids.append(image_id)
        return self._supply_chain_report(
            bp, "dev", image_ids, cve_waivers.waiver_list(bp, copy)
        )

    async def set_cve_waiver(
        self,
        bp: str,
        copy: str | None,
        package: str,
        cve: str,
        comment: str,
        by: str | None = None,
    ) -> dict:
        """Mark a CVE out of scope for a BP, stored in the copy's source tree
        (`cve-waivers.yaml`) and committed — it rides Sync & Deploy to main with
        the code. Returns the refreshed Checks preview."""
        from app.services import cve_waivers

        await cve_waivers.set_waiver(
            bp,
            copy,
            package,
            cve,
            (comment or "").strip(),
            by,
            date.today().strftime("%b %-d, %Y"),
        )
        return await self.preview_supply_chain(bp, copy)

    async def unset_cve_waiver(
        self, bp: str, copy: str | None, package: str, cve: str, by: str | None = None
    ) -> dict:
        """Restore a previously out-of-scope CVE to in-scope (commit in the
        copy's source tree). Returns the refreshed Checks preview."""
        from app.services import cve_waivers

        await cve_waivers.unset_waiver(bp, copy, package, cve)
        return await self.preview_supply_chain(bp, copy)

    async def rescan_deployed_images(self) -> dict:
        """Daily job: refresh the grype vuln DB (best-effort) and re-run grype
        against every distinct deployed image's cached SBOM so new CVEs surface."""
        await supply_chain_service.update_vuln_db()
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        seen: set[str] = set()
        scanned = 0
        for dep in (bs.get("deployments") or {}).values():
            dep = dep or {}
            iid, ref = dep.get("image_id"), dep.get("image")
            if not iid or iid in seen:
                continue
            seen.add(iid)
            await supply_chain_service.scan_image(ref or iid, iid, force_cve=True)
            scanned += 1
        logger.info(f"supply-chain daily rescan: {scanned} image(s)")
        return {"rescanned": scanned}

    # ── Egress firewall (outbound allow-list) ────────────────────────────────
    _FW_ROLES = ("admin", "auditor")

    def read_firewall(self, bp: str, stage: str) -> dict:
        """Allow-list rules (from bitswan.yaml, audited) + the gateway's
        blocked/observed attempts (telemetry). `posture` is monitor for dev,
        enforce for staging/production. `attempts` is the 'needs review' feed:
        observed hosts that have no rule yet."""
        realm = bp_secrets.realm_for_stage(stage)
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        node = ((bs.get("firewall") or {}).get(bp) or {}).get(realm) or {}
        rules = node.get("rules") or {}
        posture = node.get("posture") or firewall_service.posture_for(realm)
        rule_list = [{"host": h, **(r or {})} for h, r in sorted(rules.items())]
        attempts = firewall_service.read_attempts(bp, realm)
        review = [
            {"host": h, **a} for h, a in sorted(attempts.items()) if h not in rules
        ]
        return {
            "bp": bp,
            "stage": realm,
            "posture": posture,
            "rules": rule_list,
            "attempts": review,
            "allowed": [r["host"] for r in rule_list if r.get("status") == "allowed"],
        }

    def _require_fw_role(self, stage: str, role: str | None) -> None:
        """Production rule changes require an admin or auditor role."""
        if (
            bp_secrets.realm_for_stage(stage) == "production"
            and role not in self._FW_ROLES
        ):
            raise HTTPException(
                status_code=403,
                detail="Only admin or auditor roles may change production firewall rules",
            )

    async def set_firewall_rule(
        self,
        bp: str,
        stage: str,
        host: str,
        status: str,  # "allowed" | "denied"
        purpose: str = "",
        gdpr: dict | None = None,
        by: str | None = None,
        role: str | None = None,
    ) -> dict:
        """Allow or deny an outbound host for a BP stage. Versioned in
        bitswan.yaml (the audit log of who decided what, when, and why)."""
        if status not in ("allowed", "denied"):
            raise HTTPException(status_code=400, detail="status must be allowed|denied")
        self._require_fw_role(stage, role)
        host = host.strip().lower()
        if not host:
            raise HTTPException(status_code=400, detail="host is required")
        realm = bp_secrets.realm_for_stage(stage)
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        node = bs.setdefault("firewall", {}).setdefault(bp, {}).setdefault(realm, {})
        node.setdefault("posture", firewall_service.posture_for(realm))
        node.setdefault("rules", {})[host] = {
            "status": status,
            "purpose": (purpose or "").strip(),
            "by": by or "unknown",
            "at": date.today().strftime("%b %-d, %Y"),
            **({"gdpr": gdpr} if gdpr else {}),
        }
        await self._save_and_commit_firewall(
            bs, bp, by, f"firewall {bp}/{realm}: {status} {host}"
        )
        return self.read_firewall(bp, stage)

    async def delete_firewall_rule(
        self,
        bp: str,
        stage: str,
        host: str,
        by: str | None = None,
        role: str | None = None,
    ) -> dict:
        """Remove a rule (revoke an allow / clear a deny) — its own commit."""
        self._require_fw_role(stage, role)
        host = host.strip().lower()
        realm = bp_secrets.realm_for_stage(stage)
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        rules = (((bs.get("firewall") or {}).get(bp) or {}).get(realm) or {}).get(
            "rules"
        ) or {}
        if host in rules:
            del rules[host]
            await self._save_and_commit_firewall(
                bs, bp, by, f"firewall {bp}/{realm}: remove rule {host}"
            )
        return self.read_firewall(bp, stage)

    async def promote_firewall(
        self,
        bp: str,
        from_stage: str,
        to_stage: str,
        by: str | None = None,
        role: str | None = None,
    ) -> dict:
        """Pull firewall rules forward (e.g. dev→staging→production). Copies the
        source realm's rules onto the target realm. Target=production needs the
        role check."""
        self._require_fw_role(to_stage, role)
        from_realm = bp_secrets.realm_for_stage(from_stage)
        to_realm = bp_secrets.realm_for_stage(to_stage)
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        src = (((bs.get("firewall") or {}).get(bp) or {}).get(from_realm) or {}).get(
            "rules"
        ) or {}
        node = bs.setdefault("firewall", {}).setdefault(bp, {}).setdefault(to_realm, {})
        node.setdefault("posture", firewall_service.posture_for(to_realm))
        dst = node.setdefault("rules", {})
        for h, r in src.items():
            dst[h] = {
                **(r or {}),
                "by": by or "unknown",
                "at": date.today().strftime("%b %-d, %Y"),
            }
        await self._save_and_commit_firewall(
            bs, bp, by, f"promote firewall {bp}: {from_realm} → {to_realm}"
        )
        return self.read_firewall(bp, to_stage)

    async def rollback_firewall(
        self,
        bp: str,
        stage: str,
        git_commit: str,
        by: str | None = None,
        role: str | None = None,
    ) -> dict:
        """Roll a BP realm's firewall rule set back to a prior commit. The audit
        log lives in git (bp_history surfaces every firewall change), so a
        rollback restores firewall[bp][realm] (rules + posture) exactly as it was
        at `git_commit`, records the restore as its own versioned commit, and
        reloads the egress gateway for any deployed members so enforcement
        immediately reflects the restored allow-list. Production rollbacks
        require an admin/auditor role (same gate as live edits)."""
        self._require_fw_role(stage, role)
        realm = bp_secrets.realm_for_stage(stage)
        # Fail loudly if the revision does not exist (rather than silently
        # clearing the realm because git show returned nothing).
        _, _, rc = await call_git_command_with_output(
            "git", "cat-file", "-e", f"{git_commit}^{{commit}}", cwd=self.gitops_dir
        )
        if rc != 0:
            raise HTTPException(
                status_code=404, detail=f"No such revision {git_commit[:8]}"
            )
        target = _parse_revision_firewall_realm(self.gitops_dir, git_commit, bp, realm)
        bs = read_bitswan_yaml(self.gitops_dir) or {}
        fw = bs.setdefault("firewall", {}).setdefault(bp, {})
        if target:
            # deepcopy: the parsed revision is memoized (shared, immutable).
            fw[realm] = copy.deepcopy(target)
        else:
            # The target predates any rule for this realm — restore that empty
            # state by dropping the node entirely.
            fw.pop(realm, None)
        await self._save_and_commit_firewall(
            bs, bp, by, f"rollback firewall {bp}/{realm} @ {git_commit[:8]}"
        )
        # Push the restored allow-list to the running gateway (no-op when the
        # stage has nothing deployed — rules can be set before first deploy).
        members = self._bp_stage_members(bp, stage)
        if members:
            await self.apply_compose_for_deployments(list(members), deployed_by=by)
        return self.read_firewall(bp, stage)

    async def _save_and_commit_firewall(
        self, bs: dict, bp: str, by: str | None, message: str
    ):
        path = os.path.join(self.gitops_dir, "bitswan.yaml")
        with open(path, "w") as f:
            dump_bitswan_yaml(bs, f)
        await update_git(
            self.gitops_dir,
            self.gitops_dir_host,
            bp,
            "firewall",
            deployed_by=by,
            message=message,
        )

    # -- firewall DPA (data-processing agreement) documents ---------------------
    # A GDPR rule's `gdpr` record (in bitswan.yaml) may reference a signed DPA
    # PDF. The PDF itself is too big/binary for bitswan.yaml, so it's stored in
    # the gitops repo under firewall-dpa/<bp>/ (one file per realm+host) and
    # versioned/pushed like everything else — same audit + rollback engine.

    def _dpa_rel(self, bp: str, host: str) -> str:
        """Repo-relative path of a host's DPA PDF, namespaced per BP. Keyed on
        the host (the data processor), not the stage — a DPA with e.g. sentry.io
        is the same agreement whichever stage reaches it, so a promoted rule
        keeps pointing at the same document."""
        safe_host = re.sub(r"[^a-z0-9._-]", "_", host.strip().lower())
        return os.path.join("firewall-dpa", bp, f"{safe_host}.pdf")

    def firewall_dpa_path(self, bp: str, host: str) -> str | None:
        """Absolute path of the stored DPA PDF for a BP host, or None."""
        p = os.path.join(self.gitops_dir, self._dpa_rel(bp, host.strip().lower()))
        return p if os.path.isfile(p) else None

    async def store_firewall_dpa(
        self,
        bp: str,
        stage: str,
        host: str,
        content: bytes,
        filename: str | None = None,
        by: str | None = None,
        role: str | None = None,
    ) -> dict:
        """Store a host's DPA PDF in the gitops repo (firewall-dpa/<bp>/) and
        version it. Production needs admin/auditor, same as a rule change."""
        self._require_fw_role(stage, role)
        if not content:
            raise HTTPException(status_code=400, detail="empty DPA upload")
        host = host.strip().lower()
        if not host:
            raise HTTPException(status_code=400, detail="host is required")
        realm = bp_secrets.realm_for_stage(stage)
        rel = self._dpa_rel(bp, host)
        abspath = os.path.join(self.gitops_dir, rel)
        os.makedirs(os.path.dirname(abspath), exist_ok=True)
        with open(abspath, "wb") as f:
            f.write(content)
        await update_git(
            self.gitops_dir,
            self.gitops_dir_host,
            bp,
            "firewall",
            deployed_by=by,
            message=f"firewall dpa {bp}/{realm}: {host} ({filename or 'dpa.pdf'})",
            extra_paths=[rel],
        )
        return {"stored": rel, "filename": filename or os.path.basename(abspath)}

    async def scale_business_process(self, bp: str, stage: str, replicas: int) -> dict:
        """Scale every member container of a BP stage to `replicas` (Inspect →
        Scale). Reuses the per-deployment scale_automation."""
        members = self._bp_stage_members(bp, stage)
        if not members:
            raise HTTPException(
                status_code=404,
                detail=f"No deployment for {bp}/{stage}",
            )
        for dep_id in members:
            await self.scale_automation(dep_id, replicas)
        return {
            "bp": bp,
            "stage": stage,
            "replicas": replicas,
            "members": list(members),
        }

    @staticmethod
    def _nest_tree(paths: list[str]) -> list[dict]:
        """Turn a flat list of BP-relative file paths into the nested
        FileTreeNode shape the dashboard's FileTree component consumes
        ({name, kind, path, children?}), folders before files, each sorted."""
        root: dict = {}
        for p in sorted(paths):
            parts = [seg for seg in p.split("/") if seg]
            cur = root
            acc: list[str] = []
            for i, seg in enumerate(parts):
                acc.append(seg)
                is_file = i == len(parts) - 1
                node = cur.get(seg)
                if node is None:
                    node = {
                        "name": seg,
                        "path": "/".join(acc),
                        "kind": "file" if is_file else "folder",
                        "_children": None if is_file else {},
                    }
                    cur[seg] = node
                if not is_file:
                    cur = node["_children"]

        def to_list(d: dict) -> list[dict]:
            out = []
            for node in d.values():
                if node["kind"] == "folder":
                    out.append(
                        {
                            "name": node["name"],
                            "path": node["path"],
                            "kind": "folder",
                            "children": to_list(node["_children"]),
                        }
                    )
                else:
                    out.append(
                        {"name": node["name"], "path": node["path"], "kind": "file"}
                    )
            out.sort(key=lambda e: (e["kind"] != "folder", e["name"].lower()))
            return out

        return to_list(root)

    async def bp_file_tree(self, bp: str, commit: str) -> dict:
        """The full recursive source tree of a BP at a git commit (Inspect →
        Files), as nested FileTreeNode entries with BP-relative paths."""
        if not re.fullmatch(r"[0-9a-fA-F]{4,64}", commit or ""):
            raise HTTPException(status_code=400, detail="invalid commit")
        main = os.path.join(os.environ.get("BITSWAN_COPIES_DIR", "/copies"), "main")
        out, _, rc = await call_git_command_with_output(
            "git", "ls-tree", "-r", "--name-only", commit, "--", f"{bp}/", cwd=main
        )
        if rc != 0:
            raise HTTPException(status_code=404, detail=f"not found: {bp}@{commit}")
        prefix = bp + "/"
        rels = [
            line[len(prefix) :] if line.startswith(prefix) else line
            for line in out.splitlines()
            if line.strip()
        ]
        return {"entries": self._nest_tree(rels)}

    async def bp_file_content(self, bp: str, commit: str, path: str) -> dict:
        """A single file's content from a BP's source at a git commit (1 MiB
        cap, Inspect → Files)."""
        if not re.fullmatch(r"[0-9a-fA-F]{4,64}", commit or ""):
            raise HTTPException(status_code=400, detail="invalid commit")
        if not path or path.startswith("/") or ".." in path.split("/"):
            raise HTTPException(status_code=400, detail="invalid path")
        main = os.path.join(os.environ.get("BITSWAN_COPIES_DIR", "/copies"), "main")
        rel = f"{bp}/{path}"
        typ, _, trc = await call_git_command_with_output(
            "git", "cat-file", "-t", f"{commit}:{rel}", cwd=main
        )
        if trc != 0 or typ.strip() != "blob":
            raise HTTPException(status_code=404, detail=f"not a file: {path}")
        out, _, _ = await call_git_command_with_output(
            "git", "show", f"{commit}:{rel}", cwd=main
        )
        cap = 1_000_000
        return {"path": path, "content": out[:cap], "truncated": len(out) > cap}

    async def _pg_dump_schema(self, stage: str) -> str | None:
        """`pg_dump --schema-only` of the stage's Postgres via docker exec, or
        None when Postgres isn't enabled for the stage."""
        from app.services.bp_databases import get_service_secrets

        secrets = get_service_secrets("postgres", stage)
        if not secrets or not secrets.get("POSTGRES_USER"):
            return None
        user = secrets["POSTGRES_USER"]
        pw = secrets.get("POSTGRES_PASSWORD", "")
        db = secrets.get("POSTGRES_DB", "postgres")
        ws = os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace")
        container = f"{ws}__postgres-{stage}"
        try:
            client = get_async_docker_client()
            found = await client.list_containers(
                all=False, filters={"name": [f"^/{container}$"]}
            )
            if not found:
                return None
            cid = found[0]["Id"]
            exec_id = await client.exec_create(
                cid,
                [
                    "sh",
                    "-c",
                    f"PGPASSWORD='{pw}' pg_dump --schema-only -U {user} {db}",
                ],
            )
            out = await client.exec_start(exec_id)
            return (
                out if isinstance(out, str) else (out or b"").decode("utf-8", "replace")
            )
        except Exception as e:
            logger.warning("pg_dump schema failed for %s: %s", stage, e)
            return None

    async def bundle_deployment(self, bp: str, stage: str, commit: str) -> str:
        """Build a downloadable .tar.gz of a deployment: the source at `commit`,
        a `docker save` of each member image, and the stage's Postgres schema.
        Returns the path to the temp archive (the route streams + deletes it)."""
        if not re.fullmatch(r"[0-9a-fA-F]{4,64}", commit or ""):
            raise HTTPException(status_code=400, detail="invalid commit")
        stage_key = "production" if stage in ("", "production") else stage
        members = self._bp_stage_members(bp, stage_key)
        if not members:
            raise HTTPException(
                status_code=404, detail=f"No deployment for {bp}/{stage_key}"
            )
        main = os.path.join(os.environ.get("BITSWAN_COPIES_DIR", "/copies"), "main")
        schema = await self._pg_dump_schema(stage_key)

        def _build() -> str:
            import docker

            staging = tempfile.mkdtemp(prefix=".bundle-")
            try:
                # 1) source at the commit
                src_dir = os.path.join(staging, "source")
                os.makedirs(src_dir)
                src_tar = os.path.join(staging, "source.tar")
                with open(src_tar, "wb") as f:
                    rc = subprocess.run(
                        ["git", "archive", "--format=tar", commit, "--", f"{bp}/"],
                        cwd=main,
                        stdout=f,
                    ).returncode
                if rc == 0:
                    with tarfile.open(src_tar) as t:
                        t.extractall(src_dir)
                os.remove(src_tar)
                # 2) docker save each member image
                client = docker.from_env()
                img_dir = os.path.join(staging, "images")
                os.makedirs(img_dir)
                for dep_id, m in members.items():
                    ref = (m or {}).get("image") or (m or {}).get("image_id")
                    if not ref:
                        continue
                    image = client.images.get(ref)  # raises if missing — fail loudly
                    with open(os.path.join(img_dir, f"{dep_id}.tar"), "wb") as f:
                        for chunk in image.save(named=True):
                            f.write(chunk)
                # 3) schema + manifest
                if schema:
                    with open(os.path.join(staging, "schema.sql"), "w") as f:
                        f.write(schema)
                else:
                    with open(os.path.join(staging, "README.txt"), "w") as f:
                        f.write("Postgres not enabled for this stage; no schema.sql.\n")
                # 4) assemble the archive
                out_fd, out_path = tempfile.mkstemp(
                    prefix=f"{bp}-{stage_key}-", suffix=".tar.gz"
                )
                os.close(out_fd)
                with tarfile.open(out_path, "w:gz") as tar:
                    tar.add(staging, arcname=f"{bp}-{stage_key}-{commit[:8]}")
                return out_path
            finally:
                shutil.rmtree(staging, ignore_errors=True)

        return await asyncio.to_thread(_build)

    async def apply_compose_for_deployments(
        self,
        deployment_ids: list[str],
        deployed_by: str | None = None,
        report: Callable[..., Any] | None = None,
    ) -> dict:
        """Regenerate the full compose once and bring up the given member
        services (+ their infra) in a single `docker compose up`, then run the
        post-deploy hooks for each member and record image tags.
        """

        async def _report(step: str, message: str):
            if report is not None:
                await report(step, message)

        os.environ["COMPOSE_PROJECT_NAME"] = self.workspace_name
        bs_yaml = read_bitswan_yaml(self.gitops_dir)

        await _report(
            "generating_compose", "Generating docker-compose configuration..."
        )
        dc_yaml, infra_service_names, desired_routes = self.generate_docker_compose(
            bs_yaml
        )
        self._save_docker_compose(dc_yaml)
        # Reconcile the daemon's ingress to the FULL desired route set derived
        # from bitswan.yaml (adds/repoints/prunes only gitops routes; manual
        # routes preserved; in-sync routes skipped). This is the only place
        # ingress is touched — applying bitswan.yaml is what converges it.
        # A promote to a new stage adds that stage's host(s) here (cert mint +
        # route), which is real work — report it so the deploy never goes dark.
        await _report("reconciling_ingress", "Configuring ingress routes...")
        reconcile_ingress(self.workspace_name, desired_routes)
        dc_config = yaml.safe_load(dc_yaml)
        services = dc_config.get("services", {})

        # Map each generated service back to the deployment it belongs to via its
        # label. A production deployment emits MULTIPLE services (one per
        # blue-green slot, `…-a`/`…-b`, labelled `<dep_id>` for the live slot and
        # `<dep_id>@<slot>` for the others) — bring up every slot. A member with
        # no resolvable image is simply absent from the compose and skipped.
        want = set(deployment_ids)
        member_services: list[str] = []
        service_by_dep: dict[str, str] = {}
        for name, svc in services.items():
            base = ((svc.get("labels") or {}).get("gitops.deployment_id") or "").split(
                "@"
            )[0]
            if base in want:
                member_services.append(name)
                # All of a deployment's slots share one image; any slot's service
                # is fine for reading the resolved image tag back.
                service_by_dep.setdefault(base, name)

        await _report("docker_compose_up", "Starting containers...")
        infra_to_up = await self._infra_services_to_bring_up(infra_service_names)
        deployment_result = await docker_compose_up(
            self.gitops_dir,
            dc_yaml,
            container_name=None,
            extra_services=member_services + infra_to_up,
            progress_callback=_report,
        )
        await _report("provisioning_services", "Provisioning databases & services...")
        await self._post_deploy_infra_services(bs_yaml)
        await self._provision_bp_databases(bs_yaml, deployment_ids)

        for result in deployment_result.values():
            if result["return_code"] != 0:
                raise HTTPException(
                    status_code=500,
                    detail=(
                        f"Error deploying services: \ndocker-compose:\n {dc_yaml}\n\n"
                        f"stdout:\n {result['stdout']}\nstderr:\n{result['stderr']}\n"
                    ),
                )

        # Per-member progress: a production promote brings up several members
        # (each with two blue-green slots), so one static "Installing
        # certificates…" for the whole set can exceed the deploy progress
        # window. Report each member as it's handled.
        for i, dep_id in enumerate(deployment_ids, 1):
            await _report(
                "installing_certs",
                f"Installing certificates… ({i}/{len(deployment_ids)} {dep_id})",
            )
            await self.install_certificates_in_container(dep_id)
        for i, dep_id in enumerate(deployment_ids, 1):
            await _report(
                "starting_oauth2_proxy",
                f"Starting OAuth2 proxy… ({i}/{len(deployment_ids)} {dep_id})",
            )
            await self.start_oauth2_proxy_in_container(dep_id)
        await self.start_oauth2_proxy_in_infra_services(infra_service_names)

        # Record resolved image tags for each member in one final commit.
        await _report("storing_tags", "Recording image tags...")
        bs_yaml = read_bitswan_yaml(self.gitops_dir)
        changed = False
        for dep_id in deployment_ids:
            svc_name = service_by_dep.get(dep_id)
            if not svc_name:
                continue
            deployed_image = services[svc_name].get("image")
            image_tag = await self.get_tag(deployed_image)
            if image_tag and dep_id in bs_yaml.get("deployments", {}):
                bs_yaml["deployments"][dep_id]["tag_checksum"] = image_tag
                changed = True
        if changed:
            bitswan_yaml_path = os.path.join(self.gitops_dir, "bitswan.yaml")
            with open(bitswan_yaml_path, "w") as f:
                dump_bitswan_yaml(bs_yaml, f)
            await update_git(
                self.gitops_dir,
                self.gitops_dir_host,
                deployment_ids[0] if deployment_ids else "all",
                "deploy",
                deployed_by=deployed_by,
            )

        # Refresh the static automation cache so the just-deployed members (and,
        # for a production promote, their blue-green slot containers) show up in
        # the listing immediately. The Docker-events watcher that would otherwise
        # invalidate the cache does NOT fire in some environments (notably
        # Docker-in-Docker CI), so without this an Inspect/Containers view right
        # after a set-deploy or promote sees "No container found" until an
        # unrelated event refreshes it. deploy_automation() refreshes for the
        # single-deployment path; this covers deploy_source_set + promote.
        await self.refresh_all()

        return deployment_result

    async def deploy_source_set(
        self,
        label: str,
        members: list[dict],
        stage: str,
        copy: str | None = None,
        deployed_by: str | None = None,
        commit_subject: str | None = None,
        progress_callback: Callable[..., Any] | None = None,
    ) -> dict:
        """Deploy an arbitrary set of scanned automation sources as one unit.

        `members` is a non-empty list of scanner dicts (the
        `scan_workspace_sources` shape). Preps ALL members first (build images
        + checksum + materialize), so a failure in any member aborts before
        bitswan.yaml is touched or any container is changed. Only once all
        preps succeed do we write the config once and run a single compose-up
        over the member services. `label` is cosmetic (logs/commit context);
        the caller owns deploy-task creation and member locking.
        """

        async def _report(step: str, message: str, current: int | None = None):
            if progress_callback is not None:
                await progress_callback(step, message, current)

        if stage not in {"dev", "live-dev"}:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported stage '{stage}' (allowed: dev, live-dev)",
            )
        if not members:
            raise HTTPException(
                status_code=404,
                detail=f"No deployable automations for '{label}'",
            )

        # Prep every member up-front (fail-fast — touches no containers).
        total = len(members)
        prepped: list[dict] = []
        for i, src in enumerate(members, start=1):
            await _report(
                "building_images",
                f"Preparing {i}/{total}: {src.get('display_name', src['relative_path'])}",
                current=i - 1,
            )

            # Surface granular image-build progress for THIS member while it
            # builds (minutes for a real image). Pin the per-member counter so
            # the build-log tail updates don't reset the i/total progress.
            async def _build_report(step: str, message: str, _current=None, _i=i):
                await _report(step, message, current=_i - 1)

            prep = await self.prep_deploy_source(
                src["relative_path"], stage, copy, progress_callback=_build_report
            )
            prepped.append(prep)

        await _report(
            "updating_config", "Updating deployment configuration...", current=total
        )
        await self.write_deployment_entries(
            prepped,
            deployed_by=deployed_by,
            commit_subject=commit_subject or f"deploy {label}",
            report=_report,
        )

        deployment_ids = [p["deployment_id"] for p in prepped]
        result = await self.apply_compose_for_deployments(
            deployment_ids, deployed_by=deployed_by, report=_report
        )

        return {
            "message": "Deployed successfully",
            "label": label,
            "deployment_ids": deployment_ids,
            "prepped": prepped,
            "result": result,
        }

    async def deploy_business_process(
        self,
        bp: str,
        stage: str,
        copy: str | None = None,
        members: list[dict] | None = None,
        deployed_by: str | None = None,
        progress_callback: Callable[..., Any] | None = None,
    ) -> dict:
        """Deploy every automation under one business process as a single unit.

        Thin wrapper over `deploy_source_set` that enumerates the BP's members
        and preserves the BP-specific 404 message and return shape.
        """
        if stage not in {"dev", "live-dev"}:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported stage '{stage}' (allowed: dev, live-dev)",
            )

        if members is None:
            members = self.members_for_bp(bp, copy, stage)
        if not members:
            raise HTTPException(
                status_code=404,
                detail=f"No deployable automations under BP '{bp}'",
            )

        out = await self.deploy_source_set(
            label=bp,
            members=members,
            stage=stage,
            copy=copy,
            deployed_by=deployed_by,
            commit_subject=f"deploy business process {bp}",
            progress_callback=progress_callback,
        )

        # Record the BP-level deploy (shared git commit + per-member images +
        # history) for the Deployment History tab + group rollback. live-dev is
        # a per-copy preview, not a tracked stage.
        if stage != "live-dev":
            prepped = out.get("prepped") or []
            git_commit = next(
                (p.get("source_commit") for p in prepped if p.get("source_commit")),
                None,
            )
            await self.write_bp_deploy(
                bp=bp,
                stage=stage,
                git_commit=git_commit,
                members=prepped,
                deployed_by=deployed_by,
                source="deploy",
                status="deployed",
            )

        return {
            "message": "Deployed business process successfully",
            "bp": bp,
            "deployment_ids": out["deployment_ids"],
            "result": out["result"],
        }

    def promotable_bp_members(self, bp: str, target_stage: str) -> list[dict]:
        """Enumerate one BP's deployments at the previous stage, shaped as
        member dicts for `write_deployment_entries` targeting `target_stage`.

        Promotion re-deploys the source stage's recorded checksum — no scan,
        no image build, no materialize (the asset tree already lives under
        `<gitops_dir>/<checksum>/`). Target deployment ids follow the same
        convention as the dashboard per-automation promote flow:
        `{automation}-{bp}-staging` for staging and `{automation}-{bp}`
        (no suffix) for production.
        """
        if target_stage not in {"staging", "production"}:
            raise HTTPException(
                status_code=400,
                detail="Stage must be one of: staging, production",
            )
        source_stage = "dev" if target_stage == "staging" else "staging"
        bs_yaml = read_bitswan_yaml(self.gitops_dir) or {"deployments": {}}
        deployments = bs_yaml.get("deployments", {}) or {}
        bp_key = sanitize_automation_name(bp)

        members: list[dict] = []
        for dep_id, conf in deployments.items():
            conf = conf or {}
            stage = conf.get("stage", "production") or "production"
            if stage != source_stage:
                continue
            rel = (conf.get("relative_path") or "").replace("\\", "/")
            parts = [p for p in rel.split("/") if p]
            if len(parts) >= 2 and parts[0] == "copies":
                # Non-main copy live-dev trees never source promotions; the
                # main copy is the canonical (unprefixed) scope.
                if parts[1] != "main":
                    continue
                parts = parts[2:]  # drop "copies/main"
            in_bp = bool(parts) and sanitize_automation_name(parts[0]) == bp_key
            if not in_bp:
                ctx = conf.get("context") or ""
                in_bp = bool(ctx) and sanitize_automation_name(ctx) == bp_key
            if not in_bp:
                continue
            checksum = conf.get("checksum")
            if (not checksum or checksum == "live-dev") and not conf.get("image"):
                continue

            automation_name = conf.get("automation_name")
            context = conf.get("context")
            if automation_name:
                ctx = context or ""
                if target_stage == "production":
                    target_id = (
                        f"{automation_name}-{ctx}"
                        if ctx
                        else f"{automation_name}-production"
                    )
                else:
                    target_id = (
                        f"{automation_name}-{ctx}-staging"
                        if ctx
                        else f"{automation_name}-staging"
                    )
            else:
                # Legacy entry without structured name fields — derive from
                # the source deployment id's stage suffix.
                base = dep_id.removesuffix(f"-{source_stage}")
                target_id = (
                    base if target_stage == "production" else f"{base}-{target_stage}"
                )

            members.append(
                {
                    "deployment_id": target_id,
                    "checksum": checksum,
                    # Promotion reuses the SAME baked image (no rebuild): carry
                    # the source stage's image ref + id + source commit forward.
                    "image": conf.get("image"),
                    "image_id": conf.get("image_id"),
                    "source_commit": conf.get("source_commit"),
                    "stage": target_stage,
                    "relative_path": conf.get("relative_path"),
                    "automation_name": automation_name,
                    "context": context,
                    "display_name": automation_name or dep_id,
                }
            )
        return members

    async def promote_business_process(
        self,
        bp: str,
        target_stage: str,
        members: list[dict] | None = None,
        deployed_by: str | None = None,
        progress_callback: Callable[..., Any] | None = None,
    ) -> dict:
        """Promote every automation of one BP from the previous stage to
        `target_stage` as a single unit: ONE bitswan.yaml write + ONE
        compose-up over the target services.

        No prep step — promotion re-deploys the source stage's recorded
        checksums verbatim, so the deployed bits are exactly what was running
        at the source stage even if the workspace source has since changed.
        Existing target entries are updated in place (their replicas etc.
        are preserved by the partial upsert).
        """

        async def _report(step: str, message: str, current: int | None = None):
            if progress_callback is not None:
                await progress_callback(step, message, current)

        if members is None:
            members = self.promotable_bp_members(bp, target_stage)
        source_stage = "dev" if target_stage == "staging" else "staging"
        if not members:
            raise HTTPException(
                status_code=404,
                detail=(f"No {source_stage} deployments to promote under BP '{bp}'"),
            )

        await _report(
            "updating_config", "Updating deployment configuration...", current=0
        )
        await self.write_deployment_entries(
            members,
            deployed_by=deployed_by,
            commit_subject=f"promote business process {bp} to {target_stage}",
            report=_report,
        )

        deployment_ids = [m["deployment_id"] for m in members]
        result = await self.apply_compose_for_deployments(
            deployment_ids, deployed_by=deployed_by, report=_report
        )

        git_commit = next(
            (m.get("source_commit") for m in members if m.get("source_commit")), None
        )
        await self.write_bp_deploy(
            bp=bp,
            stage=target_stage,
            git_commit=git_commit,
            members=members,
            deployed_by=deployed_by,
            source=source_stage,
            status="deployed",
        )

        return {
            "message": "Promoted business process successfully",
            "bp": bp,
            "stage": target_stage,
            "deployment_ids": deployment_ids,
            "result": result,
        }

    async def changed_dev_members(self) -> list[dict]:
        """Return main-scope scanner dicts whose source differs from (or has
        no) deployed dev checksum.

        Includes NEW automations (no dev entry in bitswan.yaml) and CHANGED
        ones (merged-tree hash != stored checksum). Unchanged entries are
        skipped regardless of their `active` flag — only *changed* sources get
        (re)deployed, so an explicitly stopped dev automation isn't resurrected
        by an unrelated sync. Deleted sources (dev entry remains but the
        source dir is gone) are intentionally NOT auto-undeployed; they simply
        don't appear in the scan.

        Cheap: one bitswan.yaml read + one workspace scan + one tree hash per
        source. No image builds, no materialize, no docker, no git lock —
        for an unchanged source the fresh hash equals the stored checksum
        because prep's image-tag rewrite is idempotent and persisted in the
        workspace source.
        """
        sources = scan_workspace_sources(self.workspace_repo_dir, copy=None)
        bs_yaml = read_bitswan_yaml(self.gitops_dir) or {"deployments": {}}
        deployments = bs_yaml.get("deployments", {}) or {}
        bitswan_lib = os.path.join(self.workspace_repo_dir, "bitswan_lib")
        lib_dirs = [bitswan_lib] if os.path.isdir(bitswan_lib) else []

        changed: list[dict] = []
        for src in sources:
            dep_id = self.deployment_id_for(src, "dev")
            entry = deployments.get(dep_id)
            if entry is None:
                changed.append(src)  # new — never dev-deployed
                continue
            current = await calculate_git_tree_hash([src["source_path"]] + lib_dirs)
            if (entry or {}).get("checksum") != current:
                changed.append(src)
        return changed

    async def get_asset_diff(
        self, from_checksum: str, to_checksum: str, word_diff: bool = False
    ):
        """
        Compute a diff between two asset directories identified by checksum.
        Uses `git diff --no-index` which is read-only and requires no git lock.
        """
        import re

        # Validate checksums are hex strings of expected length
        hex_pattern = re.compile(r"^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$")
        if not hex_pattern.match(from_checksum):
            raise HTTPException(
                status_code=400,
                detail="Invalid from_checksum: must be a 40 or 64 character hex string",
            )
        if not hex_pattern.match(to_checksum):
            raise HTTPException(
                status_code=400,
                detail="Invalid to_checksum: must be a 40 or 64 character hex string",
            )

        # Early return if checksums are identical
        if from_checksum == to_checksum:
            return {
                "diff": "",
                "identical": True,
                "from_checksum": from_checksum,
                "to_checksum": to_checksum,
                "truncated": False,
            }

        # Determine paths based on HOST_PATH
        host_path = os.environ.get("HOST_PATH")
        if host_path:
            base_dir = self.gitops_dir_host
        else:
            base_dir = self.gitops_dir

        from_dir = os.path.join(base_dir, from_checksum)
        to_dir = os.path.join(base_dir, to_checksum)

        # Check directories exist (use local paths for existence check)
        from_dir_local = os.path.join(self.gitops_dir, from_checksum)
        to_dir_local = os.path.join(self.gitops_dir, to_checksum)

        if not os.path.isdir(from_dir_local):
            raise HTTPException(
                status_code=404,
                detail=f"Asset directory not found for checksum: {from_checksum}",
            )
        if not os.path.isdir(to_dir_local):
            raise HTTPException(
                status_code=404,
                detail=f"Asset directory not found for checksum: {to_checksum}",
            )

        # Build git diff command
        diff_args = ["git", "diff", "--no-index"]
        if word_diff:
            diff_args.append("--word-diff")
        diff_args.extend([from_dir, to_dir])

        stdout, stderr, return_code = await call_git_command_with_output(
            *diff_args, cwd=base_dir
        )

        # Exit codes: 0=identical, 1=diffs found, >1=error
        if return_code > 1:
            raise HTTPException(
                status_code=500,
                detail=f"Error computing diff: {stderr}",
            )

        identical = return_code == 0

        # Post-process: replace full directory paths with a/ and b/ prefixes
        diff_output = stdout
        diff_output = diff_output.replace(from_dir + "/", "a/")
        diff_output = diff_output.replace(to_dir + "/", "b/")
        diff_output = diff_output.replace(from_dir, "a")
        diff_output = diff_output.replace(to_dir, "b")

        # Truncate at 1MB
        max_size = 1 * 1024 * 1024
        truncated = len(diff_output) > max_size
        if truncated:
            diff_output = diff_output[:max_size]

        return {
            "diff": diff_output,
            "identical": identical,
            "from_checksum": from_checksum,
            "to_checksum": to_checksum,
            "truncated": truncated,
        }

    def download_asset(self, checksum: str) -> bytes:
        """
        Create a zip archive of the asset directory identified by checksum.
        Returns the zip bytes for streaming to the client.
        """
        import re
        import io

        hex_pattern = re.compile(r"^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$")
        if not hex_pattern.match(checksum):
            raise HTTPException(
                status_code=400,
                detail="Invalid checksum: must be a 40 or 64 character hex string",
            )

        asset_dir = os.path.join(self.gitops_dir, checksum)
        if not os.path.isdir(asset_dir):
            raise HTTPException(
                status_code=404,
                detail=f"Asset directory not found for checksum: {checksum}",
            )

        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tf:
            for root, _dirs, files in os.walk(asset_dir):
                for file in sorted(files):
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, asset_dir)
                    tf.add(file_path, arcname)

        return buf.getvalue()

    def list_assets(self):
        """
        List all assets (checksum directories) in the gitops directory.
        """
        assets = []
        if not os.path.exists(self.gitops_dir):
            return assets

        for item in os.listdir(self.gitops_dir):
            item_path = os.path.join(self.gitops_dir, item)
            # Check if it's a directory and looks like a checksum (hex string, typically 40 chars for SHA1)
            if (
                os.path.isdir(item_path)
                and (len(item) == 40 or len(item) == 64)
                and all(c in "0123456789abcdef" for c in item.lower())
            ):
                assets.append(
                    {
                        "checksum": item,
                        "path": item_path,
                        "exists": os.path.exists(item_path),
                    }
                )
        return assets

    async def _get_latest_commit_hash(self, bitswan_dir: str) -> str:
        """
        Get the latest commit hash (HEAD) from the git repository.
        """
        stdout, stderr, return_code = await call_git_command_with_output(
            "git",
            "rev-parse",
            "HEAD",
            cwd=bitswan_dir,
        )
        if return_code != 0:
            raise HTTPException(
                status_code=500, detail=f"Error getting latest commit hash: {stderr}"
            )
        return stdout.strip()

    async def _fetch_yaml_at_commit(
        self, commit_hash: str, bitswan_dir: str
    ) -> tuple[str, str | None]:
        stdout, stderr, rc = await call_git_command_with_output(
            "git", "show", f"{commit_hash}:bitswan.yaml", cwd=bitswan_dir
        )
        if rc != 0:
            return commit_hash, None
        return commit_hash, stdout

    async def get_automation_history(
        self, deployment_id: str, page: int = 1, page_size: int = 20
    ):
        """
        Get paginated history of automation changes from git.
        Only includes entries where there are actual changes to the automation.
        Cached responses are invalidated when the commit hash changes.
        """

        host_path = os.environ.get("HOST_PATH")
        if host_path:
            bitswan_dir = self.gitops_dir_host
        else:
            bitswan_dir = self.gitops_dir

        # Get the latest commit hash
        current_commit_hash = await self._get_latest_commit_hash(bitswan_dir)

        # Check cache - we cache the full history per deployment, not per page
        if deployment_id in self._history_cache:
            cached_commit_hash, cached_entries = self._history_cache[deployment_id]
            if cached_commit_hash == current_commit_hash:
                return self._paginate_history(cached_entries, page, page_size)
            else:
                self._history_cache.clear()

        # Get commits that modified bitswan.yaml
        log_format = '{"commit": "%H", "author": "%an", "author_email": "%ae", "date": "%ai", "message": "%s"}'
        stdout, stderr, return_code = await call_git_command_with_output(
            "git",
            "log",
            "--format=" + log_format,
            "--date=iso",
            "--",
            "bitswan.yaml",
            cwd=bitswan_dir,
        )

        if return_code != 0:
            raise HTTPException(
                status_code=500, detail=f"Error getting git history: {stderr}"
            )

        commits = []
        for line in stdout.strip().split("\n"):
            if not line.strip():
                continue
            try:
                commit_data = json.loads(line)
                commits.append(commit_data)
            except json.JSONDecodeError:
                continue

        # Process commits in batches — stop early when we have enough entries.
        # Only cache the result if we processed ALL commits (complete history).
        # For each commit, compare this deployment's config with the parent commit
        # to determine if THIS commit actually modified the deployment.
        entries_needed = page * page_size
        BATCH_SIZE = 20

        history_entries = []
        processed_all = True

        for batch_start in range(0, len(commits), BATCH_SIZE):
            batch = commits[batch_start : batch_start + BATCH_SIZE]

            # Fetch bitswan.yaml for each commit AND its parent in parallel
            fetch_tasks = []
            for c in batch:
                fetch_tasks.append(self._fetch_yaml_at_commit(c["commit"], bitswan_dir))
                fetch_tasks.append(
                    self._fetch_yaml_at_commit(c["commit"] + "^", bitswan_dir)
                )
            results = await asyncio.gather(*fetch_tasks)
            content_by_key = dict(results)

            for commit in batch:
                commit_hash = commit["commit"]
                content = content_by_key.get(commit_hash)
                if content is None:
                    continue

                try:
                    commit_yaml = yaml.safe_load(content)
                    if not commit_yaml or "deployments" not in commit_yaml:
                        continue

                    deployment_config = commit_yaml.get("deployments", {}).get(
                        deployment_id
                    )

                    if deployment_config is None:
                        continue

                    current_checksum = deployment_config.get("checksum")
                    current_replicas = deployment_config.get("replicas", 1)

                    # Compare with parent commit to see if THIS commit
                    # actually changed this deployment
                    parent_content = content_by_key.get(commit_hash + "^")
                    parent_checksum = None
                    parent_replicas = None
                    if parent_content:
                        try:
                            parent_yaml = yaml.safe_load(parent_content)
                            if parent_yaml and "deployments" in parent_yaml:
                                parent_config = parent_yaml.get("deployments", {}).get(
                                    deployment_id
                                )
                                if parent_config:
                                    parent_checksum = parent_config.get("checksum")
                                    parent_replicas = parent_config.get("replicas", 1)
                        except yaml.YAMLError:
                            pass

                    checksum_changed = current_checksum != parent_checksum
                    replicas_changed = current_replicas != parent_replicas

                    if checksum_changed or replicas_changed:
                        entry = {
                            "commit": commit_hash,
                            "author": commit["author"],
                            "author_email": commit.get("author_email"),
                            "date": commit["date"],
                            "message": commit["message"],
                            "checksum": current_checksum,
                            "stage": deployment_config.get("stage", "production"),
                            "relative_path": deployment_config.get("relative_path"),
                            "active": deployment_config.get("active"),
                            "tag_checksum": deployment_config.get("tag_checksum"),
                            "replicas": current_replicas,
                        }
                        history_entries.append(entry)

                except yaml.YAMLError:
                    continue

            # Early exit: we have enough entries for the requested page
            if len(history_entries) >= entries_needed:
                processed_all = (batch_start + BATCH_SIZE) >= len(commits)
                break

        # Only cache if we processed all commits (complete history)
        if processed_all:
            self._history_cache[deployment_id] = (
                current_commit_hash,
                history_entries,
            )

        return self._paginate_history(history_entries, page, page_size)

    @staticmethod
    def _paginate_history(entries: list, page: int, page_size: int) -> dict:
        total = len(entries)
        start = (page - 1) * page_size
        end = start + page_size
        return {
            "items": entries[start:end],
            "total": total,
            "page": page,
            "page_size": page_size,
            "total_pages": (total + page_size - 1) // page_size,
        }

    async def start_oauth2_proxy_in_container(self, deployment_id: str):
        """Start oauth2-proxy in all running containers for a deployment"""
        containers = await self.get_container(deployment_id)

        if not containers:
            return False

        success = True
        for container in containers:
            container_id = container.get("Id")
            labels = container.get("Labels", {})
            container_name = container.get("Names", [deployment_id])[0].lstrip("/")

            # Check if oauth2 is enabled via labels
            if labels.get("gitops.oauth2.enabled") != "true":
                continue

            # Ensure container is running
            state = container.get("State", "")
            if state != "running":
                print(
                    f"Warning: Container {container_name} is not running (status: {state}), cannot start oauth2-proxy"
                )
                success = False
                continue

            try:
                docker_client = get_async_docker_client()

                # Check if oauth2-proxy is already running to avoid duplicates
                if await is_oauth2_proxy_running(docker_client, container_id):
                    print(f"oauth2-proxy already running in container {container_name}")
                    continue

                # Copy oauth2-proxy binary into the container
                if not await copy_oauth2_proxy_to_container(
                    container_id, container_name
                ):
                    success = False
                    continue

                # Build the backend logout URL from the host's OIDC issuer URL
                logout_flag = ""
                issuer_url = os.environ.get("OAUTH2_PROXY_OIDC_ISSUER_URL", "").strip()
                if issuer_url:
                    logout_url = f"{issuer_url}/protocol/openid-connect/logout?id_token_hint={{id_token}}"
                    logout_flag = f" --backend-logout-url='{logout_url}'"

                # Start oauth2-proxy in the background
                print(f"Starting oauth2-proxy in container {container_name}")
                cmd = [
                    "sh",
                    "-c",
                    f"oauth2-proxy{logout_flag} > /tmp/oauth2-proxy.log 2>&1 &",
                ]
                exec_id = await docker_client.exec_create(container_id, cmd)
                await docker_client.exec_start(exec_id)
                exec_info = await docker_client.exec_inspect(exec_id)

                if exec_info.get("ExitCode", 0) == 0:
                    print(
                        f"Successfully started oauth2-proxy in container {container_name}"
                    )
                else:
                    print(f"Failed to start oauth2-proxy in container {container_name}")
                    success = False

            except Exception as e:
                print(
                    f"Exception while starting oauth2-proxy in container {container_name}: {str(e)}"
                )
                success = False

        return success

    async def _infra_services_to_bring_up(
        self, infra_service_names: list[str]
    ) -> list[str]:
        """Filter infra services so an already-present one is SHARED, not recreated.

        Shared infra (postgres/minio/…) is per-REALM and shared across every
        stage in that realm — notably ``dev`` and ``live-dev`` both map to the
        ``dev`` realm and therefore to the SAME fixed-named container
        (``{ws}__postgres-dev`` etc.). Once that container exists, every stage in
        the realm must REUSE it: re-listing it in ``docker compose up`` would try
        to recreate the fixed-name container and fail with
        ``Container … is already in use`` (the live-dev → dev collision).

        So we drop already-present infra from the up-list. A present-but-stopped
        container is started in place (never recreated). BP containers reach infra
        over ``bitswan_network`` by name and have no compose ``depends_on`` on it,
        so leaving it out of the up-list never strands a dependency.
        """
        if not infra_service_names:
            return []
        docker_client = get_async_docker_client()
        to_up: list[str] = []
        for svc_name in infra_service_names:
            container = f"{self.workspace_name}__{svc_name}"
            try:
                found = await docker_client.list_containers(
                    all=True, filters={"name": [container]}
                )
                match = next(
                    (c for c in found if f"/{container}" in (c.get("Names") or [])),
                    None,
                )
            except Exception as e:
                logger.warning(
                    f"Could not check infra container '{container}' ({e}); "
                    "letting compose manage it."
                )
                to_up.append(svc_name)
                continue
            if match is None:
                to_up.append(svc_name)  # absent → compose creates it
                continue
            if (match.get("State") or "").lower() != "running":
                # Present but stopped: start it in place rather than recreating.
                try:
                    await docker_client.start_container(match.get("Id") or container)
                    logger.info(
                        f"Shared infra '{container}' was stopped — started it "
                        "in place (not recreated)."
                    )
                except Exception as e:
                    logger.warning(
                        f"Could not start existing infra '{container}' ({e}); "
                        "letting compose manage it."
                    )
                    to_up.append(svc_name)
            else:
                logger.info(
                    f"Shared infra '{container}' already running — reusing it "
                    "(dev/live-dev share one container)."
                )
        return to_up

    async def start_oauth2_proxy_in_infra_services(
        self, infra_service_names: list[str]
    ):
        """Start oauth2-proxy in infra service containers that have oauth2 labels.

        Uses the same docker exec pattern as start_oauth2_proxy_in_container
        but operates on infra service containers (e.g., pgAdmin) identified by
        their compose service names.
        """
        from app.async_docker import get_async_docker_client

        if not infra_service_names:
            return

        docker_client = get_async_docker_client()

        for svc_name in infra_service_names:
            try:
                containers = await docker_client.list_containers(
                    filters={"label": [f"com.docker.compose.service={svc_name}"]}
                )
                for container in containers:
                    container_id = container.get("Id")
                    labels = container.get("Labels", {})
                    container_name = container.get("Names", [svc_name])[0].lstrip("/")

                    if labels.get("gitops.oauth2.enabled") != "true":
                        continue

                    state = container.get("State", "")
                    if state != "running":
                        logger.warning(
                            f"Container {container_name} not running, "
                            f"cannot start oauth2-proxy"
                        )
                        continue

                    upstream_url = labels.get("gitops.oauth2.upstream")
                    if not upstream_url:
                        continue

                    # Check if already running
                    if await is_oauth2_proxy_running(docker_client, container_id):
                        logger.info(f"oauth2-proxy already running in {container_name}")
                        continue

                    # Copy oauth2-proxy binary into the container
                    if not await copy_oauth2_proxy_to_container(
                        container_id, container_name
                    ):
                        continue

                    logger.info(
                        f"Starting oauth2-proxy in {container_name} "
                        f"(upstream: {upstream_url})"
                    )
                    cmd = [
                        "sh",
                        "-c",
                        f"oauth2-proxy --upstream={upstream_url} "
                        f"> /tmp/oauth2-proxy.log 2>&1 &",
                    ]
                    exec_id = await docker_client.exec_create(container_id, cmd)
                    await docker_client.exec_start(exec_id)

                    exec_info = await docker_client.exec_inspect(exec_id)
                    if exec_info.get("ExitCode", 0) == 0:
                        logger.info(f"oauth2-proxy started in {container_name}")
                    else:
                        logger.error(
                            f"Failed to start oauth2-proxy in {container_name}"
                        )

            except Exception as e:
                logger.error(
                    f"Exception starting oauth2-proxy for infra service {svc_name}: {e}"
                )

    async def install_certificates_in_container(self, deployment_id: str):
        """Install CA certificates in all running containers for a deployment"""
        containers = await self.get_container(deployment_id)

        if not containers:
            return False

        success = True
        for container in containers:
            container_id = container.get("Id")
            labels = container.get("Labels", {})
            container_name = container.get("Names", [deployment_id])[0].lstrip("/")

            # Check if certificate installation is enabled via labels
            if labels.get("gitops.certs.enabled") != "true":
                continue

            # Ensure container is running
            state = container.get("State", "")
            if state != "running":
                print(
                    f"Warning: Container {container_name} is not running (status: {state}), cannot install certificates"
                )
                success = False
                continue

            try:
                docker_client = get_async_docker_client()

                # Install certificates: copy from custom dir, rename .pem to .crt, and update
                cert_install_script = """
if [ -d /usr/local/share/ca-certificates/custom ]; then
    cp /usr/local/share/ca-certificates/custom/*.crt /usr/local/share/ca-certificates/ 2>/dev/null || true
    cp /usr/local/share/ca-certificates/custom/*.pem /usr/local/share/ca-certificates/ 2>/dev/null || true
    for f in /usr/local/share/ca-certificates/*.pem; do
        [ -f "$f" ] && mv "$f" "${f%.pem}.crt"
    done
    update-ca-certificates 2>&1 | grep -v "WARNING" || true
    echo "CA certificates installed successfully"
else
    echo "No custom CA certificates directory found"
fi
"""
                print(f"Installing CA certificates in container {container_name}")
                cmd = ["sh", "-c", cert_install_script]
                exec_id = await docker_client.exec_create(container_id, cmd)
                output = await docker_client.exec_start(exec_id)
                exec_info = await docker_client.exec_inspect(exec_id)

                if exec_info.get("ExitCode", 0) == 0:
                    print(
                        f"Successfully installed certificates in container {container_name}: {output.strip()}"
                    )
                else:
                    print(
                        f"Failed to install certificates in container {container_name}: {output.strip()}"
                    )
                    success = False

            except Exception as e:
                print(
                    f"Exception while installing certificates in container {container_name}: {str(e)}"
                )
                success = False

        return success

    async def delete_automation(self, deployment_id: str):
        # Drop the deployment from bitswan.yaml, then APPLY: the ingress reconcile
        # prunes the now-absent gitops route (it's no longer in the desired set).
        # No out-of-band remove-route — the route disappears because the file no
        # longer declares it.
        await self.remove_automation_from_bitswan(deployment_id)
        await update_git(self.gitops_dir, self.gitops_dir_host, deployment_id, "delete")
        self._apply_ingress()

        containers = await self.get_container(deployment_id)
        if containers:
            await self.remove_automation(deployment_id)
        return {
            "status": "success",
            "message": f"Deployment {deployment_id} deleted successfully",
        }

    async def get_tag(self, deployed_image: str):
        """Get the sha tag for a deployed image using async Docker client."""
        expected_prefix = f"{deployed_image}:sha"
        try:
            docker_client = get_async_docker_client()
            image = await docker_client.get_image(deployed_image)
            tags = image.get("RepoTags", []) or []
            for tag in tags:
                if tag.startswith(expected_prefix):
                    deployed_image_checksum_tag = tag[len(expected_prefix) :]
                    return deployed_image_checksum_tag
            return None
        except DockerError:
            return None

    def resolve_automation_config(self, deployment_conf: dict) -> "AutomationConfig":
        """Resolve AutomationConfig for a deployment from the canonical source.

        For live-dev: reads automation.toml from the workspace source directory.
        For promoted stages: reads from the gitops checksum directory, falling
        back to the workspace source when that blob tree is absent.
        Single source of truth — used by both deploy_automation (service auto-enable)
        and generate_docker_compose (container config).
        """
        stage = deployment_conf.get("stage", "production") or "production"
        relative_path = deployment_conf.get("relative_path", "")

        if stage == "live-dev" and relative_path:
            source_dir = os.path.join(self.workspace_repo_dir, relative_path)
        else:
            source = (
                deployment_conf.get("source") or deployment_conf.get("checksum") or ""
            )
            source_dir = os.path.join(self.gitops_dir, source) if source else ""

        if source_dir and os.path.exists(source_dir):
            return read_automation_config(source_dir)

        # Image-baked deploys carry the source INSIDE the image, so the
        # <gitops_dir>/<checksum>/ blob tree no longer exists. Config like
        # `expose`, `port` and `services` is stable across the bake, so read it
        # from the automation's workspace source rather than silently defaulting
        # to AutomationConfig() — which would un-expose frontends (no ingress
        # route, no automation_url → the dashboard shows a running frontend as
        # "Not deployed").
        if relative_path:
            ws_dir = os.path.join(self.workspace_repo_dir, relative_path)
            if os.path.exists(ws_dir):
                return read_automation_config(ws_dir)
        return AutomationConfig()

    async def deploy_automation(
        self,
        deployment_id: str,
        checksum: str | None = None,
        stage: str | None = None,
        relative_path: str | None = None,
        # Structured name components (for shortened hostnames/service names)
        automation_name: str | None = None,
        context: str | None = None,
        services: dict | None = None,
        replicas: int | None = None,
        deployed_by: str | None = None,
        progress_callback: Callable[..., Any] | None = None,
    ):
        async def _report(step: str, message: str):
            if progress_callback is not None:
                await progress_callback(step, message)

        os.environ["COMPOSE_PROJECT_NAME"] = self.workspace_name
        bs_yaml = read_bitswan_yaml(self.gitops_dir)

        # Initialize bitswan.yaml if it doesn't exist
        if not bs_yaml:
            bs_yaml = {"deployments": {}}
            bitswan_yaml_path = os.path.join(self.gitops_dir, "bitswan.yaml")
            with open(bitswan_yaml_path, "w") as f:
                dump_bitswan_yaml(bs_yaml, f)
            await update_git(
                self.gitops_dir,
                self.gitops_dir_host,
                deployment_id,
                "initialize",
                deployed_by=deployed_by,
            )

        await _report("updating_config", "Updating deployment configuration...")

        # First-deploy gating for per-BP databases (pre-write bitswan.yaml
        # check — see write_deployment_entries for the batched equivalent).
        from app.services.bp_databases import register_new_bps_for_members

        _existing_conf = bs_yaml.get("deployments", {}).get(deployment_id) or {}
        register_new_bps_for_members(
            bs_yaml,
            [
                {
                    "relative_path": relative_path
                    or _existing_conf.get("relative_path"),
                    "stage": (
                        stage
                        if stage is not None
                        else (_existing_conf.get("stage") or "production")
                    ),
                }
            ],
        )

        # Update bitswan.yaml with new parameters if provided
        has_updates = any(
            v is not None
            for v in [
                checksum,
                stage,
                relative_path,
                services,
                replicas,
            ]
        )
        if has_updates:
            deployments = bs_yaml.setdefault("deployments", {})

            # Clean up old-format copy entries for the same automation.
            # When the deployment ID format changes, old entries linger in
            # bitswan.yaml alongside the new ones.  Remove any other -copy-
            # live-dev entry that shares the same relative_path.
            if "-copy-" in deployment_id and stage == "live-dev" and relative_path:
                stale = [
                    k
                    for k, v in deployments.items()
                    if k != deployment_id
                    and "-copy-" in k
                    and k.endswith("-live-dev")
                    and (v or {}).get("relative_path") == relative_path
                ]
                for k in stale:
                    del deployments[k]

            if deployment_id not in deployments:
                deployments[deployment_id] = {}

            deployment_config = deployments[deployment_id]

            if checksum is not None:
                deployment_config["checksum"] = checksum

            if stage is not None:
                # Map production to empty string
                deployment_config["stage"] = "" if stage == "production" else stage

            if automation_name is not None:
                deployment_config["automation_name"] = automation_name
            if context is not None:
                deployment_config["context"] = context

            if relative_path is not None:
                deployment_config["relative_path"] = relative_path

            if services is not None:
                deployment_config["services"] = services
            if replicas is not None:
                deployment_config["replicas"] = replicas

            # Set active to True by default when deploying (unless explicitly set to False)
            if "active" not in deployment_config:
                deployment_config["active"] = True

            bitswan_yaml_path = os.path.join(self.gitops_dir, "bitswan.yaml")
            with open(bitswan_yaml_path, "w") as f:
                dump_bitswan_yaml(bs_yaml, f)

            await update_git(
                self.gitops_dir,
                self.gitops_dir_host,
                deployment_id,
                "deploy",
                deployed_by=deployed_by,
            )

            # Re-read to get updated config
            bs_yaml = read_bitswan_yaml(self.gitops_dir)

        # Auto-enable declared services for this deployment.
        deployment_conf = bs_yaml.get("deployments", {}).get(deployment_id, {}) or {}
        deploy_services = services or deployment_conf.get("services")
        deploy_stage = stage or deployment_conf.get("stage") or "production"
        if deploy_stage == "":
            deploy_stage = "production"

        if not deploy_services:
            auto_conf = self.resolve_automation_config(deployment_conf)
            if auto_conf.services:
                deploy_services = {
                    svc_name: {"enabled": svc_dep.enabled}
                    for svc_name, svc_dep in auto_conf.services.items()
                }

        if deploy_services:
            await _report("enabling_services", "Enabling declared services...")
            await self.enable_services(deploy_services, deploy_stage)

        # Remove stale live-dev entries that lack relative_path
        stale_live_devs = [
            k
            for k, v in bs_yaml.get("deployments", {}).items()
            if (v or {}).get("stage") == "live-dev"
            and not (v or {}).get("relative_path")
        ]
        if stale_live_devs:
            for k in stale_live_devs:
                logger.warning("Removing stale live-dev entry: %s", k)
                del bs_yaml["deployments"][k]
            bitswan_yaml_path = os.path.join(self.gitops_dir, "bitswan.yaml")
            with open(bitswan_yaml_path, "w") as f:
                dump_bitswan_yaml(bs_yaml, f)

        await _report(
            "generating_compose", "Generating docker-compose configuration..."
        )
        dc_yaml, infra_service_names, desired_routes = self.generate_docker_compose(
            bs_yaml
        )
        self._save_docker_compose(dc_yaml)
        reconcile_ingress(self.workspace_name, desired_routes)
        deployments = bs_yaml.get("deployments", {})

        dc_config = yaml.safe_load(dc_yaml)
        dep_conf = bs_yaml.get("deployments", {}).get(deployment_id, {})
        compose_service_name = make_hostname_label(
            self.workspace_name,
            dep_conf.get("automation_name", deployment_id),
            dep_conf.get("context", ""),
            dep_conf.get("stage", "production") or "production",
        )

        # deploy the automation and its infra services
        await _report("docker_compose_up", "Starting containers...")
        infra_to_up = await self._infra_services_to_bring_up(infra_service_names)
        deployment_result = await docker_compose_up(
            self.gitops_dir,
            dc_yaml,
            compose_service_name,
            extra_services=infra_to_up,
            progress_callback=_report,
        )
        await self._post_deploy_infra_services(bs_yaml)
        await self._provision_bp_databases(bs_yaml, [deployment_id])

        # record deployment in bitswan.yaml

        image_tag = None
        if compose_service_name in dc_config.get("services", {}):
            deployed_image = dc_config["services"][compose_service_name].get("image")
            image_tag = await self.get_tag(deployed_image)

        for result in deployment_result.values():
            if result["return_code"] != 0:
                raise HTTPException(
                    status_code=500,
                    detail=f"Error deploying services: \ndocker-compose:\n {dc_yaml}\n\nstdout:\n {result['stdout']}\nstderr:\n{result['stderr']}\n",
                )

        await _report("installing_certs", "Installing certificates...")
        await self.install_certificates_in_container(deployment_id)
        await _report("starting_oauth2_proxy", "Starting OAuth2 proxy...")
        await self.start_oauth2_proxy_in_container(deployment_id)
        await self.start_oauth2_proxy_in_infra_services(infra_service_names)

        if image_tag:
            await _report("storing_tags", "Recording image tag...")
            bs_yaml = read_bitswan_yaml(self.gitops_dir)
            if (
                bs_yaml
                and "deployments" in bs_yaml
                and deployment_id in bs_yaml["deployments"]
            ):
                bs_yaml["deployments"][deployment_id]["tag_checksum"] = image_tag

                bitswan_yaml_path = os.path.join(self.gitops_dir, "bitswan.yaml")
                with open(bitswan_yaml_path, "w") as f:
                    dump_bitswan_yaml(bs_yaml, f)

                await update_git(
                    self.gitops_dir,
                    self.gitops_dir_host,
                    deployment_id,
                    "deploy",
                    deployed_by=deployed_by,
                )

        # Make the just-applied deployment visible to GET /automations/ right
        # away. That listing reads a cache (see get_automations) which is
        # otherwise only refreshed by the inotify filesystem watcher in
        # lifespan.py. inotify doesn't fire on bind/overlay mounts in some
        # environments (notably Docker-in-Docker CI), so a successful deploy
        # would stay invisible to the listing until an unrelated event
        # triggered a refresh. Refresh explicitly so the listing is correct
        # regardless of the watcher — and so clients polling right after a
        # deploy never observe stale state.
        await self.refresh_all()

        return {
            "message": "Deployed services successfully",
            "deployments": list(deployments.get(deployment_id, {}).keys()),
            "result": deployment_result,
        }

    async def deploy_automations(self):
        os.environ["COMPOSE_PROJECT_NAME"] = self.workspace_name
        bs_yaml = read_bitswan_yaml(self.gitops_dir)

        # Initialize bitswan.yaml if it doesn't exist
        if not bs_yaml:
            bs_yaml = {"deployments": {}}
            bitswan_yaml_path = os.path.join(self.gitops_dir, "bitswan.yaml")
            with open(bitswan_yaml_path, "w") as f:
                dump_bitswan_yaml(bs_yaml, f)
            await update_git(self.gitops_dir, self.gitops_dir_host, "all", "initialize")

        active_deployments = self.get_active_automations()

        filtered_bs_yaml = {"deployments": active_deployments}

        # Auto-enable services for each active deployment.
        # Read from bitswan.yaml first, fall back to automation config on disk.
        for dep_id, dep_conf in active_deployments.items():
            if dep_conf is None:
                dep_conf = {}
                active_deployments[dep_id] = dep_conf
            dep_services = dep_conf.get("services")
            dep_stage = dep_conf.get("stage") or "production"
            if dep_stage == "":
                dep_stage = "production"

            if not dep_services and dep_stage != "live-dev":
                source = dep_conf.get("source") or dep_conf.get("checksum") or dep_id
                source_dir = os.path.join(self.gitops_dir, source)
                if os.path.exists(source_dir):
                    auto_conf = read_automation_config(source_dir)
                    if auto_conf.services:
                        dep_services = {
                            svc_name: {"enabled": svc_dep.enabled}
                            for svc_name, svc_dep in auto_conf.services.items()
                        }

            if dep_services:
                await self.enable_services(dep_services, dep_stage)

        dc_yaml, infra_names, desired_routes = self.generate_docker_compose(
            filtered_bs_yaml
        )
        self._save_docker_compose(dc_yaml)
        reconcile_ingress(self.workspace_name, desired_routes)
        deployments = active_deployments

        # deploy_automations starts all services (no filter), so infra services
        # are included automatically via --remove-orphans
        deployment_result = await docker_compose_up(self.gitops_dir, dc_yaml)
        await self._post_deploy_infra_services(filtered_bs_yaml)
        await self._provision_bp_databases(filtered_bs_yaml, list(deployments.keys()))

        for result in deployment_result.values():
            if result["return_code"] != 0:
                print(result["stdout"])
                print(result["stderr"])
                raise HTTPException(
                    status_code=500,
                    detail=f"Error deploying services: \nstdout:\n {result['stdout']}\nstderr:\n{result['stderr']}\n",
                )

        for deployment_id in deployments.keys():
            await self.install_certificates_in_container(deployment_id)
            await self.start_oauth2_proxy_in_container(deployment_id)
        await self.start_oauth2_proxy_in_infra_services(infra_names)

        return {
            "message": "Deployed services successfully",
            "deployments": list(deployments.keys()),
            "result": deployment_result,
        }

    async def scale_automation(self, deployment_id: str, replicas: int):
        """Scale an automation to the specified number of replicas."""
        os.environ["COMPOSE_PROJECT_NAME"] = self.workspace_name
        bs_yaml = read_bitswan_yaml(self.gitops_dir)

        if not bs_yaml or deployment_id not in bs_yaml.get("deployments", {}):
            raise HTTPException(
                status_code=404,
                detail=f"Deployment {deployment_id} not found",
            )

        deployment_config = bs_yaml["deployments"][deployment_id]
        stage = deployment_config.get("stage", "production")
        if stage == "":
            stage = "production"

        if stage == "live-dev":
            raise HTTPException(
                status_code=400,
                detail="Scaling is not supported for live-dev deployments",
            )

        deployment_config["replicas"] = replicas

        bitswan_yaml_path = os.path.join(self.gitops_dir, "bitswan.yaml")
        with open(bitswan_yaml_path, "w") as f:
            dump_bitswan_yaml(bs_yaml, f)

        # Commit with a descriptive message using GitLockContext
        async with GitLockContext(timeout=10.0):
            await call_git_command("git", "add", "bitswan.yaml", cwd=self.gitops_dir)
            await call_git_command(
                "git",
                "commit",
                "-m",
                f"scale deployment {deployment_id} to {replicas} replicas",
                cwd=self.gitops_dir,
            )
            await call_git_command("git", "push", cwd=self.gitops_dir)

        # Ensure infrastructure services are enabled/running
        deploy_services = deployment_config.get("services")
        if not deploy_services:
            source = (
                deployment_config.get("source")
                or deployment_config.get("checksum")
                or deployment_id
            )
            source_dir = os.path.join(self.gitops_dir, source)
            if os.path.exists(source_dir):
                auto_conf = read_automation_config(source_dir)
                if auto_conf.services:
                    deploy_services = {
                        svc_name: {"enabled": svc_dep.enabled}
                        for svc_name, svc_dep in auto_conf.services.items()
                    }
        if deploy_services:
            await self.enable_services(deploy_services, stage)

        # Regenerate docker-compose and deploy
        bs_yaml = read_bitswan_yaml(self.gitops_dir)
        dc_yaml, infra_service_names, desired_routes = self.generate_docker_compose(
            bs_yaml
        )
        self._save_docker_compose(dc_yaml)
        reconcile_ingress(self.workspace_name, desired_routes)

        dep_conf = bs_yaml.get("deployments", {}).get(deployment_id, {})
        compose_svc = make_hostname_label(
            self.workspace_name,
            dep_conf.get("automation_name", deployment_id),
            dep_conf.get("context", ""),
            dep_conf.get("stage", "production") or "production",
        )
        infra_to_up = await self._infra_services_to_bring_up(infra_service_names)
        deployment_result = await docker_compose_up(
            self.gitops_dir,
            dc_yaml,
            compose_svc,
            extra_services=infra_to_up,
        )
        await self._post_deploy_infra_services(bs_yaml)
        await self._provision_bp_databases(bs_yaml, [deployment_id])

        for result in deployment_result.values():
            if result["return_code"] != 0:
                raise HTTPException(
                    status_code=500,
                    detail=f"Error scaling deployment: \nstdout:\n {result['stdout']}\nstderr:\n{result['stderr']}\n",
                )

        # Run post-deploy hooks on all containers
        await self.install_certificates_in_container(deployment_id)
        await self.start_oauth2_proxy_in_container(deployment_id)
        await self.start_oauth2_proxy_in_infra_services(infra_service_names)

        return {
            "status": "success",
            "message": f"Scaled deployment {deployment_id} to {replicas} replicas",
            "replicas": replicas,
        }

    async def start_automation(self, deployment_id: str):
        """Start all containers for a deployment using async Docker client.

        If no container exists for the deployment, re-runs the full deploy
        flow (regenerate compose, docker compose up) to create it fresh.
        """
        containers = await self.get_container(deployment_id)

        if not containers:
            # No container found — check if the deployment exists in bitswan.yaml
            bs_yaml = read_bitswan_yaml(self.gitops_dir)
            deployments = bs_yaml.get("deployments", {}) if bs_yaml else {}
            if deployment_id not in deployments:
                raise HTTPException(
                    status_code=404,
                    detail=f"Deployment '{deployment_id}' not found in bitswan.yaml",
                )

            logger.info(
                "No container for %s, running deploy to create it", deployment_id
            )
            await self.deploy_automations()
            return {
                "status": "success",
                "message": f"Container for deployment {deployment_id} created and started",
            }

        docker_client = get_async_docker_client()
        for container in containers:
            container_id = container.get("Id")
            await docker_client.start_container(container_id)

        await self.install_certificates_in_container(deployment_id)
        await self.start_oauth2_proxy_in_container(deployment_id)

        return {
            "status": "success",
            "message": f"Container(s) for deployment {deployment_id} started successfully",
        }

    async def mark_as_inactive(self, deployment_id: str):
        """
        Mark the automation as inactive in bitswan.yaml
        and update git
        """
        bs_yaml = read_bitswan_yaml(self.gitops_dir)
        bs_yaml["deployments"][deployment_id]["active"] = False
        with open(os.path.join(self.gitops_dir, "bitswan.yaml"), "w") as f:
            dump_bitswan_yaml(bs_yaml, f)
        await update_git(
            self.gitops_dir, self.gitops_dir_host, deployment_id, "mark_as_inactive"
        )

    async def mark_as_active(self, deployment_id: str):
        """
        Mark the automation as active in bitswan.yaml
        and update git
        """
        bs_yaml = read_bitswan_yaml(self.gitops_dir)
        bs_yaml["deployments"][deployment_id]["active"] = True
        with open(os.path.join(self.gitops_dir, "bitswan.yaml"), "w") as f:
            dump_bitswan_yaml(bs_yaml, f)
        await update_git(
            self.gitops_dir, self.gitops_dir_host, deployment_id, "mark_as_active"
        )

    async def remove_automation_from_bitswan(self, deployment_id: str):
        """
        Remove the automation from bitswan.yaml
        and update git
        """
        bs_yaml = read_bitswan_yaml(self.gitops_dir)

        if deployment_id not in bs_yaml["deployments"]:
            return

        bs_yaml["deployments"].pop(deployment_id)
        with open(os.path.join(self.gitops_dir, "bitswan.yaml"), "w") as f:
            dump_bitswan_yaml(bs_yaml, f)
        await update_git(self.gitops_dir, self.gitops_dir_host, deployment_id, "remove")

    # get active automations from bitswan.yaml
    def get_active_automations(self):
        """
        Get the active automations from bitswan.yaml
        """
        bs_yaml = read_bitswan_yaml(self.gitops_dir)
        active_deployments = {}
        for deployment_id, config in bs_yaml["deployments"].items():
            if config.get("active", False):
                active_deployments[deployment_id] = config
        return active_deployments

    async def stop_automation(self, deployment_id: str):
        """Stop all containers for a deployment using async Docker client."""
        containers = await self.get_container(deployment_id)

        if not containers:
            raise HTTPException(
                status_code=404,
                detail=f"No container found for deployment ID: {deployment_id}",
            )

        docker_client = get_async_docker_client()
        for container in containers:
            container_id = container.get("Id")
            await docker_client.stop_container(container_id)

        await self.mark_as_inactive(deployment_id)

        return {
            "status": "success",
            "message": f"Container(s) for deployment {deployment_id} stopped successfully",
        }

    async def restart_automation(self, deployment_id: str):
        """Restart all containers for a deployment using async Docker client.

        If no container exists for the deployment, re-runs the full deploy
        flow (regenerate compose, docker compose up) to create it fresh.
        """
        containers = await self.get_container(deployment_id)

        if not containers:
            # No container found — check if the deployment exists in bitswan.yaml
            bs_yaml = read_bitswan_yaml(self.gitops_dir)
            deployments = bs_yaml.get("deployments", {}) if bs_yaml else {}
            if deployment_id not in deployments:
                raise HTTPException(
                    status_code=404,
                    detail=f"Deployment '{deployment_id}' not found in bitswan.yaml",
                )

            # Deployment exists but container is missing — start it fresh
            logger.info(
                "No container for %s, running deploy to create it", deployment_id
            )
            await self.deploy_automations()
            return {
                "status": "success",
                "message": f"Container for deployment {deployment_id} created and started",
            }

        docker_client = get_async_docker_client()
        for container in containers:
            container_id = container.get("Id")
            await docker_client.restart_container(container_id)

        await self.install_certificates_in_container(deployment_id)
        await self.start_oauth2_proxy_in_container(deployment_id)

        return {
            "status": "success",
            "message": f"Container(s) for deployment {deployment_id} restarted successfully",
        }

    async def activate_automation(self, deployment_id: str):
        await self.mark_as_active(deployment_id)

        # update git
        await update_git(
            self.gitops_dir, self.gitops_dir_host, deployment_id, "activate"
        )

        result = await self.deploy_automation(deployment_id)

        return result

    async def deactivate_automation(self, deployment_id: str):
        await self.mark_as_inactive(deployment_id)

        # update git
        await update_git(
            self.gitops_dir, self.gitops_dir_host, deployment_id, "deactivate"
        )

        await self.remove_automation(deployment_id)

        return {
            "status": "success",
            "message": f"Deployment {deployment_id} deactivated successfully",
        }

    async def stream_automation_logs(
        self, deployment_id: str, lines: int = 200, since: int = 0
    ):
        """Stream container logs as SSE events (async generator).

        Yields SSE-formatted strings:
          event: metadata  — replica count, container info
          event: log       — {replica, line} for each log line
          event: error     — per-replica errors
          event: end       — all streams finished
          : keepalive      — periodic to keep connection alive
        """
        containers = await self.get_container(deployment_id)

        if not containers:
            yield f"event: error\ndata: {json.dumps({'message': 'No containers found'})}\n\n"
            yield "event: end\ndata: {}\n\n"
            return

        multiple = len(containers) > 1
        metadata = {
            "replicas": len(containers),
            "containers": [
                {
                    "id": c.get("Id", "")[:12],
                    "name": (c.get("Names") or ["unknown"])[0].lstrip("/"),
                    "state": c.get("State", "unknown"),
                }
                for c in containers
            ],
        }
        yield f"event: metadata\ndata: {json.dumps(metadata)}\n\n"

        docker_client = get_async_docker_client()
        queue: asyncio.Queue = asyncio.Queue()
        active_tasks = len(containers)

        async def read_replica(index: int, container_id: str):
            nonlocal active_tasks
            try:
                async for stream, line in docker_client.stream_container_logs(
                    container_id, tail=lines, since=since
                ):
                    prefix = f"[replica-{index}] " if multiple else ""
                    await queue.put(
                        f"event: log\ndata: {json.dumps({'replica': index, 'line': prefix + line, 'stream': stream})}\n\n"
                    )
            except Exception as e:
                await queue.put(
                    f"event: error\ndata: {json.dumps({'replica': index, 'message': str(e)})}\n\n"
                )
            finally:
                active_tasks -= 1
                await queue.put(None)  # sentinel

        tasks = []
        for i, container in enumerate(containers):
            container_id = container.get("Id")
            tasks.append(asyncio.create_task(read_replica(i, container_id)))

        sentinels_received = 0
        keepalive_interval = 30
        while sentinels_received < len(containers):
            try:
                item = await asyncio.wait_for(queue.get(), timeout=keepalive_interval)
                if item is None:
                    sentinels_received += 1
                    continue
                yield item
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"

        yield "event: end\ndata: {}\n\n"

        for task in tasks:
            task.cancel()

    async def remove_automation(self, deployment_id: str):
        """Remove all containers for a deployment using async Docker client."""
        containers = await self.get_container(deployment_id)

        if not containers:
            raise HTTPException(
                status_code=404,
                detail=f"No container found for deployment ID: {deployment_id}",
            )

        docker_client = get_async_docker_client()
        for container in containers:
            container_id = container.get("Id")
            await docker_client.stop_container(container_id)
            await docker_client.remove_container(container_id)

        return {
            "status": "success",
            "message": f"Container(s) for deployment {deployment_id} removed successfully",
        }

    async def pull_and_deploy(self, branch_name: str):
        await copy_worktree(branch_name)

        bs_yaml = read_bitswan_yaml(self.gitops_dir)
        if not bs_yaml or "deployments" not in bs_yaml:
            raise HTTPException(
                status_code=404, detail="No deployments found in bitswan.yaml"
            )

        active_deployments = self.get_active_automations()
        image_tags = []

        for deployment_id, config in active_deployments.items():
            tag_checksum = config.get("tag_checksum")
            if not tag_checksum:
                continue

            images_root_dir = os.path.join(self.gitops_dir, "images", tag_checksum)
            source_dir = os.path.join(images_root_dir, "src")
            if not os.path.exists(source_dir):
                source_dir = images_root_dir

            if not os.path.exists(source_dir):
                continue

            image_service = ImageService()

            # Build fully disambiguated image tag from structured components
            auto_name = config.get("automation_name", deployment_id)
            context = config.get("context", "")
            full_image_tag = (
                f"{self.workspace_name}-{context}-{auto_name}"
                if context
                else f"{self.workspace_name}-{auto_name}"
            )

            result = await image_service.create_image(
                image_tag=full_image_tag,
                build_context_path=source_dir,
                checksum=tag_checksum,
            )
            image_tags.append(result["tag"])

        return {
            "status": "success",
            "message": f"Successfully synced branch {branch_name} and processed automations",
            "image_tags": image_tags,
        }

    def add_keycloak_redirect_uri(self, redirect_uri: str):
        """Add a redirect URI to the workspace's Keycloak client"""
        if not self.workspace_id:
            print(
                f"Warning: Workspace {self.workspace_name} is missing an ID, skipping Keycloak redirect URI registration"
            )
            return None
        if not self.aoc_url or not self.aoc_token:
            print(
                "Warning: AOC URL or token not configured, skipping Keycloak redirect URI registration"
            )
            return None

        url = f"{self.aoc_url}/api/automation_server/workspaces/{self.workspace_id}/keycloak/add-redirect-uri/"

        headers = {
            "Authorization": f"Bearer {self.aoc_token}",
            "Content-Type": "application/json",
        }
        payload = {"redirect_uri": redirect_uri.strip()}

        try:
            response = requests.post(url, headers=headers, json=payload, timeout=30)
            if response.status_code == 200:
                result = response.json()
                return result
            else:
                error_detail = (
                    f"Keycloak API error: {response.status_code} - {response.text}"
                )
                print(
                    f"Warning: Failed to add redirect URI to Keycloak: {error_detail}"
                )
                return None
        except Exception as e:
            print(f"Warning: Exception while adding redirect URI to Keycloak: {str(e)}")
            return None

    def get_or_create_public_client(
        self,
        client_id: str,
        redirect_uri: str,
        web_origins: list[str] | None = None,
    ):
        """
        Get or create a public Keycloak client for frontend apps.

        Args:
            client_id: The client ID for the public client
            redirect_uri: The redirect URI for this deployment
            web_origins: List of allowed CORS origins for the client

        Returns:
            dict with client_id, issuer_url, etc. or None if failed
        """
        if not self.workspace_id:
            print(
                f"Warning: Workspace {self.workspace_name} is missing an ID, skipping public client creation"
            )
            return None
        if not self.aoc_url or not self.aoc_token:
            print(
                "Warning: AOC URL or token not configured, skipping public client creation"
            )
            return None

        url = f"{self.aoc_url}/api/automation_server/workspaces/{self.workspace_id}/keycloak/public-client/"

        headers = {
            "Authorization": f"Bearer {self.aoc_token}",
            "Content-Type": "application/json",
        }
        payload = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
        }

        if web_origins:
            payload["web_origins"] = web_origins

        try:
            response = requests.post(url, headers=headers, json=payload, timeout=30)
            if response.status_code == 200:
                result = response.json()
                print(f"Successfully got/created public client: {client_id}")
                return result
            else:
                error_detail = (
                    f"Keycloak API error: {response.status_code} - {response.text}"
                )
                print(f"Warning: Failed to get/create public client: {error_detail}")
                return None
        except Exception as e:
            print(f"Warning: Exception while getting/creating public client: {str(e)}")
            return None

    async def _post_deploy_infra_services(self, bs_yaml: dict) -> None:
        """Call post-start init hooks for infra services after docker-compose up."""
        from app.services.infra_service import get_service, stage_for_deployment

        seen: set[tuple[str, str]] = set()
        for dep_conf in bs_yaml.get("deployments", {}).values():
            dep_conf = dep_conf or {}
            dep_stage = dep_conf.get("stage") or "production"
            mapped_stage = stage_for_deployment(dep_stage)
            for svc_type, svc_conf in (dep_conf.get("services") or {}).items():
                enabled = (
                    svc_conf.get("enabled", True)
                    if isinstance(svc_conf, dict)
                    else bool(svc_conf)
                )
                if not enabled or (svc_type, mapped_stage) in seen:
                    continue
                seen.add((svc_type, mapped_stage))
                try:
                    svc = get_service(svc_type, self.workspace_name, stage=mapped_stage)
                except ValueError:
                    continue
                if hasattr(svc, "initialize"):
                    try:
                        await svc.initialize()
                    except Exception as e:
                        logger.warning(
                            f"Post-deploy init for {svc.display_name} failed: {e}"
                        )

    async def _provision_bp_databases(
        self, bs_yaml: dict | None, deployment_ids: list[str]
    ) -> None:
        """Create per-BP logical databases for registered BPs after compose-up.

        Runs after `_post_deploy_infra_services` so the stage's service
        containers exist. Best-effort — the registry retries unprovisioned
        services on the next deploy.
        """
        from app.services.bp_databases import provision_for_deployments

        await provision_for_deployments(self.workspace_name, bs_yaml, deployment_ids)

    def get_org_group_path(self):
        """Fetch the Keycloak org group path for this workspace from AOC.

        Returns the group path string (e.g. "/Example Org"), or None if AOC
        is not configured (non-AOC deployments skip group-path resolution).
        Raises HTTPException if AOC is configured but the call fails.
        """
        if not self.workspace_id or not self.aoc_url or not self.aoc_token:
            return None

        url = f"{self.aoc_url}/api/automation_server/workspaces/{self.workspace_id}/keycloak/org-group-path/"
        headers = {"Authorization": f"Bearer {self.aoc_token}"}

        try:
            response = requests.get(url, headers=headers, timeout=30)
            if response.status_code == 200:
                group_path = response.json().get("group_path")
                if not group_path:
                    raise HTTPException(
                        status_code=500,
                        detail="AOC returned empty org group path",
                    )
                print(f"Got org group path: {group_path}")
                return group_path
            else:
                raise HTTPException(
                    status_code=500,
                    detail=f"Failed to get org group path: {response.status_code} - {response.text}",
                )
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Exception fetching org group path: {e}",
            )

    async def enable_services(self, services: dict, stage: str) -> None:
        """Auto-enable infrastructure services for a specific deployment.

        Takes the services dict (e.g. {"kafka": {"enabled": true}}) and the
        deployment stage, and enables any declared services that aren't already
        running.
        """
        from app.services.infra_service import get_service, stage_for_deployment

        mapped_stage = stage_for_deployment(stage)

        for svc_type, svc_conf in services.items():
            enabled = (
                svc_conf.get("enabled", True)
                if isinstance(svc_conf, dict)
                else bool(svc_conf)
            )
            if not enabled:
                continue

            try:
                svc = get_service(svc_type, self.workspace_name, stage=mapped_stage)
            except ValueError:
                logger.warning(
                    f"Unknown service type '{svc_type}', skipping auto-enable"
                )
                continue

            if not svc.is_enabled():
                logger.info(
                    f"Auto-enabling {svc.display_name} for workspace '{self.workspace_name}'"
                )
                try:
                    await svc.enable()
                except Exception as e:
                    logger.error(f"Failed to auto-enable {svc.display_name}: {e}")
            else:
                running = await svc.is_running()
                if not running:
                    logger.warning(
                        f"{svc.display_name} is enabled but not running — "
                        f"attempting to start container"
                    )
                    try:
                        await svc.start()
                        logger.info(f"{svc.display_name} started successfully")
                    except Exception:
                        # Container may have been removed entirely;
                        # docker-compose up will recreate it.
                        logger.info(
                            f"Could not start {svc.display_name} container "
                            f"(may have been removed) — docker-compose up will recreate it"
                        )
                        # Re-register with ingress in case route was lost
                        try:
                            await svc._register_with_caddy()
                        except Exception as e:
                            logger.warning(
                                f"Failed to re-register {svc.display_name} with ingress: {e}"
                            )

    def _resolve_service_secrets(
        self, automation_config: AutomationConfig, stage: str
    ) -> list[str]:
        """Resolve service dependencies and return list of secret file names to inject.

        Uses the deployment's own stage to determine the service realm
        (live-dev maps to dev). Returns the corresponding secrets file names
        (e.g., 'kafka-dev', 'couchdb-production').
        """
        if not automation_config.services:
            return []

        from app.services.infra_service import get_service, stage_for_deployment

        mapped_stage = stage_for_deployment(stage)

        secret_names = []
        for svc_type, svc_dep in automation_config.services.items():
            if not svc_dep.enabled:
                continue

            try:
                svc = get_service(svc_type, self.workspace_name, stage=mapped_stage)
            except ValueError:
                logger.warning(f"Unknown service type '{svc_type}', skipping")
                continue

            secret_names.append(svc.secrets_file_name)
            logger.info(
                f"Service dependency: {svc.display_name} -> secrets '{svc.secrets_file_name}'"
            )

        return secret_names

    def generate_docker_compose(self, bs_yaml: dict):
        """Render the workspace docker-compose from bitswan.yaml — PURE: no
        daemon/docker side effects.

        Returns `(dc_yaml, infra_service_names, desired_routes)`. `desired_routes`
        is the COMPLETE set of gitops-managed ingress routes the workspace should
        have (one per exposed automation, expanded per blue-green slot with the
        stable `-production`/`-dr` hosts) — a deterministic function of
        bitswan.yaml. The caller passes it to `reconcile_ingress`, which converges
        the daemon to match (the single place ingress is applied). Generation no
        longer talks to the daemon, so it can be called freely and the apply step
        is an idempotent reconcile of the file.
        """
        from app.services.bp_databases import (
            bp_resource_names,
            derive_bp_and_copy,
            is_registered,
            load_registry,
        )
        from app.services.infra_service import stage_for_deployment

        # Per-BP database registry, loaded once per compose generation.
        # Unreadable registry degrades to "no BP is provisioned" for env
        # injection only (provisioning paths fail loudly instead).
        try:
            bp_registry = load_registry()
        except Exception as e:
            logger.warning(
                "BP database registry unreadable, skipping per-BP env injection: %s",
                e,
            )
            bp_registry = {"version": 1, "bps": {}}

        dc = {
            "version": "3",
            "services": {},
        }
        external_networks = {"bitswan_network"}
        deployments = bs_yaml.get("deployments", {})
        # The desired ingress route set, collected as we emit services. Returned
        # to the caller, which reconciles the daemon to it — no route is applied
        # here. Each exposed automation/slot contributes exactly one route.
        desired_routes: list[dict] = []

        # Worker-host discovery: every worker container (expose=false) in a
        # business process is reachable by that BP's frontends and peer
        # workers on the private Docker network. Build a `name=host:port`
        # list per (context, stage) and inject it as BITSWAN_WORKER_HOSTS so
        # the frontend shim can proxy /api to the worker named "backend" and
        # any container can reach the others. Scoped per BP+stage so business
        # processes stay isolated. The association is explicit data, not a
        # hostname guessed at runtime.
        # Egress-firewall pre-pass: which (ctx, stage) groups route their worker
        # containers through a per-group egress gateway. Opt-in — only BPs that
        # have a `firewall` node for the realm are affected (zero change
        # otherwise), EXCEPT the dev realm which observes by default (see below).
        # The Development stage is deployed as `live-dev` (the bind-mounted edit
        # loop), which is intentionally NOT routed through a gateway (see the skip
        # in the loop below) — so live dev egress observation is a known gap, not
        # wired here. Regular `dev`/staging/production groups participate normally.
        # Workers with replicas>1 can't share one netns, so the gateway is
        # disabled for that group (logged) rather than silently leaving a hole
        # half-applied.
        # Blue-green production: a production deployment is emitted once per
        # ACTIVE app slot (a/b/c), each wired to its own logical DB (1/2), per
        # the BP's `backups` wiring. Non-production deployments are a single
        # (slot=None, db=None) backend, byte-identical to before. The idle slot
        # (the zero-downtime-promote buffer) is simply not in the wiring, so it
        # emits no containers. Every slot dimension below keys off this.
        def _slot_db_pairs(_conf: dict) -> list[tuple[str | None, int | None]]:
            st = _conf.get("stage", "production") or "production"
            if st != "production":
                return [(None, None)]
            bp_slug, _ = derive_bp_and_copy(_conf.get("relative_path"))
            if not bp_slug:
                return [(None, None)]
            rec = (bs_yaml.get("backups") or {}).get(bp_slug) or {}
            slots = rec.get("slots") or {"a": {"db": 1}, "b": {"db": 2}}
            pairs = [
                (s, int((slots[s] or {}).get("db")))
                for s in AutomationService.APP_SLOTS
                if slots.get(s) and (slots[s] or {}).get("db")
            ]
            return pairs or [(None, None)]

        def _live_slot_for(_conf: dict) -> str:
            bp_slug, _ = derive_bp_and_copy(_conf.get("relative_path"))
            rec = (bs_yaml.get("backups") or {}).get(bp_slug or "") or {}
            slots = rec.get("slots") or {"a": {"db": 1}, "b": {"db": 2}}
            live_db = int(rec.get("live_db") or 1)
            return rec.get("live_slot") or next(
                (s for s, m in slots.items() if (m or {}).get("db") == live_db), "a"
            )

        def _dr_slot_for(_conf: dict) -> str | None:
            """The standby (DR) slot — the active slot wired to the non-live db."""
            bp_slug, _ = derive_bp_and_copy(_conf.get("relative_path"))
            rec = (bs_yaml.get("backups") or {}).get(bp_slug or "") or {}
            slots = rec.get("slots") or {"a": {"db": 1}, "b": {"db": 2}}
            live_db = int(rec.get("live_db") or 1)
            standby_db = 2 if live_db == 1 else 1
            live = _live_slot_for(_conf)
            return next(
                (
                    s
                    for s, m in slots.items()
                    if (m or {}).get("db") == standby_db and s != live
                ),
                None,
            )

        fw_scope: dict[tuple[str, str, str | None], dict] = {}
        for _dep_id, _conf in deployments.items():
            if not _conf:
                continue
            _stage = _conf.get("stage", "production") or "production"
            _ctx = _conf.get("context", "")
            _realm = bp_secrets.realm_for_stage(_stage)
            # Firewall RULES / attempts telemetry are keyed by the canonical BP
            # slug (the same key the dashboard's Firewall tab and the audit log in
            # bitswan.yaml use), NOT by the deployment `context`. They coincide for
            # the regular dev/staging/production deployments (context == bp slug),
            # but a COPY's context is `copy-<who>-<bp>` while its firewall scope is
            # still the BP. live-dev (the Development bind-mount edit loop) is a
            # copy deployment, so without this it would log to a `copy-…` attempts
            # file the dashboard never reads and consult a `copy-…` allow-list the
            # operator never edits — the egress would be observed but invisible.
            _bp, _ = derive_bp_and_copy(_conf.get("relative_path"))
            _fw_key = _bp or _ctx
            fwnode = ((bs_yaml.get("firewall") or {}).get(_fw_key) or {}).get(_realm)
            # Dev OBSERVES egress by default. The dev realm's posture is monitor
            # (observe + log, never block), so we stand up its gateway even with
            # NO firewall node yet — otherwise egress could never be observed at
            # all (you can't review a host the gateway never saw, and you can't
            # get a gateway without first having a rule: a bootstrap deadlock).
            # With a default monitor gateway, dev egress surfaces under "Needs
            # review" and the operator approves it into a real allow-list + GDPR
            # record. Monitor mode changes NO traffic, so this is zero-risk.
            # Enforcing realms (staging/production) still require an explicit
            # firewall node — they BLOCK, so they must be opted into deliberately.
            # The Development stage runs as `live-dev` (realm dev → monitor), so it
            # observes here too; its worker depends_on the gateway being healthy so
            # the bind-mount edit loop stays fast and reliable (see emission below).
            if not fwnode and firewall_service.posture_for(_realm) != "monitor":
                continue
            for _slot, _db in _slot_db_pairs(_conf):
                key = (_ctx, _stage, _slot)
                fw = fw_scope.setdefault(
                    key,
                    {
                        # Each slot gets its OWN egress gateway so two slots'
                        # workers never collide in one netns. The gateway hostname
                        # stays context-scoped so distinct copies of the same BP
                        # never share a netns.
                        "gw": make_hostname_label(
                            self.workspace_name, "fwgw", _ctx, _stage, _slot
                        ),
                        "mode": (fwnode or {}).get("posture")
                        or firewall_service.posture_for(_realm),
                        "allow": firewall_service.allowed_hosts(
                            bs_yaml, _fw_key, _realm
                        ),
                        "realm": _realm,
                        # BP-slug key for the attempts feed (dashboard-readable).
                        "bp": _fw_key,
                        "ok": True,
                    },
                )
                if (_conf.get("replicas") or 1) > 1:
                    fw["ok"] = False
                    logger.warning(
                        "firewall: %s/%s has a replicas>1 member; egress gateway "
                        "disabled for this group (shared netns can't host replicas)",
                        _ctx,
                        _realm,
                    )

        def _fw_active(ctx: str, stage: str, slot: str | None) -> dict | None:
            fw = fw_scope.get((ctx, stage, slot))
            return fw if fw and fw["ok"] else None

        worker_hosts_by_scope: dict[tuple[str, str, str | None], list[str]] = {}
        for _dep_id, _conf in deployments.items():
            if not _conf:
                continue
            _stage = _conf.get("stage", "production") or "production"
            _name = _conf.get("automation_name", _dep_id)
            _ctx = _conf.get("context", "")
            try:
                _cfg = self.resolve_automation_config(_conf)
            except Exception:
                continue
            if _cfg.expose:
                continue  # frontends are not workers
            for _slot, _db in _slot_db_pairs(_conf):
                # Same-slot discovery: slot 'a' frontend reaches slot 'a'
                # backend. When firewalled, the worker lives in its slot's
                # gateway netns, so peers reach it at the gateway's hostname.
                _fw = _fw_active(_ctx, _stage, _slot)
                _host = (
                    _fw["gw"]
                    if _fw
                    else make_hostname_label(
                        self.workspace_name, _name, _ctx, _stage, _slot
                    )
                )
                worker_hosts_by_scope.setdefault((_ctx, _stage, _slot), []).append(
                    f"{_name}={_host}:{_cfg.port}"
                )

        work_items = [
            (deployment_id, conf, slot, db)
            for deployment_id, conf in deployments.items()
            for slot, db in _slot_db_pairs(conf or {})
        ]
        for deployment_id, conf, slot, db in work_items:
            if conf is None:
                conf = {}
                deployments[deployment_id] = conf

            dep_stage = conf.get("stage", "production") or "production"
            dep_automation_name = conf.get("automation_name", deployment_id)
            dep_context = conf.get("context", "")
            service_name = make_hostname_label(
                self.workspace_name, dep_automation_name, dep_context, dep_stage, slot
            )
            # Slot-distinct deployment identity so each production slot's
            # containers are individually addressable in labels/introspection.
            slot_deployment_id = f"{deployment_id}@{slot}" if slot else deployment_id

            entry = {}

            source = conf.get("source") or conf.get("checksum") or deployment_id
            source_dir = os.path.join(self.gitops_dir, source)

            # For live-dev with relative_path, use workspace directory for config
            stage = conf.get("stage", "production")
            if stage == "":
                stage = "production"
            relative_path = conf.get("relative_path")

            automation_config = self.resolve_automation_config(conf)
            if stage == "live-dev" and not automation_config.image:
                continue
            elif stage == "live-dev" and not relative_path:
                raise HTTPException(
                    status_code=500,
                    detail=f"Live-dev deployment {deployment_id} is missing relative_path",
                )
            elif (
                stage != "live-dev"
                and not conf.get("image")
                and not os.path.exists(source_dir)
            ):
                # Only the legacy materialize-and-mount path needs the
                # `<gitops_dir>/<checksum>/` tree on disk. Image-baked
                # deployments carry their source INSIDE the image, so the
                # directory is intentionally absent — don't fail on it.
                raise HTTPException(
                    status_code=500,
                    detail=f"Deployment directory {source_dir} does not exist",
                )
            # Ensure services from automation config on disk are reflected in
            # the deployment conf so _merge_infra_services() can discover them.
            # Without this, promoted deployments (dev/staging/production) whose
            # bitswan.yaml entry lacks a "services" key would be invisible to
            # the infra-service merge step, and their Kafka/CouchDB/etc.
            # containers could be removed as orphans.
            if automation_config.services and not conf.get("services"):
                conf["services"] = {
                    svc_name: {"enabled": svc_dep.enabled}
                    for svc_name, svc_dep in automation_config.services.items()
                }

            # The LIVE slot (and every non-production deployment) keeps the
            # canonical deployment_id so existing introspection / history /
            # member views resolve it unchanged; non-live slots (DR, staging)
            # carry a slot-suffixed id. live_slot can change on a swap without a
            # redeploy — the next compose-gen re-asserts this mapping.
            is_live_slot = slot is None or slot == _live_slot_for(conf)
            effective_dep_id = deployment_id if is_live_slot else slot_deployment_id

            entry["environment"] = {"DEPLOYMENT_ID": effective_dep_id}
            replicas = conf.get("replicas", 1)
            if replicas <= 1:
                entry["container_name"] = f"{service_name}"
            entry["restart"] = "always"
            entry["ulimits"] = {"nofile": {"soft": 65536, "hard": 65536}}
            entry["labels"] = {
                "gitops.deployment_id": effective_dep_id,
                "gitops.workspace": self.workspace_name,
                "gitops.automation_name": dep_automation_name,
                "gitops.context": dep_context,
                "gitops.stage": dep_stage,
                "gitops.slot": slot or "",
                "gitops.intended_exposed": "false",
            }
            entry["image"] = "bitswan/pipeline-runtime-environment:latest"

            # Set BITSWAN environment variables (stage already determined above)
            if "environment" not in entry:
                entry["environment"] = {}
            entry["environment"]["BITSWAN_AUTOMATION_STAGE"] = stage
            entry["environment"]["BITSWAN_DEPLOYMENT_ID"] = effective_dep_id

            # Private worker containers reachable by this BP (see the
            # worker-host pre-pass). Frontends proxy /api to the "backend"
            # entry; any container can reach peers by name. Slot-scoped so a
            # slot's frontend only ever sees its OWN slot's workers.
            _worker_hosts = worker_hosts_by_scope.get(
                (dep_context, dep_stage, slot), []
            )
            if _worker_hosts:
                entry["environment"]["BITSWAN_WORKER_HOSTS"] = ",".join(_worker_hosts)
            if self.workspace_name:
                entry["environment"]["BITSWAN_WORKSPACE_NAME"] = self.workspace_name
            if self.gitops_domain:
                entry["environment"]["BITSWAN_GITOPS_DOMAIN"] = self.gitops_domain
            # Deployment context for service discovery.
            # Context = {bp}-copy-{copy}-{stage} or {bp}-{stage} or {bp} (production)
            # URL template lets automations find each other by substituting {name}.
            # Deployment ID format: {automationName}-{context}
            deployment_context = conf.get("deployment_context", "")
            # relative_path is like "copies/main/Test/backend" or
            # "copies/bar/Test/backend"; wt_name is the copy context ("" for main).
            bp_sanitized, wt_name = derive_bp_and_copy(relative_path)
            if not deployment_context:
                wt_part = f"-copy-{wt_name}" if wt_name else ""
                stage_suffix = f"-{stage}" if stage and stage != "production" else ""
                if bp_sanitized:
                    deployment_context = f"{bp_sanitized}{wt_part}{stage_suffix}"
                elif wt_name:
                    deployment_context = f"copy-{wt_name}{stage_suffix}"
                else:
                    deployment_context = (
                        stage if stage and stage != "production" else ""
                    )

            if deployment_context:
                entry["environment"]["BITSWAN_DEPLOYMENT_CONTEXT"] = deployment_context

            # Per-BP database namespace for snapshot-eligible BPs: compose
            # `environment:` beats the shared defaults coming from the
            # service secrets env_file. Names are stage-independent so
            # snapshots restore across stages without rewriting.
            if bp_sanitized and is_registered(
                bp_registry, bp_sanitized, stage_for_deployment(stage)
            ):
                # Production slots wire to their own DB (1/2); other stages use
                # the single-backend names (db=None).
                bp_names = bp_resource_names(bp_sanitized, db)
                entry["environment"]["POSTGRES_DB"] = bp_names["postgres_db"]
                entry["environment"]["COUCHDB_DB_PREFIX"] = bp_names["couchdb_prefix"]
                entry["environment"]["MINIO_BUCKET"] = bp_names["minio_bucket"]

            # For non-main copy live-devs, override POSTGRES_DB to use the
            # cloned database. Ordering is load-bearing: this MUST come after
            # the per-BP injection above so the copy clone wins.
            if wt_name and stage == "live-dev":
                wt_db = "postgres_copy_" + re.sub(r"[^a-z0-9_]", "_", wt_name.lower())
                entry["environment"]["POSTGRES_DB"] = wt_db

            if self.workspace_name and self.gitops_domain:
                if dep_context:
                    h = _short_hash(dep_context)
                    ctx_suffix = (
                        f"-{h}-{dep_stage}" if dep_stage != "production" else f"-{h}"
                    )
                elif dep_stage != "production":
                    ctx_suffix = f"-{dep_stage}"
                else:
                    ctx_suffix = ""
                # Same-slot peer discovery: a slot's containers resolve each
                # other at slot-suffixed hostnames (the network alias below is
                # set to match), so slot 'a' never talks to slot 'b'.
                if slot:
                    ctx_suffix = f"{ctx_suffix}-{slot}"
                entry["environment"]["BITSWAN_URL_TEMPLATE"] = (
                    f"https://{self.workspace_name}-"
                    "{name}"
                    f"{ctx_suffix}.{self.gitops_domain}"
                )

            # Deployment and image checksums + deploy timestamp
            deploy_checksum = conf.get("checksum")
            if deploy_checksum:
                entry["environment"]["BITSWAN_DEPLOY_CHECKSUM"] = deploy_checksum
            image_checksum = conf.get("tag_checksum")
            if image_checksum:
                entry["environment"]["BITSWAN_IMAGE_CHECKSUM"] = image_checksum
            entry["environment"]["BITSWAN_DEPLOY_TIME"] = (
                datetime.utcnow().isoformat() + "Z"
            )

            # network_mode comes from the deployment entry below (3861 fallback).
            network_mode = None

            # Egress firewall: route this worker through its group's gateway by
            # sharing the gateway's network namespace, with NET_ADMIN/NET_RAW
            # dropped so container-root can't alter the gateway's iptables. Only
            # workers are gated — a frontend's egress is the iframe's, enforced
            # via CSP. The gateway service itself is emitted after the loop.
            _fw = _fw_active(dep_context, dep_stage, slot)
            if _fw and not automation_config.expose:
                network_mode = f"service:{_fw['gw']}"
                entry["cap_drop"] = sorted(
                    set(entry.get("cap_drop", [])) | {"NET_ADMIN", "NET_RAW"}
                )
                # The worker lives in the gateway's network namespace, so it can
                # only start once that namespace exists AND the proxy inside it is
                # listening — otherwise the worker's first outbound dial races a
                # half-up gateway and the container wedges/restarts (the live-dev
                # 480s failure mode). Gating on service_healthy also pulls the
                # gateway into the explicit `docker compose up <worker>` set, so it
                # is actually started (it carries no deployment-id label, so the
                # member-service selector would otherwise never bring it up).
                entry.setdefault("depends_on", {})[_fw["gw"]] = {
                    "condition": "service_healthy"
                }

            # Per-(BP, stage) secrets: decrypt this stage's blob from
            # bitswan.yaml and (re)materialise the plaintext env file the
            # container loads. Deriving it here — at deploy time, from the
            # current bitswan.yaml — means a stage rollback (which restores its
            # bitswan.yaml revision) restores its secrets too. Ciphertext stays
            # in git; plaintext stays on the secrets volume, never in compose.
            if bp_sanitized:
                realm = bp_secrets.realm_for_stage(stage)
                blob = ((bs_yaml.get("secrets") or {}).get(bp_sanitized) or {}).get(
                    realm
                )
                values = (
                    bp_secrets.decrypt_secrets(self.secrets_dir, blob) if blob else {}
                )
                bp_secret_env = bp_secrets.materialize_env(
                    self.secrets_dir, bp_sanitized, stage, values
                )
                entry.setdefault("env_file", [])
                if bp_secret_env not in entry["env_file"]:
                    entry["env_file"].append(bp_secret_env)

            # Service dependency secrets (from [services.*] in automation.toml).
            service_secret_names = self._resolve_service_secrets(
                automation_config, stage
            )
            for svc_secret_name in service_secret_names:
                svc_secret_path = os.path.join(self.secrets_dir, svc_secret_name)
                if os.path.exists(svc_secret_path):
                    entry.setdefault("env_file", [])
                    if svc_secret_path not in entry["env_file"]:
                        entry["env_file"].append(svc_secret_path)

            if not network_mode:
                network_mode = conf.get("network_mode")

            # external-testing-network: isolated bridge with only outbound internet.
            # No access to internal services — tests must use public URLs.
            if not network_mode and automation_config.external_testing_network:
                networks_list = ["bitswan_external_testing"]
                external_networks.add("bitswan_external_testing")

            if network_mode:
                entry["network_mode"] = network_mode
            elif not automation_config.external_testing_network:
                if "networks" in conf:
                    networks_list = conf["networks"].copy()
                elif "default-networks" in bs_yaml:
                    networks_list = bs_yaml["default-networks"].copy()
                else:
                    networks_list = ["bitswan_network"]

            if not network_mode:
                if replicas > 1:
                    # Use network aliases instead of container_name for DNS round-robin
                    alias = service_name
                    entry["networks"] = {
                        net: {"aliases": [alias]} for net in networks_list
                    }
                    entry["deploy"] = {"replicas": replicas}
                else:
                    entry["networks"] = networks_list

            if entry.get("networks"):
                if isinstance(entry["networks"], dict):
                    external_networks.update(entry["networks"].keys())
                else:
                    external_networks.update(set(entry["networks"]))

            passthroughs = ["volumes", "ports", "devices"]
            if replicas <= 1:
                passthroughs.append("container_name")
            entry.update({p: conf[p] for p in passthroughs if p in conf})

            deployment_dir = os.path.join(self.gitops_dir_host, source)

            # Use unified automation config for image, expose, and port.
            # Promoted stages (dev/staging/production) bake the source INTO the
            # image, so use the recorded baked image instead of the base runtime.
            entry["image"] = automation_config.image
            if stage != "live-dev" and conf.get("image"):
                entry["image"] = conf["image"]
            expose = automation_config.expose
            port = automation_config.port

            if expose and port:
                # Exposed automations (frontends) are reached through Bailey's
                # protected ingress (auth + per-endpoint ACL); registering the
                # route records the workspace dashboard as the ACL parent so
                # members can share it.
                #
                # Blue-green production exposes two STABLE user-facing hosts: the
                # LIVE slot owns `-production`, the standby (DR) slot owns `-dr`.
                # The idle promote-buffer slot has no public route. A swap
                # repoints these hosts between slots (no rename, no redeploy).
                # Non-production stages use their single canonical host.
                is_dr_slot = bool(slot) and slot == _dr_slot_for(conf)
                role_stage = "dr" if is_dr_slot else dep_stage
                publish = (not slot) or is_live_slot or is_dr_slot
                url_label = make_hostname_label(
                    self.workspace_name, dep_automation_name, dep_context, role_stage
                )
                url_prefix = f"https://{self.workspace_name}-"
                url_suffix = f".{self.gitops_domain}"
                automation_url = f"https://{url_label}.{self.gitops_domain}"

                entry["environment"]["BITSWAN_AUTOMATION_URL"] = automation_url
                entry["environment"]["BITSWAN_URL_PREFIX"] = url_prefix
                entry["environment"]["BITSWAN_URL_SUFFIX"] = url_suffix

                entry["labels"]["gitops.intended_exposed"] = (
                    "true" if publish else "false"
                )
                # Collect (don't apply) the route this exposed automation should
                # have. The whole desired set is reconciled once by the caller —
                # generation stays pure, and a deploy/promote/swap is just "write
                # bitswan.yaml, then reconcile what it derives".
                if publish:
                    desired_routes.append(
                        workspace_route(
                            dep_automation_name,
                            dep_context,
                            dep_stage,
                            port,
                            upstream_slot=slot,
                            host_stage=role_stage,
                        )
                    )

            # Add the public hostname as a network alias so other containers
            # on the same Docker network can reach this automation by its URL.
            if expose and port and self.gitops_domain and not network_mode:
                url_host = f"{make_hostname_label(self.workspace_name, dep_automation_name, dep_context, dep_stage, slot)}.{self.gitops_domain}"
                networks = entry.get("networks")
                if isinstance(networks, dict):
                    for net_conf in networks.values():
                        aliases = net_conf.setdefault("aliases", [])
                        if url_host not in aliases:
                            aliases.append(url_host)
                elif isinstance(networks, list):
                    # Convert list form to dict form so we can attach aliases
                    entry["networks"] = {
                        net: {"aliases": [url_host]} for net in networks
                    }

            # Always pass Keycloak URL for JWT verification
            # KEYCLOAK_URL format: https://keycloak.example.com/realms/realm-name
            keycloak_url = os.environ.get("KEYCLOAK_URL", "")
            if keycloak_url:
                entry["environment"]["KEYCLOAK_URL"] = (
                    keycloak_url.rsplit("/realms/", 1)[0]
                    if "/realms/" in keycloak_url
                    else keycloak_url
                )
                entry["environment"]["KEYCLOAK_REALM"] = (
                    keycloak_url.rsplit("/realms/", 1)[-1]
                    if "/realms/" in keycloak_url
                    else ""
                )
                entry["environment"]["KEYCLOAK_ISSUER_URL"] = keycloak_url

            # Inject the org group path for JWT group-membership verification,
            # but only when AOC is configured (simple-mode deployments skip this).
            org_group_path = self.get_org_group_path()
            if org_group_path:
                entry["environment"]["BITSWAN_ALLOWED_GROUP"] = org_group_path

            if "volumes" not in entry:
                entry["volumes"] = []

            # Mount CA certificates if configured
            if self.certs_dir_host:
                entry["volumes"].append(
                    f"{self.certs_dir_host}:/usr/local/share/ca-certificates/custom:ro"
                )
                entry["environment"]["UPDATE_CA_CERTIFICATES"] = "true"
                entry["labels"]["gitops.certs.enabled"] = "true"

            # Source mount is always read-only: live-dev binds the workspace
            # copy directly, other stages bind the checksum-extracted
            # deployment dir. Each template is configured to write its
            # scratch files to writable image layers (e.g. `/deps`, `/tmp`,
            # `$PYTHONPYCACHEPREFIX`) rather than into the source tree.
            #
            # When BITSWAN_VOLUME_NAME is set, workspace data lives in a named
            # Docker volume (each workspace at `workspaces/<ws>/...`) and the BP
            # source is mounted via a compose long-form volume+subpath dict
            # instead of a host bind path. When it is unset, fall back to the
            # legacy host-bind-string behavior.
            bitswan_volume_name = os.environ.get("BITSWAN_VOLUME_NAME")
            bitswan_workspace_name = os.environ.get("BITSWAN_WORKSPACE_NAME")

            def _normalize_subpath(p):
                # Collapse leading "./" / "/" so the subpath is volume-relative.
                while p.startswith("./") or p.startswith("/"):
                    if p.startswith("./"):
                        p = p[2:]
                    else:
                        p = p[1:]
                return p

            if stage == "live-dev" and relative_path:
                if bitswan_volume_name:
                    # relative_path is "copies/<copy>/<rel>", so the volume
                    # subpath is workspaces/<ws>/copies/<copy>/<rel>.
                    subpath = _normalize_subpath(
                        f"workspaces/{bitswan_workspace_name}/{relative_path}"
                    )
                    entry["volumes"].append(
                        {
                            "type": "volume",
                            "source": bitswan_volume_name,
                            "target": automation_config.mount_path,
                            "read_only": True,
                            "volume": {"subpath": subpath},
                        }
                    )
                else:
                    source_mount_path = os.path.join(
                        self.workspace_dir_host, relative_path
                    )
                    entry["volumes"].append(
                        f"{source_mount_path}:{automation_config.mount_path}:ro"
                    )
            elif conf.get("image"):
                # Source is baked into the image (promoted stages) — no mount.
                pass
            else:
                # Legacy/transitional: mount the materialized checksum tree.
                if bitswan_volume_name:
                    subpath = _normalize_subpath(
                        f"workspaces/{bitswan_workspace_name}/gitops/{source}"
                    )
                    entry["volumes"].append(
                        {
                            "type": "volume",
                            "source": bitswan_volume_name,
                            "target": automation_config.mount_path,
                            "read_only": True,
                            "volume": {"subpath": subpath},
                        }
                    )
                else:
                    entry["volumes"].append(
                        f"{deployment_dir}:{automation_config.mount_path}:ro"
                    )

            if conf.get("enabled", True):
                dc["services"][service_name] = entry

        # Emit one egress-gateway service per firewalled (ctx, stage) group. The
        # workers above share its netns; it holds NET_ADMIN, installs the
        # iptables interception (entrypoint), and runs the SNI/Host allow-list
        # proxy. It sits on bitswan_network (so the workers reach infra + the
        # internet through it) and logs blocked/observed hosts to the shared
        # firewall dir for the dashboard's "needs review" feed.
        # Only touch the firewall dir / emit gateways when at least one (ctx,
        # stage) actually has an active firewall — keeps deploys zero-blast-radius
        # when the feature is unused (the shared firewall volume may not be
        # writable, or even exist, on workspaces that never configured egress
        # rules). When a firewall IS active, a failure to create the attempts dir
        # must surface (the gateway can't run without it) — so no try/except.
        if any(f.get("ok") for f in fw_scope.values()):
            gw_image = os.environ.get(
                "BITSWAN_EGRESS_GATEWAY_IMAGE", "bitswan/egress-gateway:latest"
            )
            # The attempts feed must be on storage SHARED with the gitops
            # container (which reads firewall_service.firewall_dir() == the
            # `firewall` subdir of BITSWAN_GITOPS_DIR). When workspace data lives
            # in the named `bitswan` volume, mount the gateway's /firewall from the
            # SAME `workspaces/<ws>/firewall` subpath the gitops container mounts —
            # so a write by the gateway is visible to the dashboard reader. A host
            # bind to a container-local path would diverge and the feed would stay
            # empty. (The daemon pre-creates this subdir; see
            # ensureWorkspaceVolumeDirs.) Fall back to the legacy host bind only
            # when no volume is configured.
            bitswan_volume_name = os.environ.get("BITSWAN_VOLUME_NAME")
            bitswan_workspace_name = os.environ.get("BITSWAN_WORKSPACE_NAME")
            if bitswan_volume_name:
                fw_mount: dict | str = {
                    "type": "volume",
                    "source": bitswan_volume_name,
                    "target": "/firewall",
                    "volume": {
                        "subpath": f"workspaces/{bitswan_workspace_name}/firewall"
                    },
                }
            else:
                fw_host_dir = os.path.join(
                    os.path.dirname(self.gitops_dir_host), "firewall"
                )
                fw_mount = f"{fw_host_dir}:/firewall"
            os.makedirs(firewall_service.firewall_dir(), exist_ok=True)
            for (ctx, stage, slot), fw in fw_scope.items():
                if not fw["ok"]:
                    continue
                gw, realm, fw_bp = fw["gw"], fw["realm"], fw["bp"]
                # Per-slot attempts file so each blue-green slot's gateway logs
                # to its own feed (the gateway name is already slot-suffixed).
                # Keyed by the canonical BP slug (NOT the deployment context) so
                # the dashboard's Firewall tab — which reads
                # `<bp>__<realm>.attempts.jsonl` — sees what this group observed,
                # including copies/live-dev whose context is `copy-…`.
                slot_tag = f"__{slot}" if slot else ""
                dc["services"][gw] = {
                    "image": gw_image,
                    "container_name": gw,
                    "restart": "unless-stopped",
                    "cap_add": ["NET_ADMIN"],
                    "networks": {"bitswan_network": {"aliases": [gw]}},
                    "environment": {
                        "BITSWAN_FW_MODE": fw["mode"],
                        "BITSWAN_FW_ALLOW": ",".join(fw["allow"]),
                        "BITSWAN_FW_ATTEMPTS": (
                            f"/firewall/{fw_bp}__{realm}{slot_tag}.attempts.jsonl"
                        ),
                    },
                    "volumes": [fw_mount],
                    # Cheap liveness on the dedicated health port (:18077), which
                    # the proxy binds in the same startup as the filter ports. The
                    # workers that share this netns gate their start on it being
                    # healthy (depends_on below) — without a healthcheck a worker
                    # would race the gateway's netns and wedge on startup. We probe
                    # :18077 rather than the filter ports so the healthcheck never
                    # logs a bogus no-SNI attempt into the "Needs review" feed. The
                    # ports are high/uncommon so they never collide with the app's
                    # own listen port (e.g. :8080) in the shared netns.
                    "healthcheck": {
                        "test": ["CMD-SHELL", "nc -z 127.0.0.1 18077"],
                        "interval": "3s",
                        "timeout": "3s",
                        "retries": 10,
                        "start_period": "2s",
                    },
                    "labels": {
                        "gitops.firewall_gateway": "true",
                        "gitops.bp": fw_bp,
                        "gitops.stage": realm,
                        "gitops.slot": slot or "",
                    },
                }
                external_networks.add("bitswan_network")

        # Merge infra service entries (Kafka, CouchDB, etc.) for enabled services
        infra_service_names = self._merge_infra_services(
            dc, deployments, external_networks
        )

        dc["networks"] = {}
        for network in external_networks:
            if network == "bitswan_external_testing":
                # Created by docker-compose as a regular bridge with outbound
                # internet access but no connectivity to internal services
                dc["networks"][network] = {"driver": "bridge"}
            else:
                dc["networks"][network] = {"external": True}

        # Declare the external named volume at the top level whenever workspace
        # data is sourced from it (BITSWAN_VOLUME_NAME set). Merge so we don't
        # clobber any volumes already declared on the compose dict.
        bitswan_volume_name = os.environ.get("BITSWAN_VOLUME_NAME")
        if bitswan_volume_name:
            dc.setdefault("volumes", {})
            dc["volumes"][bitswan_volume_name] = {"external": True}

        dc_yaml = yaml.dump(dc)
        return dc_yaml, infra_service_names, desired_routes

    def _save_docker_compose(self, dc_yaml: str) -> None:
        """Save the generated docker-compose.yaml to the gitops directory for debugging."""
        dc_path = os.path.join(self.gitops_dir, "docker-compose.yaml")
        with open(dc_path, "w") as f:
            f.write(dc_yaml)
        logger.info(f"Saved docker-compose.yaml to {dc_path}")

    def _merge_infra_services(
        self, dc: dict, deployments: dict, external_networks: set
    ) -> list[str]:
        """Merge enabled infra service compose dicts into the main docker-compose.

        Returns the list of compose service names that were merged.
        """
        from app.services.infra_service import get_service, stage_for_deployment

        merged_service_names: list[str] = []

        # Collect unique (service_type, stage) pairs from all deployments
        seen: set[tuple[str, str]] = set()
        for dep_conf in deployments.values():
            dep_conf = dep_conf or {}
            dep_services = dep_conf.get("services")
            if not dep_services:
                continue
            dep_stage = dep_conf.get("stage") or "production"
            mapped_stage = stage_for_deployment(dep_stage)
            for svc_type, svc_conf in dep_services.items():
                enabled = (
                    svc_conf.get("enabled", True)
                    if isinstance(svc_conf, dict)
                    else bool(svc_conf)
                )
                if enabled:
                    seen.add((svc_type, mapped_stage))

        # For each enabled service, generate and merge its compose dict
        for svc_type, svc_stage in seen:
            try:
                svc = get_service(svc_type, self.workspace_name, stage=svc_stage)
            except ValueError:
                logger.warning(
                    f"Unknown service type '{svc_type}', skipping compose merge"
                )
                continue

            if not svc.is_enabled():
                logger.warning(
                    f"{svc.display_name} is declared by a deployment but not enabled "
                    f"(secrets file missing at {svc.secrets_file_path}). "
                    f"Skipping compose merge — this service will NOT run."
                )
                continue

            # Hook for services that need extra config before compose generation.
            svc.ensure_config()

            svc_compose = svc._generate_compose_dict()

            # Merge services
            for svc_name, svc_entry in svc_compose.get("services", {}).items():
                if svc_name not in dc["services"]:
                    dc["services"][svc_name] = svc_entry
                    merged_service_names.append(svc_name)

            # Merge volumes
            svc_volumes = svc_compose.get("volumes", {})
            if svc_volumes:
                if "volumes" not in dc:
                    dc["volumes"] = {}
                for vol_name, vol_conf in svc_volumes.items():
                    if vol_name not in dc["volumes"]:
                        dc["volumes"][vol_name] = vol_conf

            # Collect networks
            for net_name, net_conf in svc_compose.get("networks", {}).items():
                if net_conf and net_conf.get("external"):
                    external_networks.add(net_name)

        return merged_service_names
