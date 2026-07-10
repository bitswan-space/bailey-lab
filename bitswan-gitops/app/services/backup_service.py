"""Backup service using restic through the AOC backup proxy.

Backs up:
- Postgres production databases (pg_dump piped to restic)
- CouchDB production databases (JSON export)
- MinIO production buckets
- Workspace files (/workspace-repo)

restic talks to AOC's restic REST-server endpoints
(/api/automation_server/workspaces/{id}/backups/repo/), which proxy
object operations to the workspace's own bucket. The object-storage
credentials live only in AOC — this service never sees them; it
authenticates with the automation server's AOC token.

Encryption key and backup config stored in secrets/.backup/
"""

import asyncio
import json
import logging
import os
import shutil
import tempfile
from datetime import datetime, timezone

import httpx

logger = logging.getLogger(__name__)

BACKUP_CONFIG_DIR = ".backup"

DEFAULT_RETENTION = {"daily": 30, "monthly": 12}


def _aoc_settings() -> tuple[str, str, str] | None:
    """(aoc_url, aoc_token, workspace_id) from the daemon-injected env,
    or None when this workspace isn't connected to an AOC."""
    aoc_url = os.environ.get("BITSWAN_AOC_URL", "").rstrip("/")
    aoc_token = os.environ.get("BITSWAN_AOC_TOKEN", "")
    workspace_id = os.environ.get("BITSWAN_WORKSPACE_ID", "")
    if not (aoc_url and aoc_token and workspace_id):
        return None
    return aoc_url, aoc_token, workspace_id


def _repo_url() -> str:
    aoc_url, _token, workspace_id = _aoc_settings()
    return f"{aoc_url}/api/automation_server/workspaces/{workspace_id}/backups/repo/"


def _key_mirror_url() -> str:
    aoc_url, _token, workspace_id = _aoc_settings()
    return (
        f"{aoc_url}/api/automation_server/workspaces/{workspace_id}/backups/restic-key"
    )


def _aoc_headers() -> dict:
    _url, token, _wid = _aoc_settings()
    return {"Authorization": f"Bearer {token}"}


def _get_backup_dir() -> str:
    bs_home = os.environ.get("BITSWAN_GITOPS_DIR", "/mnt/repo/pipeline")
    return os.path.join(bs_home, "secrets", BACKUP_CONFIG_DIR)


def _get_config_path() -> str:
    return os.path.join(_get_backup_dir(), "config.json")


def _get_key_path() -> str:
    return os.path.join(_get_backup_dir(), "restic-key")


def get_backup_config() -> dict | None:
    """Read backup configuration."""
    path = _get_config_path()
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def save_backup_config(config: dict) -> None:
    """Save backup configuration."""
    backup_dir = _get_backup_dir()
    os.makedirs(backup_dir, mode=0o700, exist_ok=True)
    with open(_get_config_path(), "w") as f:
        json.dump(config, f, indent=2)
    os.chmod(_get_config_path(), 0o600)


def get_restic_key() -> str | None:
    """Read the restic encryption key."""
    path = _get_key_path()
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return f.read().strip()


def generate_restic_key() -> str:
    """Generate and save a new restic encryption key."""
    import secrets

    key = secrets.token_urlsafe(48)
    backup_dir = _get_backup_dir()
    os.makedirs(backup_dir, mode=0o700, exist_ok=True)
    with open(_get_key_path(), "w") as f:
        f.write(key)
    os.chmod(_get_key_path(), 0o600)
    return key


def delete_restic_key() -> None:
    """Delete the local restic key (after user downloads it)."""
    path = _get_key_path()
    if os.path.exists(path):
        os.remove(path)


def is_configured() -> bool:
    """Backups are usable: AOC-connected, enabled, and the key exists."""
    if _aoc_settings() is None:
        return False
    config = get_backup_config()
    return (
        config is not None
        and config.get("enabled", True)
        and get_restic_key() is not None
    )


# --- Off-site key mirror (via the AOC backup proxy) ---
# The key object lives at the bucket root as `.restic-key`, next to the
# restic repo, but is only reachable through AOC — GitOps never holds
# object-storage credentials.


async def key_exists_remote() -> bool:
    """Check if the encryption key is mirrored off-site."""
    return await download_key_remote() is not None


async def upload_key_remote(key: str) -> tuple[bool, str]:
    """Mirror the encryption key off-site through AOC."""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.put(
                _key_mirror_url(),
                content=key.encode(),
                headers=_aoc_headers(),
                timeout=30,
            )
        if response.status_code != 200:
            return False, f"AOC returned {response.status_code}: {response.text}"
        return True, "Key uploaded"
    except httpx.HTTPError as e:
        return False, str(e)


async def download_key_remote() -> str | None:
    """Fetch the off-site copy of the encryption key through AOC."""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                _key_mirror_url(), headers=_aoc_headers(), timeout=30
            )
        if response.status_code != 200:
            return None
        return response.text.strip()
    except httpx.HTTPError:
        return None


def _save_key(key: str) -> None:
    """Save a key to the local key file."""
    backup_dir = _get_backup_dir()
    os.makedirs(backup_dir, mode=0o700, exist_ok=True)
    with open(_get_key_path(), "w") as f:
        f.write(key)
    os.chmod(_get_key_path(), 0o600)


async def delete_key_remote() -> tuple[bool, str]:
    """Delete the off-site copy of the encryption key through AOC."""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.delete(
                _key_mirror_url(), headers=_aoc_headers(), timeout=30
            )
        if response.status_code not in (200, 404):
            return False, f"AOC returned {response.status_code}: {response.text}"
        return True, "Key deleted from off-site storage"
    except httpx.HTTPError as e:
        return False, str(e)


def _restic_env(config: dict) -> dict:
    """Build environment variables for restic commands."""
    _aoc_url, aoc_token, workspace_id = _aoc_settings()
    env = os.environ.copy()
    env["RESTIC_REPOSITORY"] = f"rest:{_repo_url()}"
    env["RESTIC_REST_USERNAME"] = workspace_id
    env["RESTIC_REST_PASSWORD"] = aoc_token
    env["RESTIC_PASSWORD"] = get_restic_key() or ""
    return env


async def _run_restic(
    args: list[str], config: dict, timeout: int = 3600
) -> tuple[str, str, int]:
    """Run a restic command and return (stdout, stderr, returncode)."""
    env = _restic_env(config)
    proc = await asyncio.create_subprocess_exec(
        "restic",
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return "", "Timeout", -1
    return stdout.decode(), stderr.decode(), proc.returncode


async def init_repo(config: dict) -> tuple[bool, str]:
    """Initialize the restic repository through the AOC proxy.

    restic init issues `POST ?create=true`, which makes AOC lazily
    create the workspace's backup bucket."""
    stdout, stderr, rc = await _run_restic(["init"], config)
    if rc == 0:
        return True, "Repository initialized"
    if "already initialized" in stderr.lower() or "already exists" in stderr.lower():
        return True, "Repository already initialized"
    return False, stderr.strip()


async def ensure_backups_enabled() -> tuple[bool, str]:
    """Self-enable backups when this workspace is connected to an AOC.

    Idempotent: called at startup. Writes a default config if none
    exists, recovers or generates the encryption key, and initializes
    the restic repo (AOC creates the bucket on demand). Respects an
    explicit ``enabled: false`` in the saved config.
    """
    if _aoc_settings() is None:
        return False, "Not connected to an AOC; backups stay unconfigured"

    config = get_backup_config()
    if config is not None and not config.get("enabled", True):
        return False, "Backups explicitly disabled"

    if config is None:
        config = {"enabled": True, "retention": dict(DEFAULT_RETENTION)}
        save_backup_config(config)

    recovered = False
    if not get_restic_key():
        # A rebuilt server may find its key mirrored off-site
        key = await download_key_remote()
        if key:
            _save_key(key)
            recovered = True

    generated = False
    if not get_restic_key():
        generate_restic_key()
        generated = True

    ok, msg = await init_repo(config)
    if not ok:
        return False, f"Failed to initialize restic repo: {msg}"

    if generated:
        key = get_restic_key()
        if key:
            await upload_key_remote(key)

    if recovered:
        return True, "Connected to existing backup repository. Key recovered."
    return True, msg


def _get_last_run_path() -> str:
    return os.path.join(_get_backup_dir(), "last_run.json")


def get_last_run() -> dict | None:
    """Outcome of the most recent whole-server backup run, or None."""
    try:
        with open(_get_last_run_path()) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def _write_last_run(record: dict) -> None:
    try:
        os.makedirs(_get_backup_dir(), mode=0o700, exist_ok=True)
        with open(_get_last_run_path(), "w") as f:
            json.dump(record, f, indent=2)
    except OSError as e:
        logger.warning("Failed to write backup last-run record: %s", e)


async def run_backup(config: dict) -> dict:
    """Run a full backup of all production data."""
    workspace_name = os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace-local")
    results = {}
    timestamp = datetime.now(timezone.utc).isoformat()
    ok = False

    try:
        # 1. Backup workspace files
        workspace_dir = os.environ.get("BITSWAN_WORKSPACE_REPO_DIR", "/workspace-repo")
        if os.path.isdir(workspace_dir):
            stdout, stderr, rc = await _run_restic(
                [
                    "backup",
                    "--tag",
                    "workspace",
                    "--tag",
                    workspace_name,
                    workspace_dir,
                ],
                config,
            )
            results["workspace"] = {
                "success": rc == 0,
                "output": stdout.strip() or stderr.strip(),
            }

        # 2. Backup Postgres via pg_dump piped through restic
        results["postgres"] = await _backup_postgres(config, workspace_name)

        # 3. Backup CouchDB via JSON export
        results["couchdb"] = await _backup_couchdb(config, workspace_name)

        # 4. Backup MinIO via mc mirror to temp dir then restic
        results["minio"] = await _backup_minio(config, workspace_name)

        # Apply retention policy
        await _apply_retention(config)

        results["timestamp"] = timestamp
        ok = all(
            r.get("success", True) for r in results.values() if isinstance(r, dict)
        )
        return results
    finally:
        _write_last_run(
            {
                "started_at": timestamp,
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "ok": ok,
                "results": results,
            }
        )


def _driver_and_ctx(workspace_name: str):
    """An infra-driver client + WorkspaceContext for module-level backup helpers
    (these aren't AutomationService methods, so they build their own)."""
    from app.services.infra_driver_client import InfraDriverClient, WorkspaceContext

    gitops_root = os.environ.get("BITSWAN_GITOPS_DIR", "/gitops")
    return InfraDriverClient(), WorkspaceContext(
        workspace_name=workspace_name,
        domain=os.environ.get("BITSWAN_GITOPS_DOMAIN", ""),
        gitops_dir=os.path.join(gitops_root, "gitops"),
        secrets_dir=os.path.join(gitops_root, "secrets"),
    )


async def _container_running(client, ctx, name: str) -> bool:
    conts = await client.container_list(ctx)
    return any(c.name == name and c.state == "running" for c in conts)


async def _backup_postgres(config: dict, workspace_name: str) -> dict:
    """Backup Postgres production database (pg_dumpall via the driver's exec)."""
    from app.services.infra_driver_client import ExecSpec, InfraDriverError

    client, ctx = _driver_and_ctx(workspace_name)
    container_name = f"{workspace_name}__postgres"

    try:
        if not await _container_running(client, ctx, container_name):
            return {"success": True, "output": "No Postgres container running, skipped"}

        chunks: list[bytes] = []

        async def on_stdout(data: bytes):
            chunks.append(data)

        try:
            code = await client.exec(
                ctx,
                ExecSpec(container=container_name, cmd=["pg_dumpall", "-U", "admin"]),
                on_stdout=on_stdout,
            )
        except InfraDriverError as e:
            return {"success": False, "output": str(e)}
        if code != 0:
            return {"success": False, "output": f"pg_dumpall exit {code}"}
        dump = b"".join(chunks).decode("utf-8", "replace")

        if not dump:
            return {"success": False, "output": "Empty dump"}

        # Write dump to temp file, then restic backup
        with tempfile.NamedTemporaryFile(mode="w", suffix=".sql", delete=False) as f:
            f.write(dump)
            dump_path = f.name

        try:
            stdout, stderr, rc = await _run_restic(
                [
                    "backup",
                    "--tag",
                    "postgres",
                    "--tag",
                    workspace_name,
                    "--stdin-filename",
                    "postgres.sql",
                    "--stdin",
                ],
                config,
            )
            # Actually need to pipe the file. Use a different approach:
            env = _restic_env(config)
            proc = await asyncio.create_subprocess_exec(
                "restic",
                "backup",
                "--tag",
                "postgres",
                "--tag",
                workspace_name,
                dump_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            stdout_bytes, stderr_bytes = await proc.communicate()
            rc = proc.returncode
            return {
                "success": rc == 0,
                "output": stdout_bytes.decode().strip()
                or stderr_bytes.decode().strip(),
            }
        finally:
            os.unlink(dump_path)

    except Exception as e:
        return {"success": False, "output": str(e)}


async def _backup_couchdb(config: dict, workspace_name: str) -> dict:
    """Backup CouchDB production databases."""
    from app.services.infra_service import get_service

    try:
        svc = get_service("couchdb", workspace_name, stage="production")
        if not svc.is_enabled():
            return {"success": True, "output": "CouchDB not enabled, skipped"}

        # Use existing backup mechanism to create a tarball
        backup_dir = tempfile.mkdtemp(prefix="couchdb-backup-")
        try:
            result = await svc.backup(backup_dir)
            backup_path = result.get("backup_path")
            if not backup_path or not os.path.exists(backup_path):
                return {"success": False, "output": "Backup file not created"}

            stdout, stderr, rc = await _run_restic(
                ["backup", "--tag", "couchdb", "--tag", workspace_name, backup_path],
                config,
            )
            return {"success": rc == 0, "output": stdout.strip() or stderr.strip()}
        finally:
            shutil.rmtree(backup_dir, ignore_errors=True)

    except Exception as e:
        return {"success": False, "output": str(e)}


async def _backup_minio(config: dict, workspace_name: str) -> dict:
    """Backup MinIO production buckets."""
    from app.services.infra_service import get_service

    try:
        svc = get_service("minio", workspace_name, stage="production")
        if not svc.is_enabled():
            return {"success": True, "output": "MinIO not enabled, skipped"}

        backup_dir = tempfile.mkdtemp(prefix="minio-backup-")
        try:
            result = await svc.backup(backup_dir)
            backup_path = result.get("backup_path")
            if not backup_path or not os.path.exists(backup_path):
                return {"success": False, "output": "Backup file not created"}

            stdout, stderr, rc = await _run_restic(
                ["backup", "--tag", "minio", "--tag", workspace_name, backup_path],
                config,
            )
            return {"success": rc == 0, "output": stdout.strip() or stderr.strip()}
        finally:
            shutil.rmtree(backup_dir, ignore_errors=True)

    except Exception as e:
        return {"success": False, "output": str(e)}


async def _apply_retention(config: dict) -> None:
    """Apply retention policy: keep daily for 30 days, monthly for 12 months.

    Scoped to the whole-server backup tags (repeated --tag = OR) so it can
    never prune the per-BP snapshot mirrors, which follow their own
    per-BP retention (snapshot_offsite.apply_offsite_retention)."""
    retention = config.get("retention", {})
    daily = retention.get("daily", 30)
    monthly = retention.get("monthly", 12)

    await _run_restic(
        [
            "forget",
            "--prune",
            "--tag",
            "workspace",
            "--tag",
            "postgres",
            "--tag",
            "couchdb",
            "--tag",
            "minio",
            "--keep-daily",
            str(daily),
            "--keep-monthly",
            str(monthly),
        ],
        config,
    )


async def list_snapshots(config: dict, tag: str | None = None) -> list[dict]:
    """List available snapshots, optionally filtered by tag."""
    args = ["snapshots", "--json"]
    if tag:
        args.extend(["--tag", tag])
    stdout, stderr, rc = await _run_restic(args, config)
    if rc != 0:
        return []
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        return []


async def restore_snapshot(
    config: dict, snapshot_id: str, target_path: str
) -> tuple[bool, str]:
    """Restore a snapshot to a target path."""
    os.makedirs(target_path, exist_ok=True)
    stdout, stderr, rc = await _run_restic(
        ["restore", snapshot_id, "--target", target_path],
        config,
    )
    if rc == 0:
        return True, f"Restored to {target_path}"
    return False, stderr.strip()


async def restore_postgres(
    config: dict, snapshot_id: str, stage: str = "production"
) -> tuple[bool, str]:
    """Restore a Postgres snapshot to a given stage."""
    from app.services.infra_driver_client import ExecSpec, InfraDriverError

    workspace_name = os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace-local")

    # Restore the dump file from restic to a temp dir
    restore_dir = tempfile.mkdtemp(prefix="pg-restore-")
    try:
        ok, msg = await restore_snapshot(config, snapshot_id, restore_dir)
        if not ok:
            return False, msg

        # Find the .sql file
        sql_file = None
        for root, dirs, files in os.walk(restore_dir):
            for f in files:
                if f.endswith(".sql"):
                    sql_file = os.path.join(root, f)
                    break
            if sql_file:
                break

        if not sql_file:
            return False, "No SQL dump found in snapshot"

        # Read the dump
        with open(sql_file, "rb") as f:
            dump_content = f.read()

        # Execute in the target Postgres container (psql, dump piped to stdin).
        suffix = f"-{stage}" if stage != "production" else ""
        container_name = f"{workspace_name}__postgres{suffix}"

        client, ctx = _driver_and_ctx(workspace_name)
        if not await _container_running(client, ctx, container_name):
            return False, f"Postgres container '{container_name}' not running"

        err_chunks: list[bytes] = []

        async def on_stderr(data: bytes):
            err_chunks.append(data)

        try:
            code = await client.exec(
                ctx,
                ExecSpec(
                    container=container_name,
                    cmd=["psql", "-U", "admin", "-d", "postgres"],
                ),
                stdin=dump_content,
                on_stderr=on_stderr,
            )
        except InfraDriverError as e:
            return False, f"psql restore failed: {e}"
        if code != 0:
            return (
                False,
                f"psql restore failed: {b''.join(err_chunks).decode('utf-8', 'replace')}",
            )

        return True, f"Postgres restored to {stage} stage"
    finally:
        shutil.rmtree(restore_dir, ignore_errors=True)


async def restore_couchdb(
    config: dict, snapshot_id: str, stage: str = "production"
) -> tuple[bool, str]:
    """Restore a CouchDB snapshot to a given stage."""
    from app.services.infra_service import get_service

    workspace_name = os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace-local")

    restore_dir = tempfile.mkdtemp(prefix="couch-restore-")
    try:
        ok, msg = await restore_snapshot(config, snapshot_id, restore_dir)
        if not ok:
            return False, msg

        # Find the backup tarball
        tar_file = None
        for root, dirs, files in os.walk(restore_dir):
            for f in files:
                if f.endswith(".tar.gz"):
                    tar_file = os.path.join(root, f)
                    break
            if tar_file:
                break

        if not tar_file:
            return False, "No CouchDB backup archive found in snapshot"

        svc = get_service("couchdb", workspace_name, stage=stage)
        await svc.restore(tar_file, force=True)
        return True, f"CouchDB restored to {stage} stage"
    except Exception as e:
        return False, str(e)
    finally:
        shutil.rmtree(restore_dir, ignore_errors=True)


async def restore_workspace(config: dict, snapshot_id: str) -> tuple[bool, str]:
    """Restore workspace files to /workspace-repo/restores/{datetime}."""
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
    workspace_dir = os.environ.get("BITSWAN_WORKSPACE_REPO_DIR", "/workspace-repo")
    target = os.path.join(workspace_dir, f"restores/{timestamp}")
    return await restore_snapshot(config, snapshot_id, target)
