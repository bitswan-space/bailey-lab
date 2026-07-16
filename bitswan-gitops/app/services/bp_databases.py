"""
Per-business-process logical databases inside the shared per-stage servers.

Snapshot-eligible BPs get their own Postgres database, CouchDB database
prefix and Garage (S3) bucket — all named after the BP slug only (no stage in
the name), so a snapshot taken at one stage restores into any other stage
without rewriting anything. The shared Postgres/CouchDB/Garage *servers* stay
per-(workspace, stage); this module only carves per-BP namespaces inside
them.

Eligibility is tracked in a registry file
`{BITSWAN_GITOPS_DIR}/secrets/bp-databases.json` — under `secrets/` because
that is the only host-persisted non-git directory in deployed workspaces
(`/gitops` itself is the container's writable layer; cf. the restic config in
`secrets/.backup`):

    {
      "version": 1,
      "bps": {
        "<bp-slug>": {
          "bp_name": "<original BP folder name>",
          "stages": {
            "<realm>": {
              "registered_at": "<iso8601>",
              "services": {"postgres": {"provisioned": true, ...}, ...}
            }
          }
        }
      }
    }

Two-phase lifecycle per BP×realm:
  1. *Registration* decides eligibility and reserves the names. It happens
     BEFORE bitswan.yaml is written for a deploy, and only when the BP has no
     pre-existing (non-worktree) deployment at that realm — existing BPs keep
     their data on the shared default DB and are never auto-migrated. Env
     injection in `generate_docker_compose` is gated on registration so the
     very first compose of a fresh BP already points at the per-BP names.
  2. *Provisioning* creates the actual objects (CREATE DATABASE /
     CreateBucket) after `docker compose up`, when the stage's service
     containers exist.
     CouchDB is lazy — automations create `{prefix}*` databases themselves —
     so its registration alone marks it provisioned.

Existing BPs opt in explicitly via `POST /snapshots/{bp}/provision` (their
per-BP namespaces start EMPTY — no data is migrated).
"""

import asyncio
import json
import logging
import os
import re
import tempfile
from datetime import datetime, timezone

from app.services.garage_util import garage_json_api_argv, garage_rclone_argv
from app.services.infra_service import stage_for_deployment
from app.utils import SERVICE_REALMS, sanitize_automation_name

logger = logging.getLogger(__name__)

# The data services a BP namespace spans. Kafka is intentionally absent —
# topics are transient transport, not snapshot-able state.
BP_DATA_SERVICES = ("postgres", "couchdb", "garage")

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def validate_bp_slug(slug: str) -> None:
    """Reject anything that isn't a sanitized BP slug.

    Slugs are interpolated into SQL identifiers, shell-ish docker exec
    arguments and filesystem paths, so the charset must stay this tight.
    """
    if not slug or len(slug) > 100 or not _SLUG_RE.match(slug):
        raise ValueError(f"Invalid BP slug: {slug!r}")


def bp_resource_names(bp_slug: str, db: int | None = None) -> dict:
    """Stage-independent per-BP resource names.

    Postgres identifiers are capped at 63 bytes; S3 bucket names at 63
    chars. Slugs come from directory names so they're rarely near the limit,
    but truncate defensively (collisions after truncation surface as a
    registry slug conflict, not silent data sharing).

    `db` (1 or 2) selects one of a BP's two persistent blue-green PRODUCTION
    databases: each is a fully separate logical DB/bucket/couch namespace, so
    the live db (Production) and the standby db (DR) never share data. The
    app slots a/b/c connect to one of these two DBs; restores only ever write
    the standby db. `db=None` is the single-backend scheme used everywhere
    else (dev/staging) — names are byte-identical to the original scheme.
    """
    validate_bp_slug(bp_slug)
    if db is not None:
        if db not in (1, 2):
            raise ValueError(f"Invalid blue-green db: {db!r} (want 1 or 2)")
        # Reserve room for the "_<db>"/"-<db>" suffix within the 63-byte cap.
        pg = (("bp_" + bp_slug.replace("-", "_"))[:61]) + f"_{db}"
        bucket = (("bp-" + bp_slug)[:61].rstrip("-")) + f"-{db}"
        couch = f"bp-{bp_slug}-{db}-"
    else:
        pg = ("bp_" + bp_slug.replace("-", "_"))[:63]
        bucket = ("bp-" + bp_slug)[:63].rstrip("-")
        couch = f"bp-{bp_slug}-"
    return {
        "postgres_db": pg,
        "couchdb_prefix": couch,
        "s3_bucket": bucket,
    }


def copy_bp_resource_names(copy_name: str, bp_slug: str) -> dict:
    """Per-(copy, BP) live-dev resource names. A non-main copy is a developer's
    sandbox: each BP's live-dev backend gets its OWN database, S3 bucket and
    CouchDB prefix there — isolated from other BPs in the copy, from other
    copies, and from dev. Capped at the 63-byte Postgres/S3 limit (a
    truncation collision surfaces as a deploy error, not silent data sharing).

    Single source of truth shared by the deploy-time ensure guard and the
    POSTGRES_DB/S3_BUCKET/COUCHDB_DB_PREFIX env injection — they MUST agree,
    or a backend connects to a namespace nobody created.
    """
    cp_u = re.sub(r"[^a-z0-9_]", "_", copy_name.lower())  # [a-z0-9_] for pg
    cp_d = re.sub(r"[^a-z0-9-]", "-", copy_name.lower()).strip("-")  # for s3/couch
    bp_u = bp_slug.replace("-", "_")
    pg = f"copy_{cp_u}_bp_{bp_u}"[:63]
    bucket = f"copy-{cp_d}-bp-{bp_slug}"[:63].rstrip("-")
    couch = f"copy-{cp_d}-bp-{bp_slug}-"
    return {"postgres_db": pg, "couchdb_prefix": couch, "s3_bucket": bucket}


def derive_bp_and_copy(relative_path: str | None) -> tuple[str, str]:
    """Derive (bp_slug, copy_name) from a deployment's relative_path.

    relative_path looks like "copies/main/Test/backend" (the main copy) or
    "copies/bar/Test/backend" (a non-main copy). The second return value is the
    *copy context*: empty for the main copy (so its deployments stay unprefixed,
    matching legacy `main`), or the copy name for any other copy. Returns
    ("", "") when the path has no BP segment (top-level automation).

    Single source of truth shared by `generate_docker_compose`'s deployment-
    context derivation and the provisioning hooks — both must agree on what
    "the BP of a deployment" means. (The variable is still called wt_name for
    historical reasons; it now carries the copy context.)
    """
    bp_name = ""
    wt_name = ""
    if relative_path:
        parts = relative_path.replace("\\", "/").split("/")
        if len(parts) >= 2 and parts[0] == "copies":
            copy_name = parts[1]
            # The main copy is the unprefixed scope (like the old shared repo);
            # only non-main copies carry a copy context.
            wt_name = "" if copy_name == "main" else copy_name
            parts = parts[2:]
        if len(parts) >= 2:
            bp_name = parts[0]
    bp_slug = sanitize_automation_name(bp_name) if bp_name else ""
    return bp_slug, wt_name


def get_service_secrets(service_type: str, stage: str) -> dict | None:
    """Read a service's connection info from its secrets env-file.

    Generalisation of the Postgres-only helper that used to live in
    `app/routes/copies.py`. Returns the parsed KEY=VALUE dict, or None
    when the file is missing (service not enabled at that stage).
    """
    bs_home = os.environ.get("BITSWAN_GITOPS_DIR", "/mnt/repo/pipeline")
    suffix = f"-{stage}" if stage != "production" else ""
    secrets_path = os.path.join(bs_home, "secrets", f"{service_type}{suffix}")
    if not os.path.exists(secrets_path):
        return None
    info = {}
    with open(secrets_path) as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                key, _, value = line.partition("=")
                info[key] = value
    return info or None


def _garage_creds(realm: str, name: str) -> tuple[str, str] | None:
    """Read a Garage-issued S3 key from `secrets/garagecreds/<realm>/<name>`.

    `name` is a bucket name or `_system` (the full-access key the driver's
    provisioner maintains for backups/snapshots/explorer-fallback). Returns
    (access_key, secret_key), or None when the file is missing or is still
    the empty placeholder the driver writes before `CreateKey` runs.
    """
    bs_home = os.environ.get("BITSWAN_GITOPS_DIR", "/mnt/repo/pipeline")
    path = os.path.join(bs_home, "secrets", "garagecreds", realm, name)
    if not os.path.exists(path):
        return None
    info = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                key, _, value = line.partition("=")
                info[key] = value
    ak, sk = info.get("S3_ACCESS_KEY"), info.get("S3_SECRET_KEY")
    if not ak or not sk:
        return None
    return ak, sk


# =============================================================================
# Registry
# =============================================================================


def _registry_path() -> str:
    # Must live under secrets/ — the only host-persisted non-git dir in
    # deployed workspaces. Directly under BITSWAN_GITOPS_DIR it would sit in
    # the container's writable layer and vanish on container recreation,
    # silently dropping env injection for every registered BP.
    bs_home = os.environ.get("BITSWAN_GITOPS_DIR", "/mnt/repo/pipeline")
    return os.path.join(bs_home, "secrets", "bp-databases.json")


def load_registry() -> dict:
    path = _registry_path()
    if not os.path.exists(path):
        return {"version": 1, "bps": {}}
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        # A corrupt registry must not silently re-eligibilize every BP (or
        # de-eligibilize provisioned ones) — fail loudly.
        raise RuntimeError(f"Cannot read BP database registry {path}: {e}")
    data.setdefault("version", 1)
    data.setdefault("bps", {})
    return data


def save_registry(registry: dict) -> None:
    """Atomic write: tmp file in the same directory + rename."""
    path = _registry_path()
    dirname = os.path.dirname(path)
    os.makedirs(dirname, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=dirname, prefix=".bp-databases-", suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(registry, f, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def get_bp_entry(registry: dict, bp_slug: str) -> dict | None:
    return registry.get("bps", {}).get(bp_slug)


def is_registered(registry: dict, bp_slug: str, realm: str) -> bool:
    entry = get_bp_entry(registry, bp_slug)
    return bool(entry and realm in entry.get("stages", {}))


def register_bp_stage(registry: dict, bp_slug: str, bp_name: str, realm: str) -> bool:
    """Add bp×realm to the registry (in memory). Returns True when changed.

    Refuses when a different original name already claimed this slug — two
    BP folders sanitizing to the same slug would otherwise silently share
    one database namespace.
    """
    validate_bp_slug(bp_slug)
    if realm not in SERVICE_REALMS:
        raise ValueError(
            f"Invalid realm '{realm}': must be one of {sorted(SERVICE_REALMS)}"
        )
    bps = registry.setdefault("bps", {})
    entry = bps.get(bp_slug)
    if entry is None:
        entry = {"bp_name": bp_name, "stages": {}}
        bps[bp_slug] = entry
    elif entry.get("bp_name") != bp_name:
        raise ValueError(
            f"BP slug collision: '{bp_slug}' is already registered for "
            f"'{entry.get('bp_name')}', refusing to share it with '{bp_name}'"
        )
    if realm in entry["stages"]:
        return False
    entry["stages"][realm] = {
        "registered_at": datetime.now(timezone.utc).isoformat(),
        "services": {},
    }
    return True


# =============================================================================
# Provisioning (object creation inside the running service containers)
# =============================================================================


def _container_name(workspace: str, service_type: str, realm: str) -> str:
    suffix = "" if realm == "production" else f"-{realm}"
    return f"{workspace}__{service_type}{suffix}"


async def _driver_exec(*args: str, cwd: str | None = None) -> tuple[str, str, int]:
    """Run a `docker exec` through the infra-driver (gitops has no docker.sock).
    Accepts the legacy ("docker", "exec", <container>, *cmd) arg shape so the
    call sites are a drop-in rename of run_docker_command. Returns
    (stdout, stderr, returncode)."""
    from app.services.infra_driver_client import (
        ExecSpec,
        InfraDriverClient,
        InfraDriverError,
        WorkspaceContext,
    )

    if len(args) < 3 or args[0] != "docker" or args[1] != "exec":
        raise ValueError("_driver_exec expects ('docker','exec',<container>,*cmd)")
    container = args[2]
    cmd = list(args[3:])
    gitops_root = os.environ.get("BITSWAN_GITOPS_DIR", "/gitops")
    client = InfraDriverClient()
    ctx = WorkspaceContext(
        workspace_name=os.environ.get("BITSWAN_WORKSPACE_NAME", "workspace-local"),
        domain=os.environ.get("BITSWAN_GITOPS_DOMAIN", ""),
        gitops_dir=os.path.join(gitops_root, "gitops"),
        secrets_dir=os.path.join(gitops_root, "secrets"),
    )
    out: list[bytes] = []
    err: list[bytes] = []

    async def on_stdout(d: bytes):
        out.append(d)

    async def on_stderr(d: bytes):
        err.append(d)

    try:
        rc = await client.exec(
            ctx,
            ExecSpec(container=container, cmd=cmd),
            on_stdout=on_stdout,
            on_stderr=on_stderr,
        )
    except InfraDriverError as e:
        return "", str(e), 1
    return (
        b"".join(out).decode("utf-8", "replace"),
        b"".join(err).decode("utf-8", "replace"),
        rc,
    )


async def _wait_for_postgres(container: str, user: str, timeout: float = 60.0) -> None:
    """Block until a freshly-started Postgres server accepts connections.

    On a first-ever deploy the postgres container is created by the same
    `docker compose up` as the BP, so `is_running()` (container is up) goes
    true well before the server finishes initdb. Without this wait the very
    first CREATE DATABASE races initdb, fails with "the database system is
    starting up", and — because provisioning is best-effort — the error is
    swallowed, leaving the BP crash-looping on a missing database forever
    (nothing redeploys to retry). pg_isready ships in the postgres image.
    """
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    last = ""
    while True:
        _, stderr, rc = await _driver_exec(
            "docker", "exec", container, "pg_isready", "-U", user, "-q"
        )
        if rc == 0:
            return
        last = stderr.strip()
        if loop.time() >= deadline:
            raise RuntimeError(
                f"Postgres in {container} not ready after {timeout:.0f}s: {last}"
            )
        await asyncio.sleep(2.0)


async def _postgres_db_exists(container: str, user: str, db_name: str) -> bool:
    sql = f"SELECT 1 FROM pg_database WHERE datname = '{db_name}';"
    stdout, stderr, rc = await _driver_exec(
        "docker",
        "exec",
        container,
        "psql",
        "-U",
        user,
        "-d",
        "postgres",
        "-t",
        "-A",
        "-c",
        sql,
    )
    if rc != 0:
        raise RuntimeError(f"psql existence check failed: {stderr.strip()}")
    return stdout.strip() == "1"


async def _create_postgres_db(container: str, user: str, db_name: str) -> None:
    if await _postgres_db_exists(container, user, db_name):
        return
    stdout, stderr, rc = await _driver_exec(
        "docker",
        "exec",
        container,
        "psql",
        "-U",
        user,
        "-d",
        "postgres",
        "-c",
        f'CREATE DATABASE "{db_name}";',
    )
    if rc != 0 and "already exists" not in (stderr or ""):
        raise RuntimeError(f"CREATE DATABASE {db_name} failed: {stderr.strip()}")


async def clone_postgres_db_as(
    container: str, user: str, target_db: str, source_db: str
) -> None:
    """Create ``target_db`` as a clone of ``source_db``
    (``CREATE DATABASE ... WITH TEMPLATE``), idempotently (a no-op when
    ``target_db`` already exists). Caller ensures Postgres is ready and
    ``source_db`` exists. Used to give a non-main copy's live-dev a
    per-(copy, BP) database seeded from that BP's dev data.
    """
    if await _postgres_db_exists(container, user, target_db):
        return

    # CREATE DATABASE ... WITH TEMPLATE requires no other sessions on the
    # template DB — drop them first (best-effort; the CREATE below is the
    # authoritative step).
    terminate_sql = (
        f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
        f"WHERE datname = '{source_db}' AND pid <> pg_backend_pid();"
    )
    await _driver_exec(
        "docker",
        "exec",
        container,
        "psql",
        "-U",
        user,
        "-d",
        "postgres",
        "-c",
        terminate_sql,
    )
    _, stderr, rc = await _driver_exec(
        "docker",
        "exec",
        container,
        "psql",
        "-U",
        user,
        "-d",
        "postgres",
        "-c",
        f'CREATE DATABASE "{target_db}" WITH TEMPLATE "{source_db}";',
    )
    if rc != 0 and "already exists" not in (stderr or ""):
        raise RuntimeError(
            f"clone CREATE DATABASE {target_db} (template {source_db}) failed: "
            f"{stderr.strip()}"
        )
    logger.info("Cloned Postgres '%s' -> '%s'", source_db, target_db)


async def _garage_json_api(
    container: str, endpoint: str, body: dict | None = None
) -> tuple[str, str, int]:
    """One `/garage json-api` admin call inside the garage container. The
    JSON result comes back on stdout; logs go to stderr."""
    return await _driver_exec(
        "docker", "exec", container, *garage_json_api_argv(endpoint, body)
    )


async def _create_garage_bucket(container: str, realm: str, bucket: str) -> None:
    """Idempotently create `bucket` and grant the `_system` key (and the
    BP's scoped key, when the driver has issued one) full access to it.

    A missing `_system` key is a RuntimeError — provisioning is best-effort
    at the call sites, so the next deploy retries once the driver's
    provisioner has written it."""
    # Like Postgres, the Garage server may have only just come up — retry
    # the health probe so a cold start doesn't silently lose the bucket to
    # best-effort error-swallowing.
    loop = asyncio.get_event_loop()
    deadline = loop.time() + 60.0
    while True:
        _, stderr, rc = await _garage_json_api(container, "GetClusterHealth")
        if rc == 0:
            break
        if loop.time() >= deadline:
            raise RuntimeError(f"Garage not healthy: {stderr.strip()}")
        await asyncio.sleep(2.0)

    _, stderr, rc = await _garage_json_api(
        container, "CreateBucket", {"globalAlias": bucket}
    )
    if rc != 0 and "BucketAlreadyExists" not in (stderr or ""):
        raise RuntimeError(f"CreateBucket {bucket} failed: {stderr.strip()}")

    stdout, stderr, rc = await _garage_json_api(
        container, "GetBucketInfo", {"globalAlias": bucket}
    )
    if rc != 0:
        raise RuntimeError(f"GetBucketInfo {bucket} failed: {stderr.strip()}")
    try:
        bucket_id = json.loads(stdout)["id"]
    except (json.JSONDecodeError, KeyError):
        raise RuntimeError(f"GetBucketInfo {bucket} returned no id: {stdout[:200]}")

    system_creds = _garage_creds(realm, "_system")
    if system_creds is None:
        raise RuntimeError(
            f"No _system Garage key at {realm} yet — bucket grant retried later"
        )
    grants = [system_creds]
    scoped = _garage_creds(realm, bucket)
    if scoped is not None:
        grants.append(scoped)
    for access_key, _sk in grants:
        _, stderr, rc = await _garage_json_api(
            container,
            "AllowBucketKey",
            {
                "bucketId": bucket_id,
                "accessKeyId": access_key,
                "permissions": {"read": True, "write": True, "owner": True},
            },
        )
        if rc != 0:
            raise RuntimeError(
                f"AllowBucketKey {bucket}/{access_key} failed: {stderr.strip()}"
            )


async def ensure_bp_databases(
    workspace: str,
    bp_slug: str,
    bp_name: str,
    realm: str,
    services: list[str] | None = None,
    db: int | None = None,
) -> dict:
    """Create the per-BP objects for every requested service at one realm.

    Idempotent. Only touches services that are enabled (secrets file exists)
    and whose container is running; the rest are reported as skipped and
    retried on the next deploy. Marks each successfully created service as
    provisioned in the registry. Returns a per-service result dict.

    `db` (1/2) provisions one of a production BP's two blue-green databases
    (`bp_<slug>_<db>` etc.) instead of the single-backend names, tracked under
    a separate registry key. Both DBs are provisioned for a production BP; the
    standby db is where restore-to-DR lands without touching the live db.
    """
    from app.services.infra_service import get_service

    validate_bp_slug(bp_slug)
    if realm not in SERVICE_REALMS:
        raise ValueError(
            f"Invalid realm '{realm}': must be one of {sorted(SERVICE_REALMS)}"
        )

    names = bp_resource_names(bp_slug, db)
    requested = [s for s in (services or BP_DATA_SERVICES) if s in BP_DATA_SERVICES]

    registry = load_registry()
    register_bp_stage(registry, bp_slug, bp_name, realm)
    stage_entry = registry["bps"][bp_slug]["stages"][realm]
    if db is not None:
        svc_state = stage_entry.setdefault("dbs", {}).setdefault(str(db), {})
    else:
        svc_state = stage_entry.setdefault("services", {})

    results: dict[str, str] = {}
    changed = True  # register_bp_stage may have added the stage entry
    for svc_type in requested:
        if svc_state.get(svc_type, {}).get("provisioned"):
            results[svc_type] = "ok"
            continue
        try:
            svc = get_service(svc_type, workspace, stage=realm)
            if not svc.is_enabled():
                results[svc_type] = "skipped: not enabled"
                continue
            if svc_type != "couchdb" and not await svc.is_running():
                results[svc_type] = "skipped: not running"
                continue

            if svc_type == "postgres":
                secrets = get_service_secrets("postgres", realm) or {}
                user = secrets.get("POSTGRES_USER", "admin")
                # The server container may have only just come up alongside
                # the BP — wait for it to accept connections before CREATE,
                # else a cold start silently loses the database (see above).
                await _wait_for_postgres(svc.container_name, user)
                await _create_postgres_db(
                    svc.container_name, user, names["postgres_db"]
                )
            elif svc_type == "garage":
                await _create_garage_bucket(
                    svc.container_name, realm, names["s3_bucket"]
                )
            # couchdb: lazy — automations create `{prefix}*` DBs themselves;
            # registering the prefix is all the provisioning there is.

            svc_state[svc_type] = {
                "provisioned": True,
                "provisioned_at": datetime.now(timezone.utc).isoformat(),
            }
            changed = True
            results[svc_type] = "ok"
        except Exception as e:
            logger.warning(
                "Provisioning %s for BP '%s' at %s failed: %s",
                svc_type,
                bp_slug,
                realm,
                e,
            )
            results[svc_type] = f"error: {e}"

    if changed:
        save_registry(registry)
    return results


# =============================================================================
# Deploy-hook helpers
# =============================================================================


def _bp_has_existing_deployment_at_realm(
    bs_yaml: dict | None, bp_slug: str, realm: str
) -> bool:
    """True when the BP already has a non-worktree deployment whose stage
    maps to `realm` in bitswan.yaml. Used for first-deploy gating: such BPs
    have live data on the shared default DB and must NOT be auto-migrated."""
    for conf in ((bs_yaml or {}).get("deployments") or {}).values():
        conf = conf or {}
        dep_slug, wt = derive_bp_and_copy(conf.get("relative_path"))
        if wt or dep_slug != bp_slug:
            continue
        dep_stage = conf.get("stage") or "production"
        if stage_for_deployment(dep_stage) == realm:
            return True
    return False


def register_new_bps_for_members(
    bs_yaml_before: dict | None, members: list[dict]
) -> list[tuple[str, str, str]]:
    """First-deploy gating, called BEFORE bitswan.yaml is written.

    For each member being deployed: derive its BP and target realm; if the
    BP×realm is not yet registered AND the BP had no prior (non-worktree)
    deployment at that realm, register it so env injection and post-deploy
    provisioning kick in. Worktree members never register (their live-dev
    data rides the worktree-cloned DB). Best-effort: never raises.

    Returns the list of (bp_slug, bp_name, realm) tuples newly registered.
    """
    registered: list[tuple[str, str, str]] = []
    try:
        registry = None
        changed = False
        for m in members:
            relative_path = m.get("relative_path")
            stage = m.get("stage") or "production"
            bp_slug, wt = derive_bp_and_copy(relative_path)
            if not bp_slug or wt:
                continue
            realm = stage_for_deployment(stage if stage != "" else "production")
            if realm not in SERVICE_REALMS:
                continue
            if registry is None:
                registry = load_registry()
            if is_registered(registry, bp_slug, realm):
                continue
            if _bp_has_existing_deployment_at_realm(bs_yaml_before, bp_slug, realm):
                continue  # pre-existing BP: manual opt-in only
            bp_name = _bp_display_name(relative_path)
            try:
                if register_bp_stage(registry, bp_slug, bp_name, realm):
                    changed = True
                    registered.append((bp_slug, bp_name, realm))
            except ValueError as e:
                logger.warning("BP registration refused: %s", e)
        if changed and registry is not None:
            save_registry(registry)
    except Exception as e:
        logger.warning("BP database registration failed (non-fatal): %s", e)
    return registered


def _bp_display_name(relative_path: str | None) -> str:
    """Original (unsanitized) BP folder name from a relative_path."""
    if not relative_path:
        return ""
    parts = relative_path.replace("\\", "/").split("/")
    if len(parts) >= 2 and parts[0] == "copies":
        # Drop the "copies/<copy>" prefix; the main copy and any other copy
        # are treated the same for the purpose of the BP folder name.
        parts = parts[2:]
    return parts[0] if len(parts) >= 2 else ""


def _production_db_numbers(bs_yaml: dict | None, bp_slug: str) -> list[int]:
    """Blue-green db numbers a production BP's slots use (default [1, 2]).

    Mirrors generate_docker_compose's `_slot_db_pairs`: each running slot wires
    to one of the two persistent production databases.
    """
    rec = ((bs_yaml or {}).get("backups") or {}).get(bp_slug) or {}
    slots = rec.get("slots") or {"blue": {"db": 1}, "green": {"db": 2}}
    nums = sorted(
        {
            int((slots[s] or {}).get("db"))
            for s in slots
            if (slots.get(s) or {}).get("db")
        }
    )
    return nums or [1]


async def ensure_live_postgres_dbs(
    workspace: str, bs_yaml: dict | None, deployment_ids: list[str]
) -> None:
    """Fail-fast guard: ensure the Postgres database each deploying backend will
    connect to actually exists, before relying on the backend's connect retry.

    Mirrors the POSTGRES_DB resolution in the driver's compiler:
      - live-dev non-main copy -> ``copy_<copy>_bp_<slug>`` (cloned from that
                                  BP's dev DB, else the shared dev default)
      - registered BP          -> ``bp_<slug>`` (dev/staging), or ``bp_<slug>_<db>``
                                  for each blue-green db a production BP's slots use
      - otherwise (shared default DB) -> nothing to create

    Unlike `provision_for_deployments` (best-effort; covers couch/garage + the
    standby blue-green db), this owns ONLY the live Postgres DB and **raises**
    when Postgres is enabled but the DB can't be created — so the deploy fails
    with a clear error instead of leaving the backend crash-looping on a missing
    database. When Postgres isn't enabled for a realm it skips (the guard can't
    create a server).
    """
    deployments = (bs_yaml or {}).get("deployments") or {}
    registry = load_registry()
    seen: set[tuple[str, str]] = set()
    for dep_id in deployment_ids:
        conf = deployments.get(dep_id) or {}
        bp_slug, copy = derive_bp_and_copy(conf.get("relative_path"))
        stage = conf.get("stage") or "production"
        realm = stage_for_deployment(stage)
        if realm not in SERVICE_REALMS:
            continue

        # 1) A non-main copy's live-dev backend gets its OWN per-(copy, BP)
        #    database, seeded from that BP's dev DB (bp_<slug>) if it exists, else
        #    the shared dev default. Per (copy, BP) — isolated from other BPs in
        #    the copy and from other copies. (The env injection points POSTGRES_DB
        #    at this name unconditionally.)
        if stage == "live-dev" and copy and bp_slug:
            target = copy_bp_resource_names(copy, bp_slug)["postgres_db"]
            if ("copybp", target) in seen:
                continue
            seen.add(("copybp", target))
            secrets = get_service_secrets("postgres", realm)
            if not secrets or not secrets.get("POSTGRES_USER"):
                logger.info(
                    "Postgres not enabled (%s); skipping live-dev DB '%s'",
                    realm,
                    target,
                )
                continue
            user = secrets["POSTGRES_USER"]
            container = _container_name(workspace, "postgres", realm)
            await _wait_for_postgres(container, user)
            # Seed from the BP's dev DB if it exists, else the shared dev default.
            source = secrets.get("POSTGRES_DB", "postgres")
            dev_bp_db = bp_resource_names(bp_slug)["postgres_db"]
            if await _postgres_db_exists(container, user, dev_bp_db):
                source = dev_bp_db
            await clone_postgres_db_as(container, user, target, source)
            continue

        # 2) A registered BP's per-stage database(s). Unregistered BPs use the
        #    shared default DB, so there's nothing to create.
        if not bp_slug or not is_registered(registry, bp_slug, realm):
            continue
        secrets = get_service_secrets("postgres", realm)
        if not secrets or not secrets.get("POSTGRES_USER"):
            logger.info(
                "Postgres not enabled (%s); skipping DB for BP '%s'", realm, bp_slug
            )
            continue
        user = secrets["POSTGRES_USER"]
        container = _container_name(workspace, "postgres", realm)
        dbs = (
            _production_db_numbers(bs_yaml, bp_slug)
            if realm == "production"
            else [None]
        )
        for db in dbs:
            db_name = bp_resource_names(bp_slug, db)["postgres_db"]
            if ("bp", db_name) in seen:
                continue
            seen.add(("bp", db_name))
            await _wait_for_postgres(container, user)
            await _create_postgres_db(container, user, db_name)


# =============================================================================
# Teardown (BP / copy delete)
# =============================================================================


async def _drop_postgres_db(container: str, user: str, db_name: str) -> None:
    """DROP DATABASE, terminating its sessions first (DROP refuses while any
    session is connected — same reason clone_postgres_db_as terminates the
    template's sessions). Missing database = no-op."""
    terminate_sql = (
        f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
        f"WHERE datname = '{db_name}' AND pid <> pg_backend_pid();"
    )
    await _driver_exec(
        "docker",
        "exec",
        container,
        "psql",
        "-U",
        user,
        "-d",
        "postgres",
        "-c",
        terminate_sql,
    )
    _, stderr, rc = await _driver_exec(
        "docker",
        "exec",
        container,
        "psql",
        "-U",
        user,
        "-d",
        "postgres",
        "-c",
        f'DROP DATABASE IF EXISTS "{db_name}";',
    )
    if rc != 0:
        raise RuntimeError(f"DROP DATABASE {db_name} failed: {stderr.strip()}")
    # Best-effort cleanup of the database's scoped roles (the driver's
    # u_<db> backend role and the ro_<db> explorer twin — see bpcreds.go).
    # They own nothing once the DB is gone, but a role that still has
    # dependencies elsewhere must not block BP deletion — log and move on.
    for role in (("u_" + db_name)[:63], ("ro_" + db_name)[:63]):
        _, stderr, rc = await _driver_exec(
            "docker",
            "exec",
            container,
            "psql",
            "-U",
            user,
            "-d",
            "postgres",
            "-c",
            f'DROP ROLE IF EXISTS "{role}";',
        )
        if rc != 0:
            logger.warning(
                "DROP ROLE %s after dropping %s failed: %s",
                role,
                db_name,
                stderr.strip(),
            )


async def _drop_garage_bucket(container: str, realm: str, bucket: str) -> None:
    """Remove a bucket, its contents, the BP's scoped key and its creds
    file. Missing bucket = no-op; every step past it is best-effort (a
    half-deleted bucket must not block BP deletion — log and move on).

    `rclone purge` on Garage deletes the bucket itself (S3 DeleteBucket
    after emptying), so the admin DeleteBucket after it is the tolerated
    no-op that also covers a purge-less path (e.g. no `_system` key).
    """
    stdout, stderr, rc = await _garage_json_api(
        container, "GetBucketInfo", {"globalAlias": bucket}
    )
    bucket_id = None
    if rc == 0:
        try:
            bucket_id = json.loads(stdout).get("id")
        except json.JSONDecodeError:
            logger.warning("GetBucketInfo %s returned non-JSON: %s", bucket, stdout)
    elif "NoSuchBucket" not in (stderr or ""):
        logger.warning("GetBucketInfo %s failed: %s", bucket, stderr.strip())

    if bucket_id:
        system_creds = _garage_creds(realm, "_system")
        if system_creds:
            secrets = get_service_secrets("garage", realm) or {}
            _, stderr, rc = await _driver_exec(
                "docker",
                "exec",
                f"{container}-toolbox",
                *garage_rclone_argv(
                    secrets.get("S3_HOST", ""),
                    secrets.get("S3_PORT", "9000"),
                    system_creds[0],
                    system_creds[1],
                    "purge",
                    f":s3:{bucket}",
                ),
            )
            if rc != 0 and "directory not found" not in (stderr or ""):
                logger.warning("rclone purge %s failed: %s", bucket, stderr.strip())
        else:
            logger.warning(
                "No _system Garage key at %s; skipping purge of %s", realm, bucket
            )
        _, stderr, rc = await _garage_json_api(
            container, "DeleteBucket", {"id": bucket_id}
        )
        if rc != 0 and "NoSuchBucket" not in (stderr or ""):
            logger.warning("DeleteBucket %s failed: %s", bucket, stderr.strip())

    scoped = _garage_creds(realm, bucket)
    if scoped is not None:
        _, stderr, rc = await _garage_json_api(
            container, "DeleteKey", {"id": scoped[0]}
        )
        if rc != 0:
            logger.warning("DeleteKey for %s failed: %s", bucket, stderr.strip())
    creds_path = os.path.join(
        os.environ.get("BITSWAN_GITOPS_DIR", "/mnt/repo/pipeline"),
        "secrets",
        "garagecreds",
        realm,
        bucket,
    )
    if os.path.exists(creds_path):
        os.remove(creds_path)


async def _drop_couchdb_prefix(
    container: str, user: str, password: str, prefix: str
) -> None:
    """DELETE every CouchDB database under a BP prefix (couch is lazy on the
    create side, so there may be zero)."""
    stdout, stderr, rc = await _driver_exec(
        "docker",
        "exec",
        container,
        "curl",
        "-s",
        "-u",
        f"{user}:{password}",
        "http://localhost:5984/_all_dbs",
    )
    if rc != 0:
        raise RuntimeError(f"CouchDB _all_dbs failed: {stderr.strip()}")
    try:
        all_dbs = json.loads(stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"CouchDB _all_dbs returned non-JSON: {stdout[:200]}")
    for db in all_dbs:
        if not db.startswith(prefix):
            continue
        _, stderr, rc = await _driver_exec(
            "docker",
            "exec",
            container,
            "curl",
            "-s",
            "-X",
            "DELETE",
            "-u",
            f"{user}:{password}",
            f"http://localhost:5984/{db}",
        )
        if rc != 0:
            raise RuntimeError(f"CouchDB DELETE /{db} failed: {stderr.strip()}")


async def _drop_names_at_realm(
    workspace: str, realm: str, names: dict, results: dict[str, str], key_prefix: str
) -> None:
    """Drop one {postgres_db, s3_bucket, couchdb_prefix} name set at one
    realm. Per-service outcome goes into `results` under `<key_prefix>:<svc>`:
    "ok" | "skipped: not enabled" | "error: …". A service that is enabled but
    not running is an ERROR (its data would silently survive), unlike the
    create path where a later deploy retries."""
    from app.services.infra_service import get_service

    for svc_type in BP_DATA_SERVICES:
        key = f"{key_prefix}:{svc_type}"
        try:
            svc = get_service(svc_type, workspace, stage=realm)
            if not svc.is_enabled():
                results[key] = "skipped: not enabled"
                continue
            if not await svc.is_running():
                results[key] = "error: service not running"
                continue
            if svc_type == "postgres":
                secrets = get_service_secrets("postgres", realm) or {}
                user = secrets.get("POSTGRES_USER", "admin")
                await _drop_postgres_db(svc.container_name, user, names["postgres_db"])
            elif svc_type == "garage":
                await _drop_garage_bucket(svc.container_name, realm, names["s3_bucket"])
            elif svc_type == "couchdb":
                secrets = get_service_secrets("couchdb", realm) or {}
                await _drop_couchdb_prefix(
                    svc.container_name,
                    secrets.get("COUCHDB_USER", "admin"),
                    secrets.get("COUCHDB_PASSWORD", ""),
                    names["couchdb_prefix"],
                )
            results[key] = "ok"
        except Exception as e:
            logger.warning("Dropping %s (%s) failed: %s", key, names, e)
            results[key] = f"error: {e}"


async def drop_bp_databases(workspace: str, bp_slug: str) -> dict[str, str]:
    """Destroy every per-BP database namespace across all realms: the
    single-backend names at dev/staging and BOTH blue-green production
    databases. The registry entry is removed only when nothing errored — a
    kept entry is the retry marker for an idempotent delete re-run."""
    validate_bp_slug(bp_slug)
    results: dict[str, str] = {}
    for realm in sorted(SERVICE_REALMS):
        dbs: list[int | None] = [None] if realm != "production" else [None, 1, 2]
        for db in dbs:
            names = bp_resource_names(bp_slug, db)
            suffix = f"@{realm}" + (f"#db{db}" if db else "")
            await _drop_names_at_realm(
                workspace, realm, names, results, f"{bp_slug}{suffix}"
            )

    if not any(v.startswith("error") for v in results.values()):
        registry = load_registry()
        if registry.get("bps", {}).pop(bp_slug, None) is not None:
            save_registry(registry)
    return results


async def drop_copy_bp_databases(
    workspace: str, copy_name: str, bp_slugs: list[str]
) -> dict[str, str]:
    """Destroy the per-(copy, BP) live-dev namespaces (`copy_<copy>_bp_<slug>`
    etc.) for every given BP. live-dev rides the dev realm's servers."""
    results: dict[str, str] = {}
    for bp_slug in bp_slugs:
        try:
            validate_bp_slug(bp_slug)
        except ValueError as e:
            results[f"{copy_name}/{bp_slug}"] = f"error: {e}"
            continue
        names = copy_bp_resource_names(copy_name, bp_slug)
        await _drop_names_at_realm(
            workspace, "dev", names, results, f"copy-{copy_name}-{bp_slug}@dev"
        )
    return results
