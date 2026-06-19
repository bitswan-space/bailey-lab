"""
Per-BP stage-snapshot engine.

A snapshot captures one business process's DATA (its per-BP Postgres
database, CouchDB databases under the BP prefix, and MinIO bucket — see
`bp_databases.py`) at one stage, as local files on the gitops server:

    {BITSWAN_GITOPS_DIR}/snapshots/{bp_slug}/{stage}/{snapshot_id}/
        manifest.json
        postgres.sql.gz      (pg_dump of the per-BP database)
        couchdb.tar.gz       ({db}.json per prefixed database + manifest)
        minio.tar.gz         (bucket contents via mc mirror)

Because the per-BP resource names contain no stage, a snapshot taken at any
stage restores into any other stage verbatim. Restores use REPLACE
semantics: the target's current data is auto-snapshotted (kind=auto), then
cleared, then loaded. Code/deployments are never touched.

Distinct from the restic/S3 disaster-recovery system in
`app/routes/backups.py`, which backs up whole servers off-site.

Dumps and loads are STREAMED between the service containers and the
snapshot files — never buffered whole in Python (unlike the legacy
whole-server `postgres_service.backup()`).
"""

import asyncio
import gzip
import json
import logging
import os
import re
import shutil
import tarfile
import tempfile
import uuid
from datetime import datetime, timezone

from app.services.bp_databases import (
    bp_resource_names,
    get_bp_entry,
    get_service_secrets,
    load_registry,
    validate_bp_slug,
)
from app.services.infra_service import get_service
from app.utils import SERVICE_REALMS

logger = logging.getLogger(__name__)

MANIFEST_VERSION = 1
SNAPSHOT_DATA_SERVICES = ("postgres", "couchdb", "minio")
AUTO_SNAPSHOTS_KEEP = 5

_SNAPSHOT_ID_RE = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{8}$")

_SERVICE_FILES = {
    "postgres": "postgres.sql.gz",
    "couchdb": "couchdb.tar.gz",
    "minio": "minio.tar.gz",
}


def validate_stage_name(stage: str) -> None:
    if stage not in SERVICE_REALMS:
        raise ValueError(
            f"Invalid stage '{stage}': must be one of {sorted(SERVICE_REALMS)}"
        )


def validate_snapshot_id(snapshot_id: str) -> None:
    """Snapshot ids become path segments — validate before ANY path join."""
    if not snapshot_id or not _SNAPSHOT_ID_RE.match(snapshot_id):
        raise ValueError(f"Invalid snapshot id: {snapshot_id!r}")


def new_snapshot_id() -> str:
    now = datetime.now(timezone.utc)
    return f"{now.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"


# ---------------------------------------------------------------------------
# streaming docker-exec helpers
# ---------------------------------------------------------------------------


async def run_docker_command_to_file(
    args: list[str], out_path: str, gzip_output: bool = False
) -> tuple[str, int]:
    """Run a command and stream its stdout to `out_path` chunk by chunk.

    With `gzip_output=True` the stream is gzip-compressed on the way down.
    Returns (stderr, returncode). Constant memory regardless of dump size.
    """
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    # Drain stderr concurrently so a chatty command can't deadlock the pipe.
    stderr_task = asyncio.create_task(proc.stderr.read())
    opener = gzip.open if gzip_output else open
    with opener(out_path, "wb") as f:
        while True:
            chunk = await proc.stdout.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)
    stderr = await stderr_task
    rc = await proc.wait()
    return stderr.decode(errors="replace"), rc


async def run_docker_command_from_file(
    args: list[str], in_path: str, gunzip_input: bool = False
) -> tuple[str, str, int]:
    """Run a command streaming `in_path` into its stdin chunk by chunk.

    With `gunzip_input=True` the file is gzip-decompressed on the way up.
    Returns (stdout, stderr, returncode).
    """
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout_task = asyncio.create_task(proc.stdout.read())
    stderr_task = asyncio.create_task(proc.stderr.read())
    opener = gzip.open if gunzip_input else open
    try:
        with opener(in_path, "rb") as f:
            while True:
                chunk = f.read(1 << 16)
                if not chunk:
                    break
                proc.stdin.write(chunk)
                await proc.stdin.drain()
    except (BrokenPipeError, ConnectionResetError):
        pass  # command exited early — its rc/stderr tell the story
    finally:
        try:
            proc.stdin.close()
        except (BrokenPipeError, ConnectionResetError):
            pass
    stdout = await stdout_task
    stderr = await stderr_task
    rc = await proc.wait()
    return stdout.decode(errors="replace"), stderr.decode(errors="replace"), rc


async def run_docker_command(*args: str) -> tuple[str, str, int]:
    """Plain (non-streaming) command. Module-level so tests can fake it."""
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    return (
        stdout.decode(errors="replace"),
        stderr.decode(errors="replace"),
        proc.returncode,
    )


# ---------------------------------------------------------------------------
# service
# ---------------------------------------------------------------------------


class SnapshotService:
    def __init__(self, workspace_name: str | None = None):
        self.workspace_name = workspace_name or os.environ.get(
            "BITSWAN_WORKSPACE_NAME", "workspace-local"
        )

    # -- paths ---------------------------------------------------------------

    @property
    def snapshots_root(self) -> str:
        bs_home = os.environ.get("BITSWAN_GITOPS_DIR", "/mnt/repo/pipeline")
        return os.path.join(bs_home, "snapshots")

    def _bp_dir(self, bp_slug: str) -> str:
        validate_bp_slug(bp_slug)
        return os.path.join(self.snapshots_root, bp_slug)

    def _stage_dir(self, bp_slug: str, stage: str) -> str:
        validate_stage_name(stage)
        return os.path.join(self._bp_dir(bp_slug), stage)

    def _snapshot_dir(self, bp_slug: str, stage: str, snapshot_id: str) -> str:
        validate_snapshot_id(snapshot_id)
        return os.path.join(self._stage_dir(bp_slug, stage), snapshot_id)

    # -- eligibility / validation ---------------------------------------------

    async def validate_target(
        self, bp_slug: str, stage: str, required: list[str] | None = None
    ) -> dict[str, dict]:
        """Live availability of the BP's data services at one stage.

        Returns {service: {"available": bool, "reason": str|None}}. With
        `required`, raises ValueError when any required service is
        unavailable — used by restore to fail BEFORE any destructive step.
        """
        validate_bp_slug(bp_slug)
        validate_stage_name(stage)
        out: dict[str, dict] = {}
        for svc_type in SNAPSHOT_DATA_SERVICES:
            try:
                svc = get_service(svc_type, self.workspace_name, stage=stage)
                if not svc.is_enabled():
                    out[svc_type] = {"available": False, "reason": "not enabled"}
                elif not await svc.is_running():
                    out[svc_type] = {"available": False, "reason": "not running"}
                else:
                    out[svc_type] = {"available": True, "reason": None}
            except Exception as e:
                out[svc_type] = {"available": False, "reason": str(e)}
        if required:
            missing = [s for s in required if not out.get(s, {}).get("available")]
            if missing:
                details = ", ".join(
                    f"{s} ({out.get(s, {}).get('reason', 'unknown')})" for s in missing
                )
                raise ValueError(
                    f"Cannot restore into {stage}: required services unavailable: {details}"
                )
        return out

    def eligibility(self, bp_slug: str) -> dict:
        """Registry view: which stages of this BP are snapshot-eligible."""
        validate_bp_slug(bp_slug)
        registry = load_registry()
        entry = get_bp_entry(registry, bp_slug)
        stages = {}
        if entry:
            for realm in sorted(SERVICE_REALMS):
                stage_entry = entry.get("stages", {}).get(realm)
                stages[realm] = {
                    "registered": stage_entry is not None,
                    "services": {
                        s: bool(
                            (stage_entry or {})
                            .get("services", {})
                            .get(s, {})
                            .get("provisioned")
                        )
                        for s in SNAPSHOT_DATA_SERVICES
                    },
                }
        else:
            for realm in sorted(SERVICE_REALMS):
                stages[realm] = {
                    "registered": False,
                    "services": {s: False for s in SNAPSHOT_DATA_SERVICES},
                }
        return {
            "bp": bp_slug,
            "bp_name": (entry or {}).get("bp_name") or bp_slug,
            "registered": entry is not None,
            "stages": stages,
        }

    # -- create ----------------------------------------------------------------

    async def create_snapshot(
        self,
        bp_slug: str,
        stage: str,
        label: str = "",
        kind: str = "manual",
        source: dict | None = None,
        progress=None,
    ) -> dict:
        """Snapshot the BP's data at `stage`. Returns the manifest.

        Includes every data service that is currently available; raises
        ValueError when none is. Files are written into a temp dir first and
        renamed into place, so a crashed snapshot never lists.
        """
        if kind not in ("manual", "auto"):
            raise ValueError(f"Invalid snapshot kind: {kind!r}")

        async def _report(step: str, message: str):
            if progress is not None:
                await progress(step, message)

        availability = await self.validate_target(bp_slug, stage)
        included = [s for s in SNAPSHOT_DATA_SERVICES if availability[s]["available"]]
        if not included:
            raise ValueError(
                f"No data services available for BP '{bp_slug}' at {stage} — "
                "nothing to snapshot"
            )

        registry = load_registry()
        entry = get_bp_entry(registry, bp_slug) or {}
        names = bp_resource_names(bp_slug)
        snapshot_id = new_snapshot_id()

        stage_dir = self._stage_dir(bp_slug, stage)
        os.makedirs(stage_dir, exist_ok=True)
        tmp_dir = tempfile.mkdtemp(prefix=f".{snapshot_id}-", dir=stage_dir)

        services_meta: dict[str, dict] = {}
        try:
            for svc_type in SNAPSHOT_DATA_SERVICES:
                if svc_type not in included:
                    services_meta[svc_type] = {
                        "included": False,
                        "reason": availability[svc_type]["reason"],
                    }
                    continue
                await _report(
                    f"snapshot_{svc_type}",
                    f"Snapshotting {svc_type} data...",
                )
                out_file = os.path.join(tmp_dir, _SERVICE_FILES[svc_type])
                if svc_type == "postgres":
                    extra = await self._dump_postgres(stage, names, out_file)
                elif svc_type == "couchdb":
                    extra = await self._dump_couchdb(stage, names, out_file)
                else:
                    extra = await self._dump_minio(stage, names, out_file)
                services_meta[svc_type] = {
                    "included": True,
                    "file": _SERVICE_FILES[svc_type],
                    "size_bytes": os.path.getsize(out_file),
                    **extra,
                }

            manifest = {
                "version": MANIFEST_VERSION,
                "id": snapshot_id,
                "bp": bp_slug,
                "bp_name": entry.get("bp_name") or bp_slug,
                "stage": stage,
                "label": label or "",
                "kind": kind,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "workspace": self.workspace_name,
                "services": services_meta,
                "total_size_bytes": sum(
                    m.get("size_bytes", 0) for m in services_meta.values()
                ),
            }
            if source:
                manifest["source"] = source
            with open(os.path.join(tmp_dir, "manifest.json"), "w") as f:
                json.dump(manifest, f, indent=2)

            final_dir = self._snapshot_dir(bp_slug, stage, snapshot_id)
            os.rename(tmp_dir, final_dir)
            logger.info(
                "Snapshot %s of BP '%s' at %s complete (%d bytes)",
                snapshot_id,
                bp_slug,
                stage,
                manifest["total_size_bytes"],
            )
            return manifest
        except BaseException:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise

    # -- restore ----------------------------------------------------------------

    async def restore_snapshot(
        self,
        bp_slug: str,
        snapshot_id: str,
        source_stage: str,
        target_stage: str,
        progress=None,
        pre_restore_snapshot: bool = True,
        db: int | None = None,
    ) -> dict:
        """Replace the BP's data at `target_stage` with the snapshot's content.

        Order: validate (nothing destructive yet) → auto-snapshot the target
        → prune auto-snapshots → clear+load per service (PG → CouchDB →
        MinIO). On a mid-restore failure the raised error names the
        pre-restore snapshot so the user can roll back.
        """

        async def _report(step: str, message: str):
            if progress is not None:
                await progress(step, message)

        await _report("validating", "Validating restore target...")
        manifest = self.get_snapshot(bp_slug, source_stage, snapshot_id)
        included = [
            s
            for s in SNAPSHOT_DATA_SERVICES
            if manifest.get("services", {}).get(s, {}).get("included")
        ]
        if not included:
            raise ValueError(f"Snapshot {snapshot_id} contains no data services")

        # Fails with ValueError before anything is touched.
        await self.validate_target(bp_slug, target_stage, required=included)

        # Make sure the target realm is registered + its per-BP objects
        # exist (restoring into a never-deployed stage is allowed — it's an
        # explicit user action, equivalent to provisioning).
        from app.services.bp_databases import ensure_bp_databases

        await ensure_bp_databases(
            self.workspace_name,
            bp_slug,
            manifest.get("bp_name") or bp_slug,
            target_stage,
            services=included,
            db=db,
        )

        # A db-targeted restore writes the production STANDBY db — DR scratch
        # data whose whole purpose is to be overwritten, so there is nothing
        # worth auto-snapshotting first (and create_snapshot is db-free anyway).
        pre_id = None
        if pre_restore_snapshot and db is None:
            await _report(
                "pre_restore_snapshot",
                f"Auto-snapshotting current {target_stage} data...",
            )
            pre = await self.create_snapshot(
                bp_slug,
                target_stage,
                label=f"auto before restore of {snapshot_id}",
                kind="auto",
                source={
                    "reason": "pre-restore",
                    "restored_snapshot_id": snapshot_id,
                    "restored_from_stage": source_stage,
                },
            )
            pre_id = pre["id"]
            await _report("pruning", "Pruning old auto-snapshots...")
            self.prune_auto_snapshots(bp_slug, target_stage, keep_ids={pre_id})

        names = bp_resource_names(bp_slug, db)
        snap_dir = self._snapshot_dir(bp_slug, source_stage, snapshot_id)
        try:
            for svc_type in SNAPSHOT_DATA_SERVICES:
                if svc_type not in included:
                    continue
                await _report(
                    f"restore_{svc_type}",
                    f"Restoring {svc_type} data into {target_stage}...",
                )
                in_file = os.path.join(snap_dir, manifest["services"][svc_type]["file"])
                if svc_type == "postgres":
                    await self._restore_postgres(target_stage, names, in_file)
                elif svc_type == "couchdb":
                    await self._restore_couchdb(target_stage, names, in_file)
                else:
                    # The minio archive is rooted at the bucket it was taken
                    # FROM; for a blue-green DR restore that source bucket (live
                    # db) differs from the target bucket (standby db), so pass
                    # it through rather than assuming it matches the target.
                    src_bucket = (manifest["services"].get("minio") or {}).get(
                        "bucket"
                    ) or names["minio_bucket"]
                    await self._restore_minio(target_stage, names, in_file, src_bucket)
        except Exception as e:
            hint = (
                f" The target's pre-restore state was saved as snapshot "
                f"{pre_id} on {target_stage} — restore it to roll back."
                if pre_id
                else ""
            )
            raise RuntimeError(f"Restore failed mid-way: {e}.{hint}") from e

        logger.info(
            "Restored snapshot %s of BP '%s' (%s → %s)",
            snapshot_id,
            bp_slug,
            source_stage,
            target_stage,
        )
        return {
            "restored": snapshot_id,
            "bp": bp_slug,
            "source_stage": source_stage,
            "target_stage": target_stage,
            "pre_restore_snapshot_id": pre_id,
            "services": included,
        }

    # -- listing / deletion ------------------------------------------------------

    def get_snapshot(self, bp_slug: str, stage: str, snapshot_id: str) -> dict:
        snap_dir = self._snapshot_dir(bp_slug, stage, snapshot_id)
        manifest_path = os.path.join(snap_dir, "manifest.json")
        if not os.path.exists(manifest_path):
            raise LookupError(
                f"Snapshot {snapshot_id} not found for BP '{bp_slug}' at {stage}"
            )
        with open(manifest_path) as f:
            return json.load(f)

    def list_snapshots(self, bp_slug: str) -> list[dict]:
        """All snapshots of one BP across stages, newest first."""
        validate_bp_slug(bp_slug)
        out: list[dict] = []
        bp_dir = self._bp_dir(bp_slug)
        if not os.path.isdir(bp_dir):
            return out
        for stage in sorted(SERVICE_REALMS):
            stage_dir = os.path.join(bp_dir, stage)
            if not os.path.isdir(stage_dir):
                continue
            for snapshot_id in os.listdir(stage_dir):
                if not _SNAPSHOT_ID_RE.match(snapshot_id):
                    continue  # temp dirs, strays
                try:
                    out.append(self.get_snapshot(bp_slug, stage, snapshot_id))
                except (LookupError, json.JSONDecodeError, OSError) as e:
                    logger.warning(
                        "Skipping unreadable snapshot %s/%s/%s: %s",
                        bp_slug,
                        stage,
                        snapshot_id,
                        e,
                    )
        out.sort(key=lambda m: m.get("created_at", ""), reverse=True)
        return out

    def delete_snapshot(self, bp_slug: str, stage: str, snapshot_id: str) -> None:
        snap_dir = self._snapshot_dir(bp_slug, stage, snapshot_id)
        if not os.path.isdir(snap_dir):
            raise LookupError(
                f"Snapshot {snapshot_id} not found for BP '{bp_slug}' at {stage}"
            )
        shutil.rmtree(snap_dir)
        logger.info("Deleted snapshot %s/%s/%s", bp_slug, stage, snapshot_id)

    def prune_auto_snapshots(
        self,
        bp_slug: str,
        stage: str,
        keep: int = AUTO_SNAPSHOTS_KEEP,
        keep_ids: set[str] | None = None,
    ) -> list[str]:
        """Delete auto-snapshots beyond the `keep` newest at one stage.

        Manual snapshots are never pruned. `keep_ids` are always kept (the
        just-taken pre-restore snapshot must survive its own prune pass).
        Returns the deleted ids.
        """
        autos = [
            m
            for m in self.list_snapshots(bp_slug)
            if m.get("stage") == stage and m.get("kind") == "auto"
        ]
        autos.sort(key=lambda m: m.get("created_at", ""), reverse=True)
        deleted = []
        for m in autos[keep:]:
            if keep_ids and m["id"] in keep_ids:
                continue
            try:
                self.delete_snapshot(bp_slug, stage, m["id"])
                deleted.append(m["id"])
            except OSError as e:
                logger.warning("Failed to prune snapshot %s: %s", m["id"], e)
        return deleted

    def disk_usage(self, bp_slug: str) -> int:
        """Total bytes used by all of one BP's snapshots."""
        validate_bp_slug(bp_slug)
        total = 0
        bp_dir = self._bp_dir(bp_slug)
        for root, _dirs, files in os.walk(bp_dir):
            for fname in files:
                try:
                    total += os.path.getsize(os.path.join(root, fname))
                except OSError:
                    pass
        return total

    # -- per-service dump/clear/load ----------------------------------------------

    def _container(self, svc_type: str, stage: str) -> str:
        return get_service(svc_type, self.workspace_name, stage=stage).container_name

    @staticmethod
    def _secrets(svc_type: str, stage: str) -> dict:
        secrets = get_service_secrets(svc_type, stage)
        if not secrets:
            raise RuntimeError(f"No {svc_type} secrets for stage {stage}")
        return secrets

    # postgres ---------------------------------------------------------------

    async def _dump_postgres(self, stage: str, names: dict, out_file: str) -> dict:
        container = self._container("postgres", stage)
        user = self._secrets("postgres", stage).get("POSTGRES_USER", "admin")
        db = names["postgres_db"]
        stderr, rc = await run_docker_command_to_file(
            ["docker", "exec", container, "pg_dump", "-U", user, db],
            out_file,
            gzip_output=True,
        )
        if rc != 0:
            raise RuntimeError(f"pg_dump of {db} failed: {stderr.strip()}")
        return {"database": db}

    async def _psql(self, container: str, user: str, sql: str) -> None:
        stdout, stderr, rc = await run_docker_command(
            "docker",
            "exec",
            container,
            "psql",
            "-U",
            user,
            "-d",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            sql,
        )
        if rc != 0:
            raise RuntimeError(f"psql failed ({sql[:60]}...): {stderr.strip()}")

    async def _restore_postgres(self, stage: str, names: dict, in_file: str) -> None:
        container = self._container("postgres", stage)
        user = self._secrets("postgres", stage).get("POSTGRES_USER", "admin")
        db = names["postgres_db"]
        # Replace semantics: drop + recreate the per-BP database, then load.
        await self._psql(
            container,
            user,
            f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            f"WHERE datname = '{db}' AND pid <> pg_backend_pid();",
        )
        await self._psql(container, user, f'DROP DATABASE IF EXISTS "{db}";')
        await self._psql(container, user, f'CREATE DATABASE "{db}";')
        _, stderr, rc = await run_docker_command_from_file(
            [
                "docker",
                "exec",
                "-i",
                container,
                "psql",
                "-U",
                user,
                "-d",
                db,
                "-v",
                "ON_ERROR_STOP=1",
            ],
            in_file,
            gunzip_input=True,
        )
        if rc != 0:
            raise RuntimeError(f"psql load into {db} failed: {stderr.strip()}")

    # couchdb ----------------------------------------------------------------

    async def _couch_curl(
        self, container: str, user: str, password: str, method: str, path: str
    ) -> tuple[str, int]:
        stdout, stderr, rc = await run_docker_command(
            "docker",
            "exec",
            container,
            "curl",
            "-s",
            "-X",
            method,
            "-u",
            f"{user}:{password}",
            f"http://localhost:5984{path}",
        )
        if rc != 0:
            raise RuntimeError(f"CouchDB {method} {path} failed: {stderr.strip()}")
        return stdout, rc

    async def _couch_prefixed_dbs(
        self, container: str, user: str, password: str, prefix: str
    ) -> list[str]:
        stdout, _ = await self._couch_curl(
            container, user, password, "GET", "/_all_dbs"
        )
        try:
            all_dbs = json.loads(stdout)
        except json.JSONDecodeError:
            raise RuntimeError(f"CouchDB _all_dbs returned non-JSON: {stdout[:200]}")
        return [db for db in all_dbs if db.startswith(prefix)]

    async def _dump_couchdb(self, stage: str, names: dict, out_file: str) -> dict:
        container = self._container("couchdb", stage)
        secrets = self._secrets("couchdb", stage)
        user = secrets.get("COUCHDB_USER", "admin")
        password = secrets.get("COUCHDB_PASSWORD", "")
        prefix = names["couchdb_prefix"]

        dbs = await self._couch_prefixed_dbs(container, user, password, prefix)
        temp_dir = tempfile.mkdtemp(prefix="bp-couchdb-snap-")
        try:
            for db in dbs:
                stderr, rc = await run_docker_command_to_file(
                    [
                        "docker",
                        "exec",
                        container,
                        "curl",
                        "-s",
                        "-u",
                        f"{user}:{password}",
                        f"http://localhost:5984/{db}/_all_docs?include_docs=true",
                    ],
                    os.path.join(temp_dir, f"{db}.json"),
                )
                if rc != 0:
                    raise RuntimeError(
                        f"CouchDB dump of '{db}' failed: {stderr.strip()}"
                    )
            with open(os.path.join(temp_dir, "manifest.json"), "w") as f:
                json.dump({"version": 1, "databases": dbs, "prefix": prefix}, f)
            with tarfile.open(out_file, "w:gz") as tar:
                for item in os.listdir(temp_dir):
                    tar.add(os.path.join(temp_dir, item), arcname=item)
            return {"databases": dbs}
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    async def _clear_couchdb(self, stage: str, names: dict) -> None:
        container = self._container("couchdb", stage)
        secrets = self._secrets("couchdb", stage)
        user = secrets.get("COUCHDB_USER", "admin")
        password = secrets.get("COUCHDB_PASSWORD", "")
        for db in await self._couch_prefixed_dbs(
            container, user, password, names["couchdb_prefix"]
        ):
            await self._couch_curl(container, user, password, "DELETE", f"/{db}")

    async def _restore_couchdb(self, stage: str, names: dict, in_file: str) -> None:
        container = self._container("couchdb", stage)
        secrets = self._secrets("couchdb", stage)
        user = secrets.get("COUCHDB_USER", "admin")
        password = secrets.get("COUCHDB_PASSWORD", "")
        prefix = names["couchdb_prefix"]

        extract_dir = tempfile.mkdtemp(prefix="bp-couchdb-restore-")
        try:
            with tarfile.open(in_file, "r:gz") as tar:
                tar.extractall(extract_dir, filter="data")

            manifest_path = os.path.join(extract_dir, "manifest.json")
            databases: list[str] = []
            if os.path.exists(manifest_path):
                with open(manifest_path) as f:
                    databases = json.load(f).get("databases", [])
            else:
                databases = [
                    fname[: -len(".json")]
                    for fname in os.listdir(extract_dir)
                    if fname.endswith(".json")
                ]
            # Only ever touch databases under OUR prefix, no matter what the
            # archive claims.
            databases = [db for db in databases if db.startswith(prefix)]

            # Replace semantics: drop every prefixed DB, then recreate from
            # the archive.
            await self._clear_couchdb(stage, names)

            for db in databases:
                docs_path = os.path.join(extract_dir, f"{db}.json")
                if not os.path.exists(docs_path):
                    logger.warning("CouchDB archive missing dump for '%s'", db)
                    continue
                await self._couch_curl(container, user, password, "PUT", f"/{db}")
                with open(docs_path) as f:
                    dump = json.load(f)
                docs = []
                for row in dump.get("rows", []):
                    doc = row.get("doc") or {}
                    doc.pop("_rev", None)
                    docs.append(doc)
                if not docs:
                    continue
                payload = json.dumps({"docs": docs})
                with tempfile.NamedTemporaryFile(
                    "w", suffix=".json", delete=False
                ) as tmp:
                    tmp.write(payload)
                    payload_path = tmp.name
                try:
                    stdout, stderr, rc = await run_docker_command_from_file(
                        [
                            "docker",
                            "exec",
                            "-i",
                            container,
                            "sh",
                            "-c",
                            f"curl -s -X POST -H 'Content-Type: application/json' "
                            f"-u '{user}:{password}' --data-binary @- "
                            f"'http://localhost:5984/{db}/_bulk_docs'",
                        ],
                        payload_path,
                    )
                    if rc != 0:
                        raise RuntimeError(
                            f"CouchDB _bulk_docs into '{db}' failed: {stderr.strip()}"
                        )
                finally:
                    os.unlink(payload_path)
        finally:
            shutil.rmtree(extract_dir, ignore_errors=True)

    # minio --------------------------------------------------------------------

    async def _mc_alias(self, container: str, stage: str) -> None:
        secrets = self._secrets("minio", stage)
        _, stderr, rc = await run_docker_command(
            "docker",
            "exec",
            container,
            "mc",
            "alias",
            "set",
            "local",
            "http://localhost:9000",
            secrets.get("MINIO_ROOT_USER", "admin"),
            secrets.get("MINIO_ROOT_PASSWORD", ""),
        )
        if rc != 0:
            raise RuntimeError(f"mc alias set failed: {stderr.strip()}")

    async def _dump_minio(self, stage: str, names: dict, out_file: str) -> dict:
        container = self._container("minio", stage)
        bucket = names["minio_bucket"]
        await self._mc_alias(container, stage)
        # Per-bucket scratch dir so concurrent dump/restore of different BPs on
        # the same minio container can't clobber each other.
        scratch = f"/tmp/bpsnap-{bucket}"
        try:
            _, stderr, rc = await run_docker_command(
                "docker",
                "exec",
                container,
                "sh",
                "-c",
                f"rm -rf {scratch} && mkdir -p {scratch} && "
                f"mc mb --ignore-existing local/{bucket} && "
                f"mc mirror local/{bucket} {scratch}",
            )
            if rc != 0:
                raise RuntimeError(f"mc mirror of {bucket} failed: {stderr.strip()}")
            # Stream the mirrored objects out as a tar via `docker cp` and gzip
            # on our end. The archiving is done by the docker daemon, so this
            # works even though the minio image (UBI-micro) ships no `tar`.
            # The archive is rooted at the scratch dir's basename.
            stderr, rc = await run_docker_command_to_file(
                ["docker", "cp", f"{container}:{scratch}", "-"],
                out_file,
                gzip_output=True,
            )
            if rc != 0:
                raise RuntimeError(f"docker cp of {bucket} failed: {stderr.strip()}")
            return {"bucket": bucket}
        finally:
            await run_docker_command("docker", "exec", container, "rm", "-rf", scratch)

    async def _restore_minio(
        self, stage: str, names: dict, in_file: str, src_bucket: str
    ) -> None:
        container = self._container("minio", stage)
        bucket = names["minio_bucket"]
        await self._mc_alias(container, stage)
        # The dump archive is rooted at `bpsnap-{src_bucket}` (the bucket it was
        # taken from), which `docker cp - :/tmp` recreates under /tmp. That
        # source bucket may differ from the target `bucket` (blue-green DR
        # restores load the live db's snapshot into the standby db's bucket), so
        # mirror FROM the archive's own root dir INTO the target bucket.
        scratch = f"/tmp/bpsnap-{src_bucket}"
        try:
            await run_docker_command("docker", "exec", container, "rm", "-rf", scratch)
            # Stream the tar in via `docker cp` (gunzipped on our end; extraction
            # is done by the docker daemon, so no `tar` is needed in the image).
            _, stderr, rc = await run_docker_command_from_file(
                ["docker", "cp", "-", f"{container}:/tmp"],
                in_file,
                gunzip_input=True,
            )
            if rc != 0:
                raise RuntimeError(f"docker cp into {bucket} failed: {stderr.strip()}")
            # Replace semantics: recreate the bucket empty, then mirror in.
            _, stderr, rc = await run_docker_command(
                "docker",
                "exec",
                container,
                "sh",
                "-c",
                f"mc mb --ignore-existing local/{bucket} && "
                f"mc rm --recursive --force local/{bucket} ; "
                f"mc mirror --overwrite {scratch} local/{bucket}",
            )
            if rc != 0:
                raise RuntimeError(f"mc mirror into {bucket} failed: {stderr.strip()}")
        finally:
            await run_docker_command("docker", "exec", container, "rm", "-rf", scratch)


# Singleton (constructed lazily so env vars are read at first use).
_snapshot_service: SnapshotService | None = None


def get_snapshot_service() -> SnapshotService:
    global _snapshot_service
    if _snapshot_service is None:
        _snapshot_service = SnapshotService()
    return _snapshot_service
