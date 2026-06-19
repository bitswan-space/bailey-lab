"""
Per-business-process logical databases inside the shared per-stage servers.

Snapshot-eligible BPs get their own Postgres database, CouchDB database
prefix and MinIO bucket — all named after the BP slug only (no stage in the
name), so a snapshot taken at one stage restores into any other stage without
rewriting anything. The shared Postgres/CouchDB/MinIO *servers* stay
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
  2. *Provisioning* creates the actual objects (CREATE DATABASE / mc mb)
     after `docker compose up`, when the stage's service containers exist.
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

from app.services.infra_service import run_docker_command, stage_for_deployment
from app.utils import SERVICE_REALMS, sanitize_automation_name

logger = logging.getLogger(__name__)

# The data services a BP namespace spans. Kafka is intentionally absent —
# topics are transient transport, not snapshot-able state.
BP_DATA_SERVICES = ("postgres", "couchdb", "minio")

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def validate_bp_slug(slug: str) -> None:
    """Reject anything that isn't a sanitized BP slug.

    Slugs are interpolated into SQL identifiers, shell-ish docker exec
    arguments and filesystem paths, so the charset must stay this tight.
    """
    if not slug or len(slug) > 100 or not _SLUG_RE.match(slug):
        raise ValueError(f"Invalid BP slug: {slug!r}")


def bp_resource_names(bp_slug: str) -> dict:
    """Stage-independent per-BP resource names.

    Postgres identifiers are capped at 63 bytes; MinIO bucket names at 63
    chars. Slugs come from directory names so they're rarely near the limit,
    but truncate defensively (collisions after truncation surface as a
    registry slug conflict, not silent data sharing).
    """
    validate_bp_slug(bp_slug)
    pg = ("bp_" + bp_slug.replace("-", "_"))[:63]
    bucket = ("bp-" + bp_slug)[:63].rstrip("-")
    return {
        "postgres_db": pg,
        "couchdb_prefix": f"bp-{bp_slug}-",
        "minio_bucket": bucket,
    }


def worktree_db_name(worktree_name: str) -> str:
    """Postgres database backing a worktree's live-dev stage.

    Single source of truth shared by three call sites that MUST agree, or a
    backend connects to a database nobody created: worktree-create (clones it),
    the deploy-path safety net (`ensure_worktree_postgres_db`), and the
    POSTGRES_DB env injection in `generate_docker_compose`.
    """
    safe = re.sub(r"[^a-z0-9_]", "_", worktree_name.lower())
    return f"postgres_wt_{safe}"


def derive_bp_and_worktree(relative_path: str | None) -> tuple[str, str]:
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
    `app/routes/worktrees.py`. Returns the parsed KEY=VALUE dict, or None
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
        _, stderr, rc = await run_docker_command(
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
    stdout, stderr, rc = await run_docker_command(
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
    stdout, stderr, rc = await run_docker_command(
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


async def _clone_postgres_db(
    container: str, user: str, source_db: str, new_db: str
) -> None:
    """`CREATE DATABASE new_db WITH TEMPLATE source_db`.

    Callers must have confirmed `new_db` does not yet exist. Postgres refuses
    to template a database that has live sessions, so terminate other backends
    on the source first.
    """
    terminate_sql = (
        f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
        f"WHERE datname = '{source_db}' AND pid <> pg_backend_pid();"
    )
    await run_docker_command(
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
    _, stderr, rc = await run_docker_command(
        "docker",
        "exec",
        container,
        "psql",
        "-U",
        user,
        "-d",
        "postgres",
        "-c",
        f'CREATE DATABASE "{new_db}" WITH TEMPLATE "{source_db}";',
    )
    if rc != 0 and "already exists" not in (stderr or ""):
        raise RuntimeError(
            f"CREATE DATABASE {new_db} (template {source_db}) failed: {stderr.strip()}"
        )


async def ensure_worktree_postgres_db(workspace: str, worktree_name: str) -> str:
    """Idempotently ensure a worktree's live-dev Postgres database exists.

    A worktree's live-dev backends are wired (via the POSTGRES_DB override in
    `generate_docker_compose`) to connect to `postgres_wt_<worktree>`. That DB
    is cloned from dev's default database when the worktree is created, but it
    can be absent later — a BP added to an already-existing worktree, or a
    dev-postgres container recreated and the clone lost. Re-ensuring it keeps
    such a backend from booting against a nonexistent database and crash-
    looping with an opaque connection error.

    Clones dev's default database into the worktree DB the first time; a no-op
    once it exists. Returns the database name. Raises on hard failure (postgres
    unavailable, clone error) — callers (worktree-create and the live-dev
    deploy paths) treat a miss as fatal and abort rather than start a backend
    against a missing database.
    """
    from app.services.infra_service import get_service

    new_db = worktree_db_name(worktree_name)
    svc = get_service("postgres", workspace, stage="dev")
    if not svc.is_enabled():
        raise RuntimeError("Postgres dev service is not enabled")
    if not await svc.is_running():
        raise RuntimeError(
            f"Postgres dev container '{svc.container_name}' is not running"
        )

    secrets = get_service_secrets("postgres", "dev") or {}
    user = secrets.get("POSTGRES_USER", "admin")
    source_db = secrets.get("POSTGRES_DB", "postgres")
    container = svc.container_name

    # The container may have only just (re)started; wait for the server to
    # accept connections before querying/cloning (returns fast once ready).
    await _wait_for_postgres(container, user)
    if await _postgres_db_exists(container, user, new_db):
        return new_db
    await _clone_postgres_db(container, user, source_db, new_db)
    logger.info(
        "Ensured worktree Postgres DB '%s' (cloned from '%s') for worktree '%s'",
        new_db,
        source_db,
        worktree_name,
    )
    return new_db


async def _create_minio_bucket(
    container: str, access_key: str, secret_key: str, bucket: str
) -> None:
    # Like Postgres, the MinIO server may have only just come up — retry the
    # alias set (its readiness probe) so a cold start doesn't silently lose
    # the bucket to best-effort error-swallowing.
    loop = asyncio.get_event_loop()
    deadline = loop.time() + 60.0
    stderr = ""
    while True:
        _, stderr, rc = await run_docker_command(
            "docker",
            "exec",
            container,
            "mc",
            "alias",
            "set",
            "local",
            "http://localhost:9000",
            access_key,
            secret_key,
        )
        if rc == 0:
            break
        if loop.time() >= deadline:
            raise RuntimeError(f"mc alias set failed: {stderr.strip()}")
        await asyncio.sleep(2.0)
    _, stderr, rc = await run_docker_command(
        "docker",
        "exec",
        container,
        "mc",
        "mb",
        "--ignore-existing",
        f"local/{bucket}",
    )
    if rc != 0:
        raise RuntimeError(f"mc mb {bucket} failed: {stderr.strip()}")


async def ensure_bp_databases(
    workspace: str,
    bp_slug: str,
    bp_name: str,
    realm: str,
    services: list[str] | None = None,
) -> dict:
    """Create the per-BP objects for every requested service at one realm.

    Idempotent. Only touches services that are enabled (secrets file exists)
    and whose container is running; the rest are reported as skipped and
    retried on the next deploy. Marks each successfully created service as
    provisioned in the registry. Returns a per-service result dict.
    """
    from app.services.infra_service import get_service

    validate_bp_slug(bp_slug)
    if realm not in SERVICE_REALMS:
        raise ValueError(
            f"Invalid realm '{realm}': must be one of {sorted(SERVICE_REALMS)}"
        )

    names = bp_resource_names(bp_slug)
    requested = [s for s in (services or BP_DATA_SERVICES) if s in BP_DATA_SERVICES]

    registry = load_registry()
    register_bp_stage(registry, bp_slug, bp_name, realm)
    stage_entry = registry["bps"][bp_slug]["stages"][realm]
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
            elif svc_type == "minio":
                secrets = get_service_secrets("minio", realm) or {}
                await _create_minio_bucket(
                    svc.container_name,
                    secrets.get("MINIO_ROOT_USER", "admin"),
                    secrets.get("MINIO_ROOT_PASSWORD", ""),
                    names["minio_bucket"],
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
        dep_slug, wt = derive_bp_and_worktree(conf.get("relative_path"))
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
            bp_slug, wt = derive_bp_and_worktree(relative_path)
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


async def provision_for_deployments(
    workspace: str, bs_yaml: dict | None, deployment_ids: list[str]
) -> None:
    """Post-compose-up hook: create the per-BP objects for any registered
    BP×realm touched by the given deployments that still has unprovisioned
    services. Stateless between the registration hook and this one — the
    registry IS the contract. Best-effort; never raises (deploys must not
    break on snapshot plumbing).
    """
    try:
        deployments = (bs_yaml or {}).get("deployments") or {}
        registry = load_registry()
        seen: set[tuple[str, str]] = set()
        for dep_id in deployment_ids:
            conf = deployments.get(dep_id) or {}
            bp_slug, wt = derive_bp_and_worktree(conf.get("relative_path"))
            if not bp_slug or wt:
                continue
            dep_stage = conf.get("stage") or "production"
            realm = stage_for_deployment(dep_stage)
            if realm not in SERVICE_REALMS or (bp_slug, realm) in seen:
                continue
            seen.add((bp_slug, realm))
            entry = get_bp_entry(registry, bp_slug)
            if not entry or realm not in entry.get("stages", {}):
                continue
            svc_state = entry["stages"][realm].get("services", {})
            if all(svc_state.get(s, {}).get("provisioned") for s in BP_DATA_SERVICES):
                continue
            results = await ensure_bp_databases(
                workspace, bp_slug, entry.get("bp_name", bp_slug), realm
            )
            logger.info("Per-BP databases for '%s' at %s: %s", bp_slug, realm, results)
    except Exception as e:
        logger.warning("Per-BP database provisioning failed (non-fatal): %s", e)
