"""
Read-only data explorer backing the workspace-dashboard's "Object Storage"
and "SQL" panels.

Scope: given a (BP, stage[, copy][, blue-green db]) the module resolves the
deployment's concrete per-BP Postgres database / Garage S3 bucket (reusing
the canonical name derivation in `bp_databases`) and serves read-only browse
operations against them. gitops has no TCP route to the data services (they
live on the per-stage docker networks, gitops doesn't) and no psycopg/boto3,
so — exactly like snapshots/backups — everything runs as `docker exec`
through the infra-driver: `psql` in the postgres container, `rclone` in the
garage toolbox sidecar (the garage image itself is a bare static binary).

Read-only guarantees:
  - SQL runs as the passwordless `ro_<db>` role (SELECT-only, provisioned by
    the driver's `ensureBPRole`; see `scopedROPGRole` in the automation
    server's bpcreds.go — `_ro_role` below MUST mirror that derivation).
    Table/column names are only ever interpolated after a byte-for-byte
    membership check against our own listing query for the same request.
  - Object storage exposes list/stat/preview/download only; commands are
    argv-style execs (never user input through `sh -c`).

Error contract (mapped by routes/data_explorer.py): ValueError → 400,
LookupError → 404, ExplorerUnavailableError → 503, RuntimeError → 500.
"""

import base64
import json
import logging
import os
import re
import shutil
import tarfile
import tempfile
import uuid

from app.services import bp_databases
from app.services.bp_databases import (
    bp_resource_names,
    copy_bp_resource_names,
    get_service_secrets,
    is_registered,
    load_registry,
)
from app.utils import SERVICE_REALMS, sanitize_automation_name

logger = logging.getLogger(__name__)

# Payload bounds. Cells are truncated server-side so a bytea/jsonb blob can
# never balloon a rows page; preview/download are stat-gated before any copy.
MAX_ROW_LIMIT = 200
DEFAULT_ROW_LIMIT = 50
MAX_OFFSET = 1_000_000
CELL_MAX_CHARS = 2048
PREVIEW_DEFAULT_BYTES = 256 * 1024
PREVIEW_MAX_BYTES = 1024 * 1024
DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024


class ExplorerUnavailableError(RuntimeError):
    """The backing service exists but can't serve right now (container down)."""


async def _exec(*args: str) -> tuple[str, str, int]:
    """Driver-proxied `docker exec` (tests monkeypatch this seam)."""
    return await bp_databases._driver_exec(*args)


def _workspace() -> str:
    return os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace-local")


def _ro_role(db_name: str) -> str:
    # Mirrors scopedROPGRole in the automation server's bpcreds.go (63-byte
    # Postgres identifier cap). The two derivations MUST stay in sync or the
    # explorer authenticates as a role the driver never created.
    return ("ro_" + db_name)[:63]


def _scoped_pg_role(db_name: str) -> str:
    return ("u_" + db_name)[:63]


# =============================================================================
# Target resolution
# =============================================================================


class Target:
    def __init__(
        self,
        bp: str,
        stage: str,
        copy: str,
        db: int | None,
        postgres_db: str,
        s3_bucket: str,
    ):
        self.bp = bp
        self.stage = stage
        self.realm = stage  # SERVICE_REALMS members are their own realm
        self.copy = copy
        self.db = db
        self.postgres_db = postgres_db
        self.s3_bucket = s3_bucket
        ws = _workspace()
        self.pg_container = bp_databases._container_name(ws, "postgres", self.realm)
        self.garage_container = bp_databases._container_name(ws, "garage", self.realm)
        # The garage image is a single static binary; all S3 data-plane work
        # (rclone) execs into its toolbox sidecar instead.
        self.toolbox_container = self.garage_container + "-toolbox"


_COPY_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


def resolve_target(
    bp: str, stage: str, copy: str = "", db: int | None = None
) -> Target:
    """Resolve a deployment to its concrete per-BP resource names.

    - dev/staging registered BP:  bp_<slug> / bp-<slug>
    - production registered BP:   bp_<slug>_<db> / bp-<slug>-<db>, db defaulting
      to the LIVE blue-green slot (bitswan.yaml `backups.<bp>.live_db`)
    - live-dev non-main copy:     copy_<copy>_bp_<slug> (stage must be dev;
      "main" normalizes to the plain dev names, mirroring derive_bp_and_copy)
    """
    slug = sanitize_automation_name(bp)
    bp_databases.validate_bp_slug(slug)
    if stage not in SERVICE_REALMS:
        raise ValueError(
            f"Invalid stage '{stage}': must be one of {sorted(SERVICE_REALMS)}"
        )

    if copy == "main":
        copy = ""
    if copy:
        if stage != "dev":
            raise ValueError("A copy scope is only valid at the dev stage")
        if not _COPY_RE.match(copy):
            raise ValueError(f"Invalid copy name: {copy!r}")
        if db is not None:
            raise ValueError("Blue-green db selection is production-only")
        names = copy_bp_resource_names(copy, slug)
        return Target(slug, stage, copy, None, names["postgres_db"],
                      names["s3_bucket"])

    if stage == "production":
        if db is None:
            from app.dependencies import get_automation_service

            db = get_automation_service().live_db(slug)
        if db not in (1, 2):
            raise ValueError(f"Invalid blue-green db: {db!r} (want 1 or 2)")
    elif db is not None:
        raise ValueError("Blue-green db selection is production-only")

    if not is_registered(load_registry(), slug, stage):
        raise LookupError(
            f"BP '{slug}' has no per-BP databases at stage '{stage}'"
        )
    names = bp_resource_names(slug, db)
    return Target(slug, stage, "", db, names["postgres_db"], names["s3_bucket"])


def _service_state(service_type: str, realm: str):
    from app.services.infra_service import get_service

    return get_service(service_type, _workspace(), stage=realm)


async def _require_service(service_type: str, realm: str) -> None:
    svc = _service_state(service_type, realm)
    if not svc.is_enabled():
        raise LookupError(f"{service_type} is not enabled at stage '{realm}'")
    if not await svc.is_running():
        raise ExplorerUnavailableError(
            f"{service_type} container is not running at stage '{realm}'"
        )


async def overview(bp: str, stage: str, copy: str = "", db: int | None = None) -> dict:
    """Capability probe for the dashboard's state ladder — reports flags
    instead of raising for disabled/stopped services or unregistered BPs
    (invalid input still raises ValueError)."""
    try:
        target = resolve_target(bp, stage, copy, db)
        registered = True
    except LookupError:
        target = None
        registered = False

    out: dict = {
        "bp": sanitize_automation_name(bp),
        "stage": stage,
        "copy": copy if copy != "main" else "",
        "registered": registered,
    }
    for kind, resource in (
        ("postgres", "database"),
        ("garage", "bucket"),
    ):
        svc = _service_state(kind, stage)
        enabled = svc.is_enabled()
        running = await svc.is_running() if enabled else False
        entry = {"enabled": enabled, "running": running}
        if target is not None:
            entry[resource] = (
                target.postgres_db if kind == "postgres" else target.s3_bucket
            )
        out[kind] = entry
    if target is not None:
        out["db"] = target.db
    return out


# =============================================================================
# Identifier safety
# =============================================================================

_CTRL_RE = re.compile(r"[\x00-\x1f]")


def _validate_ident(name: str, what: str) -> None:
    if (
        not name
        or len(name.encode("utf-8", "replace")) > 63
        or _CTRL_RE.search(name)
    ):
        raise ValueError(f"Invalid {what}: {name!r}")


def _qident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _qlit(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


# =============================================================================
# SQL explorer (psql as ro_<db> over the container's trust-authed local socket)
# =============================================================================


async def _psql(target: Target, sql: str, *, _healed: bool = False) -> str:
    stdout, stderr, rc = await _exec(
        "docker",
        "exec",
        target.pg_container,
        "psql",
        "-U",
        _ro_role(target.postgres_db),
        "-d",
        target.postgres_db,
        "-t",
        "-A",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
    )
    if rc == 0:
        return stdout
    err = (stderr or "").strip()
    if f'database "{target.postgres_db}" does not exist' in err:
        raise LookupError(f"Database '{target.postgres_db}' does not exist")
    ro_missing = f'role "{_ro_role(target.postgres_db)}" does not exist' in err
    if not _healed and (ro_missing or "permission denied" in err):
        # ro_<db> is provisioned on deploy; DBs deployed before that driver
        # change — or freshly restored from a snapshot (restore drops and
        # recreates the database, wiping grants) — self-heal lazily here.
        await _ensure_ro_role(target)
        return await _psql(target, sql, _healed=True)
    raise RuntimeError(f"psql failed: {err}")


async def _ensure_ro_role(target: Target) -> None:
    """Idempotent twin of the driver's ensureBPRole ro-block, run as the shared
    superuser. The default-privileges grant is guarded on u_<db> existing
    (legacy DBs predate scoped roles)."""
    secrets = get_service_secrets("postgres", target.realm)
    if not secrets or not secrets.get("POSTGRES_USER"):
        raise LookupError(f"postgres is not enabled at stage '{target.realm}'")
    admin = secrets["POSTGRES_USER"]
    ro = _ro_role(target.postgres_db)
    u = _scoped_pg_role(target.postgres_db)
    db = target.postgres_db
    ensure = (
        f"DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = "
        f"{_qlit(ro)}) THEN CREATE ROLE {_qident(ro)} LOGIN CONNECTION LIMIT 3; "
        f"ELSE ALTER ROLE {_qident(ro)} WITH LOGIN CONNECTION LIMIT 3 "
        f"PASSWORD NULL; END IF; END $$; "
        f"GRANT CONNECT ON DATABASE {_qident(db)} TO {_qident(ro)};"
    )
    grants = (
        f"GRANT USAGE ON SCHEMA public TO {_qident(ro)}; "
        f"GRANT SELECT ON ALL TABLES IN SCHEMA public TO {_qident(ro)}; "
        f"DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname = "
        f"{_qlit(u)}) THEN EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE "
        f'{_qident(u)} IN SCHEMA public GRANT SELECT ON TABLES TO '
        f"{_qident(ro)}'; END IF; END $$;"
    )
    for dbname, sql in (("postgres", ensure), (db, grants)):
        _, stderr, rc = await _exec(
            "docker", "exec", target.pg_container,
            "psql", "-U", admin, "-d", dbname, "-c", sql,
        )
        if rc != 0:
            raise RuntimeError(
                f"ensure ro role {ro} failed: {(stderr or '').strip()}"
            )


def _parse_json_agg(stdout: str, what: str) -> list:
    # The queries cast to jsonb so the value prints on one line, but parse from
    # the first '[' regardless: raw json_agg output puts a newline between
    # array elements, and -q's suppression of the SET command tag is belt, not
    # braces. raw_decode tolerates anything after the closing bracket.
    idx = stdout.find("[")
    if idx == -1:
        if not stdout.strip():
            return []
        raise RuntimeError(f"unexpected psql output for {what}: {stdout[:200]}")
    try:
        data, _ = json.JSONDecoder().raw_decode(stdout[idx:])
    except json.JSONDecodeError:
        raise RuntimeError(f"unexpected psql output for {what}: {stdout[:200]}")
    return data or []


async def list_tables(target: Target) -> list[dict]:
    await _require_service("postgres", target.realm)
    return await _list_tables_raw(target)


async def _list_tables_raw(target: Target) -> list[dict]:
    sql = (
        "SET statement_timeout TO '5s'; "
        "SELECT coalesce(json_agg(t ORDER BY t.name), '[]')::jsonb FROM ("
        "SELECT c.relname AS name, "
        "CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' "
        "WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' END AS kind, "
        "c.reltuples::bigint AS row_estimate, "
        "pg_total_relation_size(c.oid) AS total_bytes "
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')) t;"
    )
    return _parse_json_agg(await _psql(target, sql), "tables")


async def list_columns(target: Target, table: str) -> list[dict]:
    await _require_service("postgres", target.realm)
    _validate_ident(table, "table name")
    return await _list_columns_raw(target, table)


async def _list_columns_raw(target: Target, table: str) -> list[dict]:
    sql = (
        "SET statement_timeout TO '5s'; "
        "SELECT coalesce(json_agg(t ORDER BY t.position), '[]')::jsonb FROM ("
        "SELECT column_name AS name, data_type AS type, "
        "is_nullable = 'YES' AS nullable, ordinal_position AS position "
        "FROM information_schema.columns "
        f"WHERE table_schema = 'public' AND table_name = {_qlit(table)}) t;"
    )
    return _parse_json_agg(await _psql(target, sql), "columns")


async def table_rows(
    target: Target,
    table: str,
    limit: int = DEFAULT_ROW_LIMIT,
    offset: int = 0,
    sort: str | None = None,
    order: str = "asc",
) -> dict:
    """One page of a table, every cell text-cast and truncated server-side.

    `table` and `sort` are only interpolated after a byte-for-byte membership
    check against our own listing queries for this same request — we never
    quote a name Postgres didn't just hand us.
    """
    await _require_service("postgres", target.realm)
    _validate_ident(table, "table name")
    if sort is not None:
        _validate_ident(sort, "sort column")
    if order not in ("asc", "desc"):
        raise ValueError(f"Invalid order: {order!r} (want asc|desc)")
    limit = max(1, min(int(limit), MAX_ROW_LIMIT))
    offset = max(0, min(int(offset), MAX_OFFSET))

    tables = await _list_tables_raw(target)
    entry = next((t for t in tables if t.get("name") == table), None)
    if entry is None:
        raise LookupError(f"Table '{table}' does not exist")
    columns = await _list_columns_raw(target, table)
    if not columns:
        raise LookupError(f"Table '{table}' has no columns")
    if sort is not None and not any(c.get("name") == sort for c in columns):
        raise ValueError(f"Unknown sort column: {sort!r}")

    select_list = ", ".join(
        f"left(({_qident(c['name'])})::text, {CELL_MAX_CHARS}) "
        f"AS {_qident(c['name'])}"
        for c in columns
    )
    order_by = f" ORDER BY {_qident(sort)} {order.upper()}" if sort else ""
    sql = (
        "SET statement_timeout TO '10s'; "
        "SELECT coalesce(json_agg(t), '[]')::jsonb FROM ("
        f"SELECT {select_list} FROM {_qident(table)}{order_by} "
        f"LIMIT {limit + 1} OFFSET {offset}) t;"
    )
    rows = _parse_json_agg(await _psql(target, sql), "rows")
    has_more = len(rows) > limit
    return {
        "table": table,
        "db": target.db,
        "columns": columns,
        "rows": rows[:limit],
        "limit": limit,
        "offset": offset,
        "has_more": has_more,
        "row_estimate": entry.get("row_estimate"),
    }


# =============================================================================
# Object storage explorer (rclone inside the garage toolbox sidecar)
# =============================================================================

_KEY_MAX_LEN = 1024


def _validate_key(value: str, *, is_prefix: bool) -> None:
    what = "prefix" if is_prefix else "object key"
    if is_prefix and value == "":
        return
    if (
        not value
        or len(value) > _KEY_MAX_LEN
        or _CTRL_RE.search(value)
        or value.startswith("/")
        or ".." in value.split("/")
    ):
        raise ValueError(f"Invalid {what}: {value!r}")
    if is_prefix and not value.endswith("/"):
        raise ValueError(f"Invalid prefix (must end with '/'): {value!r}")
    if not is_prefix and value.endswith("/"):
        raise ValueError(f"Invalid object key (must not end with '/'): {value!r}")


def _bucket_creds(realm: str, bucket: str) -> tuple[str, str]:
    """Scoped per-bucket Garage key from secrets/garagecreds, falling back to
    the realm's _system key for buckets whose scoped key isn't minted yet.
    Every command issued with them is read-only by construction, so the
    fallback loses no guarantee we actually enforce."""
    creds = bp_databases._garage_creds(realm, bucket)
    if creds is None:
        creds = bp_databases._garage_creds(realm, "_system")
    if creds is None:
        if get_service_secrets("garage", realm) is None:
            raise LookupError(f"garage is not enabled at stage '{realm}'")
        raise LookupError(
            f"No S3 credentials provisioned yet for '{bucket}' at '{realm}'"
        )
    return creds


async def _rclone(target: Target, *verb: str) -> tuple[str, str, int]:
    """Run one rclone S3 command in the toolbox sidecar. Flags-only (the
    driver exec API can't set env vars); connection-refused maps to 503 —
    the garage node is still booting or gone."""
    from app.services.garage_util import garage_rclone_argv

    ak, sk = _bucket_creds(target.realm, target.s3_bucket)
    svc = get_service_secrets("garage", target.realm) or {}
    argv = garage_rclone_argv(
        svc.get("S3_HOST", ""), svc.get("S3_PORT", "9000"), ak, sk, *verb
    )
    stdout, stderr, rc = await _exec(
        "docker", "exec", target.toolbox_container, *argv
    )
    if rc != 0 and (
        "connection refused" in (stderr or "").lower()
        or "no such host" in (stderr or "").lower()
    ):
        raise ExplorerUnavailableError(
            f"object storage not ready: {(stderr or '').strip()[:200]}"
        )
    return stdout, stderr, rc


def _ref(target: Target, path: str) -> str:
    return f":s3:{target.s3_bucket}/{path}"


async def list_objects(target: Target, prefix: str = "") -> dict:
    await _require_service("garage", target.realm)
    _validate_key(prefix, is_prefix=True)
    stdout, stderr, rc = await _rclone(
        target, "lsjson", "--max-depth", "1", _ref(target, prefix)
    )
    if rc != 0:
        err = (stderr or "") + (stdout or "")
        # A missing BUCKET is rc 3 "directory not found" at the root; a
        # missing (virtual) folder inside an existing bucket reports the
        # same, so only the root case is a 404.
        if "directory not found" in err:
            if prefix:
                return {"bucket": target.s3_bucket, "prefix": prefix, "entries": []}
            raise LookupError(f"Bucket '{target.s3_bucket}' does not exist")
        raise RuntimeError(f"rclone lsjson failed: {err.strip()[:300]}")
    try:
        items = json.loads(stdout or "[]")
    except json.JSONDecodeError:
        raise RuntimeError(f"unexpected rclone output: {stdout[:200]}")
    entries = []
    for item in items:
        name = item.get("Name") or ""
        if not name:
            continue
        is_dir = bool(item.get("IsDir"))
        entries.append(
            {
                # Prefix-relative, trailing slash on folders — the dashboard
                # joins `prefix + key` (same contract as the old mc listing).
                "key": name + "/" if is_dir else name,
                "type": "folder" if is_dir else "file",
                "size": None if is_dir else item.get("Size"),
                "last_modified": None if is_dir else item.get("ModTime"),
            }
        )
    entries.sort(key=lambda e: (e["type"] != "folder", e["key"]))
    return {"bucket": target.s3_bucket, "prefix": prefix, "entries": entries}


async def stat_object(target: Target, key: str) -> dict:
    await _require_service("garage", target.realm)
    _validate_key(key, is_prefix=False)
    stdout, stderr, rc = await _rclone(
        target, "lsjson", "--stat", _ref(target, key)
    )
    if rc != 0:
        err = (stderr or "") + (stdout or "")
        if "not found" in err or "directory not found" in err:
            raise LookupError(f"Object '{key}' does not exist")
        raise RuntimeError(f"rclone stat failed: {err.strip()[:300]}")
    try:
        item = json.loads(stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"unexpected rclone stat output: {stdout[:200]}")
    if not item or item.get("IsDir"):
        raise LookupError(f"Object '{key}' does not exist")
    return {
        "key": key,
        "size": item.get("Size"),
        "last_modified": item.get("ModTime"),
        "content_type": item.get("MimeType") or "application/octet-stream",
    }


async def preview_object(
    target: Target, key: str, max_bytes: int = PREVIEW_DEFAULT_BYTES
) -> dict:
    """Size-capped inline preview. Oversized objects return `truncated: true`
    with no content — the dashboard offers download instead."""
    max_bytes = max(1, min(int(max_bytes), PREVIEW_MAX_BYTES))
    stat = await stat_object(target, key)
    size = stat.get("size") or 0
    if size > max_bytes:
        return {**stat, "truncated": True}
    tmpdir, path = await _fetch_object(target, key)
    try:
        with open(path, "rb") as f:
            content = f.read()
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    return {
        **stat,
        "truncated": False,
        "content_base64": base64.b64encode(content).decode("ascii"),
    }


async def download_object(target: Target, key: str) -> tuple[str, str, dict]:
    """Fetch an object onto gitops disk for streaming. Returns
    (tmpdir, file_path, stat) — the CALLER removes tmpdir when done
    (the route attaches a BackgroundTask)."""
    stat = await stat_object(target, key)
    if (stat.get("size") or 0) > DOWNLOAD_MAX_BYTES:
        raise ValueError(
            f"Object too large to download through the explorer "
            f"({stat.get('size')} bytes > {DOWNLOAD_MAX_BYTES})"
        )
    tmpdir, path = await _fetch_object(target, key)
    return tmpdir, path, stat


async def _fetch_object(target: Target, key: str) -> tuple[str, str]:
    """Copy one object out via the toolbox, binary-safely: rclone copyto into
    a random scratch dir, then the driver's copy-out TAR stream (the snapshot
    precedent — bytes never pass through an exec's text plumbing)."""
    from app.services.snapshot_service import run_docker_command_to_file

    await _require_service("garage", target.realm)
    _validate_key(key, is_prefix=False)
    scratch = f"/tmp/bpexp-{uuid.uuid4().hex}"
    _, stderr, rc = await _exec(
        "docker", "exec", target.toolbox_container, "mkdir", "-p", scratch
    )
    if rc != 0:
        raise RuntimeError(f"scratch mkdir failed: {(stderr or '').strip()}")
    tmpdir = tempfile.mkdtemp(prefix="bpexp-")
    try:
        _, stderr, rc = await _rclone(
            target, "copyto", _ref(target, key), f"{scratch}/obj"
        )
        if rc != 0:
            err = (stderr or "").strip()
            if "not found" in err:
                raise LookupError(f"Object '{key}' does not exist")
            raise RuntimeError(f"rclone copyto failed: {err[:300]}")
        tar_path = os.path.join(tmpdir, "obj.tar")
        stderr, rc = await run_docker_command_to_file(
            ["docker", "cp", f"{target.toolbox_container}:{scratch}/obj", "-"],
            tar_path,
        )
        if rc != 0:
            raise RuntimeError(f"copy-out failed: {stderr.strip()}")
        out_path = os.path.join(tmpdir, "obj")
        with tarfile.open(tar_path, "r:*") as tf:
            member = next((m for m in tf.getmembers() if m.isfile()), None)
            if member is None:
                raise RuntimeError("copy-out archive contained no file")
            src = tf.extractfile(member)
            with open(out_path, "wb") as dst:
                shutil.copyfileobj(src, dst)
        os.unlink(tar_path)
        return tmpdir, out_path
    except BaseException:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise
    finally:
        await _exec(
            "docker", "exec", target.toolbox_container, "rm", "-rf", scratch
        )
