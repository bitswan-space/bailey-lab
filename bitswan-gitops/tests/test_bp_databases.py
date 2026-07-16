"""
Unit tests for per-BP database provisioning (app/services/bp_databases.py)
and the per-BP env injection in generate_docker_compose.

No Docker, no git: docker exec calls are faked at the module boundary and
BITSWAN_GITOPS_DIR points at a tmp_path.
"""

import asyncio
import os

import pytest

from app.services import bp_databases
from app.services.bp_databases import (
    bp_resource_names,
    derive_bp_and_copy,
    ensure_bp_databases,
    get_service_secrets,
    is_registered,
    load_registry,
    register_bp_stage,
    register_new_bps_for_members,
    save_registry,
    validate_bp_slug,
)


@pytest.fixture
def gitops_home(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))
    monkeypatch.setenv("BITSWAN_WORKSPACE_NAME", "ws-test")
    return tmp_path


# ---------------------------------------------------------------------------
# names
# ---------------------------------------------------------------------------


def test_bp_resource_names_basic():
    names = bp_resource_names("my-bp")
    assert names == {
        "postgres_db": "bp_my_bp",
        "couchdb_prefix": "bp-my-bp-",
        "s3_bucket": "bp-my-bp",
    }


def test_bp_resource_names_truncates_long_slugs():
    slug = "a" * 99 + "b"
    names = bp_resource_names(slug)
    assert len(names["postgres_db"]) == 63
    assert len(names["s3_bucket"]) <= 63
    assert not names["s3_bucket"].endswith("-")


@pytest.mark.parametrize(
    "bad",
    ["", "Has Spaces", "UPPER", "-leading", "a/b", "a..b", "a" * 101, "a_b"],
)
def test_validate_bp_slug_rejects(bad):
    with pytest.raises(ValueError):
        validate_bp_slug(bad)


def test_derive_bp_and_copy():
    # main copy: unprefixed scope (no copy context).
    assert derive_bp_and_copy("copies/main/Test BP/backend") == ("test-bp", "")
    # non-main copy: carries the copy name as context.
    assert derive_bp_and_copy("copies/bar/Test BP/backend") == (
        "test-bp",
        "bar",
    )
    # Top-level automation: no BP segment.
    assert derive_bp_and_copy("standalone") == ("", "")
    # Copy-root automation: copy but no BP.
    assert derive_bp_and_copy("copies/bar/standalone") == ("", "bar")
    assert derive_bp_and_copy(None) == ("", "")
    assert derive_bp_and_copy("") == ("", "")


# ---------------------------------------------------------------------------
# registry
# ---------------------------------------------------------------------------


def test_registry_roundtrip(gitops_home):
    reg = load_registry()
    assert reg == {"version": 1, "bps": {}}
    assert register_bp_stage(reg, "my-bp", "My BP", "dev") is True
    # Idempotent per stage.
    assert register_bp_stage(reg, "my-bp", "My BP", "dev") is False
    assert register_bp_stage(reg, "my-bp", "My BP", "staging") is True
    save_registry(reg)

    reg2 = load_registry()
    assert is_registered(reg2, "my-bp", "dev")
    assert is_registered(reg2, "my-bp", "staging")
    assert not is_registered(reg2, "my-bp", "production")
    assert reg2["bps"]["my-bp"]["bp_name"] == "My BP"
    # Registry file is private.
    mode = os.stat(gitops_home / "secrets" / "bp-databases.json").st_mode & 0o777
    assert mode == 0o600


def test_registry_slug_collision(gitops_home):
    reg = load_registry()
    register_bp_stage(reg, "my-bp", "My BP", "dev")
    with pytest.raises(ValueError, match="collision"):
        register_bp_stage(reg, "my-bp", "My_BP", "staging")


def test_register_rejects_bad_realm(gitops_home):
    reg = load_registry()
    with pytest.raises(ValueError):
        register_bp_stage(reg, "my-bp", "My BP", "live-dev")


def test_corrupt_registry_fails_loudly(gitops_home):
    (gitops_home / "secrets").mkdir(exist_ok=True)
    (gitops_home / "secrets" / "bp-databases.json").write_text("{not json")
    with pytest.raises(RuntimeError):
        load_registry()


# ---------------------------------------------------------------------------
# secrets helper
# ---------------------------------------------------------------------------


def test_get_service_secrets(gitops_home):
    secrets_dir = gitops_home / "secrets"
    secrets_dir.mkdir()
    (secrets_dir / "postgres-dev").write_text(
        "POSTGRES_USER=admin\nPOSTGRES_PASSWORD=pw\n# comment\nPOSTGRES_HOST=h\n"
    )
    (secrets_dir / "garage").write_text("S3_HOST=ws-garage\n")

    assert get_service_secrets("postgres", "dev") == {
        "POSTGRES_USER": "admin",
        "POSTGRES_PASSWORD": "pw",
        "POSTGRES_HOST": "h",
    }
    # production has no suffix
    assert get_service_secrets("garage", "production") == {"S3_HOST": "ws-garage"}
    assert get_service_secrets("couchdb", "dev") is None


def _write_garage_creds(gitops_home, realm, name, ak="GKsys", sk="sksys"):
    creds_dir = gitops_home / "secrets" / "garagecreds" / realm
    creds_dir.mkdir(parents=True, exist_ok=True)
    (creds_dir / name).write_text(f"S3_ACCESS_KEY={ak}\nS3_SECRET_KEY={sk}\n")


def test_garage_creds_reader(gitops_home):
    # Missing file → None.
    assert bp_databases._garage_creds("dev", "_system") is None
    _write_garage_creds(gitops_home, "dev", "_system")
    assert bp_databases._garage_creds("dev", "_system") == ("GKsys", "sksys")
    # A placeholder (empty file the driver writes before CreateKey) → None.
    (gitops_home / "secrets" / "garagecreds" / "dev" / "bp-my-bp").write_text("")
    assert bp_databases._garage_creds("dev", "bp-my-bp") is None


# ---------------------------------------------------------------------------
# ensure_bp_databases
# ---------------------------------------------------------------------------


class FakeService:
    def __init__(self, container_name, enabled=True, running=True):
        self.container_name = container_name
        self._enabled = enabled
        self._running = running

    def is_enabled(self):
        return self._enabled

    async def is_running(self):
        return self._running


@pytest.fixture
def fake_docker(monkeypatch):
    """Capture docker exec invocations; scripted per-command results."""
    calls = []

    async def fake_run(*args, cwd=None):
        calls.append(list(args))
        joined = " ".join(args)
        if "pg_database WHERE datname" in joined:
            return "", "", 0  # DB does not exist yet
        if "GetBucketInfo" in args:
            return '{"id":"bkt1"}', "", 0
        return "", "", 0

    monkeypatch.setattr(bp_databases, "_driver_exec", fake_run)
    return calls


async def test_ensure_provisions_all_services(gitops_home, monkeypatch, fake_docker):
    secrets_dir = gitops_home / "secrets"
    secrets_dir.mkdir()
    (secrets_dir / "postgres-dev").write_text(
        "POSTGRES_USER=admin\nPOSTGRES_PASSWORD=pw\nPOSTGRES_HOST=h\n"
    )
    (secrets_dir / "garage-dev").write_text(
        "GARAGE_ADMIN_TOKEN=t\nGARAGE_RPC_SECRET=r\nS3_HOST=ws-test-garage-dev\nS3_PORT=9000\n"
    )
    (secrets_dir / "couchdb-dev").write_text(
        "COUCHDB_USER=admin\nCOUCHDB_PASSWORD=pw\n"
    )
    _write_garage_creds(gitops_home, "dev", "_system")

    def fake_get_service(svc_type, workspace, stage="production", **kw):
        return FakeService(f"{workspace}__{svc_type}-{stage}")

    monkeypatch.setattr("app.services.infra_service.get_service", fake_get_service)

    results = await ensure_bp_databases("ws-test", "my-bp", "My BP", "dev")
    assert results == {"postgres": "ok", "couchdb": "ok", "garage": "ok"}

    reg = load_registry()
    svc_state = reg["bps"]["my-bp"]["stages"]["dev"]["services"]
    assert all(svc_state[s]["provisioned"] for s in ("postgres", "couchdb", "garage"))

    # Postgres: existence check then CREATE DATABASE
    pg_calls = [c for c in fake_docker if "psql" in c]
    assert any('CREATE DATABASE "bp_my_bp";' in " ".join(c) for c in pg_calls)
    # Garage: bucket created via json-api and the _system key granted access.
    joined = ["\x00".join(c) for c in fake_docker]
    assert any("CreateBucket" in j and '"globalAlias":"bp-my-bp"' in j for j in joined)
    assert any("AllowBucketKey" in j and '"accessKeyId":"GKsys"' in j for j in joined)

    # Second run: already provisioned, no further docker calls.
    fake_docker.clear()
    results = await ensure_bp_databases("ws-test", "my-bp", "My BP", "dev")
    assert results == {"postgres": "ok", "couchdb": "ok", "garage": "ok"}
    assert fake_docker == []


async def test_ensure_skips_disabled_and_stopped(gitops_home, monkeypatch, fake_docker):
    def fake_get_service(svc_type, workspace, stage="production", **kw):
        if svc_type == "postgres":
            return FakeService("c", enabled=True, running=False)
        return FakeService("c", enabled=False)

    monkeypatch.setattr("app.services.infra_service.get_service", fake_get_service)

    results = await ensure_bp_databases("ws-test", "my-bp", "My BP", "dev")
    assert results["postgres"] == "skipped: not running"
    assert results["couchdb"] == "skipped: not enabled"
    assert results["garage"] == "skipped: not enabled"

    # Stage is registered but nothing is provisioned — next deploy retries.
    reg = load_registry()
    assert is_registered(reg, "my-bp", "dev")
    svc_state = reg["bps"]["my-bp"]["stages"]["dev"]["services"]
    assert svc_state == {}


async def test_ensure_waits_for_cold_postgres(gitops_home, monkeypatch):
    """A just-started Postgres (not yet accepting connections) is waited on,
    not abandoned — the cold-start race that left BPs crash-looping on a
    missing database. pg_isready fails twice, then the DB is created."""
    secrets_dir = gitops_home / "secrets"
    secrets_dir.mkdir()
    (secrets_dir / "postgres-staging").write_text("POSTGRES_USER=admin\n")

    pg_isready_calls = 0
    created = []

    async def fake_run(*args, cwd=None):
        nonlocal pg_isready_calls
        joined = " ".join(args)
        if "pg_isready" in joined:
            pg_isready_calls += 1
            if pg_isready_calls < 3:
                return "", "the database system is starting up", 1
            return "", "", 0
        if "pg_database WHERE datname" in joined:
            return "", "", 0  # does not exist yet
        if "CREATE DATABASE" in joined:
            created.append(joined)
            return "", "", 0
        return "", "", 0

    async def no_sleep(_):
        return None

    monkeypatch.setattr(bp_databases, "_driver_exec", fake_run)
    monkeypatch.setattr("asyncio.sleep", no_sleep)

    def fake_get_service(svc_type, workspace, stage="production", **kw):
        return FakeService(
            f"{workspace}__{svc_type}-{stage}", enabled=(svc_type == "postgres")
        )

    monkeypatch.setattr("app.services.infra_service.get_service", fake_get_service)

    results = await ensure_bp_databases(
        "ws-test", "my-bp", "My BP", "staging", ["postgres"]
    )
    assert results["postgres"] == "ok"
    assert pg_isready_calls == 3  # retried until ready
    assert any('CREATE DATABASE "bp_my_bp";' in c for c in created)
    assert load_registry()["bps"]["my-bp"]["stages"]["staging"]["services"]["postgres"][
        "provisioned"
    ]


async def test_create_garage_bucket_waits_for_health_and_tolerates_exists(
    gitops_home, monkeypatch
):
    """A just-started Garage (GetClusterHealth failing) is waited on, an
    already-existing bucket is tolerated, and BOTH the _system key and the
    BP's scoped key get read+write+owner on the bucket."""
    (gitops_home / "secrets").mkdir(exist_ok=True)
    _write_garage_creds(gitops_home, "dev", "_system", ak="GKsys", sk="sksys")
    _write_garage_creds(gitops_home, "dev", "bp-my-bp", ak="GKbp", sk="skbp")

    health_calls = 0
    calls = []

    async def fake_run(*args, cwd=None):
        nonlocal health_calls
        calls.append(list(args))
        if "GetClusterHealth" in args:
            health_calls += 1
            if health_calls < 3:
                return "", "Could not reach quorum", 1
            return '{"status":"healthy"}', "", 0
        if "CreateBucket" in args:
            return "", "Error: BucketAlreadyExists (409)", 1  # tolerated
        if "GetBucketInfo" in args:
            return '{"id":"bkt1"}', "", 0
        return "", "", 0

    async def no_sleep(_):
        return None

    monkeypatch.setattr(bp_databases, "_driver_exec", fake_run)
    monkeypatch.setattr("asyncio.sleep", no_sleep)

    await bp_databases._create_garage_bucket("ws-test__garage-dev", "dev", "bp-my-bp")
    assert health_calls == 3  # retried until healthy
    grants = ["\x00".join(c) for c in calls if "AllowBucketKey" in c]
    assert any(
        '"accessKeyId":"GKsys"' in g and '"bucketId":"bkt1"' in g for g in grants
    )
    assert any('"accessKeyId":"GKbp"' in g for g in grants)
    assert all('"owner":true' in g for g in grants)


async def test_create_garage_bucket_requires_system_key(gitops_home, fake_docker):
    """No _system key yet (the driver's provisioner hasn't run) → RuntimeError,
    so best-effort call sites record an error and the next deploy retries."""
    with pytest.raises(RuntimeError, match="_system"):
        await bp_databases._create_garage_bucket(
            "ws-test__garage-dev", "dev", "bp-my-bp"
        )


# ---------------------------------------------------------------------------
# first-deploy gating
# ---------------------------------------------------------------------------


def test_first_deploy_registers_new_bp(gitops_home):
    out = register_new_bps_for_members(
        {"deployments": {}},
        [{"relative_path": "New BP/backend", "stage": "dev"}],
    )
    assert out == [("new-bp", "New BP", "dev")]
    assert is_registered(load_registry(), "new-bp", "dev")


def test_existing_bp_is_not_auto_migrated(gitops_home):
    bs_yaml = {
        "deployments": {
            "backend-old-bp-dev": {
                "stage": "dev",
                "relative_path": "Old BP/backend",
            }
        }
    }
    out = register_new_bps_for_members(
        bs_yaml, [{"relative_path": "Old BP/backend", "stage": "dev"}]
    )
    assert out == []
    assert not is_registered(load_registry(), "old-bp", "dev")


def test_existing_bp_at_other_realm_still_registers(gitops_home):
    # BP deployed at dev only — first deploy to staging registers staging.
    bs_yaml = {
        "deployments": {
            "backend-old-bp-dev": {
                "stage": "dev",
                "relative_path": "Old BP/backend",
            }
        }
    }
    out = register_new_bps_for_members(
        bs_yaml, [{"relative_path": "Old BP/backend", "stage": "staging"}]
    )
    assert out == [("old-bp", "Old BP", "staging")]


def test_live_dev_maps_to_dev_realm(gitops_home):
    out = register_new_bps_for_members(
        {"deployments": {}},
        [{"relative_path": "New BP/backend", "stage": "live-dev"}],
    )
    assert out == [("new-bp", "New BP", "dev")]
    # A pre-existing live-dev deployment blocks dev-realm registration too.
    bs_yaml = {
        "deployments": {
            "backend-other-live-dev": {
                "stage": "live-dev",
                "relative_path": "Other BP/backend",
            }
        }
    }
    out = register_new_bps_for_members(
        bs_yaml, [{"relative_path": "Other BP/backend", "stage": "dev"}]
    )
    assert out == []


def test_copy_members_never_register(gitops_home):
    out = register_new_bps_for_members(
        {"deployments": {}},
        [
            {
                "relative_path": "copies/foo/New BP/backend",
                "stage": "live-dev",
            }
        ],
    )
    assert out == []
    assert load_registry()["bps"] == {}


def test_copy_deployments_do_not_block_registration(gitops_home):
    # Only non-copy deployments count as "the BP already exists here".
    bs_yaml = {
        "deployments": {
            "backend-wt-foo-new-bp-live-dev": {
                "stage": "live-dev",
                "relative_path": "copies/foo/New BP/backend",
            }
        }
    }
    out = register_new_bps_for_members(
        bs_yaml, [{"relative_path": "New BP/backend", "stage": "dev"}]
    )
    assert out == [("new-bp", "New BP", "dev")]


def test_registration_never_raises(gitops_home, monkeypatch):
    def boom():
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(bp_databases, "load_registry", boom)
    out = register_new_bps_for_members(
        {"deployments": {}},
        [{"relative_path": "New BP/backend", "stage": "dev"}],
    )
    assert out == []


# ---------------------------------------------------------------------------
# ensure_live_postgres_dbs — deploy-time fail-fast guard
# ---------------------------------------------------------------------------


def _write_pg_secrets(gitops_home, stage="dev"):
    secrets_dir = gitops_home / "secrets"
    secrets_dir.mkdir(exist_ok=True)
    suffix = "" if stage == "production" else f"-{stage}"
    (secrets_dir / f"postgres{suffix}").write_text(
        "POSTGRES_USER=admin\nPOSTGRES_PASSWORD=pw\nPOSTGRES_HOST=h\nPOSTGRES_DB=postgres\n"
    )


def test_copy_bp_resource_names_per_copy_and_bp():
    # Per-(copy, BP): postgres uses underscores, s3/couch use hyphens, all
    # encode BOTH the copy and the BP so distinct (copy, BP) pairs never collide.
    names = bp_databases.copy_bp_resource_names("alice", "my-bp")
    assert names["postgres_db"] == "copy_alice_bp_my_bp"
    assert names["s3_bucket"] == "copy-alice-bp-my-bp"
    assert names["couchdb_prefix"] == "copy-alice-bp-my-bp-"
    # Different BP in the same copy → different names (isolation).
    other = bp_databases.copy_bp_resource_names("alice", "shop")
    assert other["postgres_db"] != names["postgres_db"]
    # Same BP in a different copy → different names too.
    cross = bp_databases.copy_bp_resource_names("bob", "my-bp")
    assert cross["postgres_db"] != names["postgres_db"]


async def test_guard_clones_per_copy_bp_db_at_deploy(gitops_home, fake_docker):
    """A non-main copy's live-dev backend gets its OWN per-(copy, BP) DB at
    deploy, cloned from the BP's dev DB (or the shared dev default)."""
    _write_pg_secrets(gitops_home, "dev")
    bs_yaml = {
        "deployments": {
            "d1": {"relative_path": "copies/alice/My BP/backend", "stage": "live-dev"}
        }
    }
    await bp_databases.ensure_live_postgres_dbs("ws-test", bs_yaml, ["d1"])
    joined = [" ".join(c) for c in fake_docker]
    # bp_my_bp doesn't exist (fresh BP) → seed from the dev default "postgres".
    assert any(
        'CREATE DATABASE "copy_alice_bp_my_bp" WITH TEMPLATE "postgres"' in j
        for j in joined
    ), joined
    # No old single-per-copy database anymore.
    assert not any("postgres_copy_alice" in j for j in joined), joined


async def test_guard_skips_copy_when_postgres_not_enabled(gitops_home, fake_docker):
    """No Postgres in the workspace → skip (no raise, nothing created)."""
    bs_yaml = {
        "deployments": {
            "d1": {"relative_path": "copies/alice/My BP/backend", "stage": "live-dev"}
        }
    }
    await bp_databases.ensure_live_postgres_dbs("ws-test", bs_yaml, ["d1"])
    assert not any("CREATE DATABASE" in " ".join(c) for c in fake_docker)


async def test_guard_creates_bp_db_for_dev(gitops_home, fake_docker):
    _write_pg_secrets(gitops_home, "dev")
    reg = load_registry()
    register_bp_stage(reg, "my-bp", "My BP", "dev")
    save_registry(reg)
    bs_yaml = {
        "deployments": {
            "d1": {"relative_path": "copies/main/My BP/backend", "stage": "dev"}
        }
    }
    await bp_databases.ensure_live_postgres_dbs("ws-test", bs_yaml, ["d1"])
    assert any('CREATE DATABASE "bp_my_bp"' in " ".join(c) for c in fake_docker)


async def test_guard_creates_both_blue_green_prod_dbs(gitops_home, fake_docker):
    _write_pg_secrets(gitops_home, "production")
    reg = load_registry()
    register_bp_stage(reg, "my-bp", "My BP", "production")
    save_registry(reg)
    bs_yaml = {
        "deployments": {
            "d1": {"relative_path": "copies/main/My BP/backend", "stage": "production"}
        },
        "backups": {"my-bp": {"slots": {"blue": {"db": 1}, "green": {"db": 2}}}},
    }
    await bp_databases.ensure_live_postgres_dbs("ws-test", bs_yaml, ["d1"])
    joined = [" ".join(c) for c in fake_docker]
    assert any('CREATE DATABASE "bp_my_bp_1"' in j for j in joined), joined
    assert any('CREATE DATABASE "bp_my_bp_2"' in j for j in joined), joined


async def test_guard_fail_fast_raises_on_create_error(gitops_home, monkeypatch):
    """Postgres enabled but CREATE fails → raise (deploy reports the error)."""
    _write_pg_secrets(gitops_home, "dev")

    async def fake_run(*args, cwd=None):
        joined = " ".join(args)
        if "pg_isready" in joined:
            return "", "", 0
        if "pg_database WHERE datname" in joined:
            return "", "", 0  # not present yet
        if "CREATE DATABASE" in joined:
            return "", "permission denied", 1
        return "", "", 0

    monkeypatch.setattr(bp_databases, "_driver_exec", fake_run)
    bs_yaml = {
        "deployments": {
            "d1": {"relative_path": "copies/alice/My BP/backend", "stage": "live-dev"}
        }
    }
    with pytest.raises(RuntimeError):
        await bp_databases.ensure_live_postgres_dbs("ws-test", bs_yaml, ["d1"])


async def test_guard_clone_idempotent_when_db_exists(gitops_home, monkeypatch):
    """If the per-copy DB already exists, no CREATE is issued (idempotent)."""
    _write_pg_secrets(gitops_home, "dev")
    calls = []

    async def fake_run(*args, cwd=None):
        calls.append(list(args))
        joined = " ".join(args)
        if "pg_isready" in joined:
            return "", "", 0
        if "pg_database WHERE datname" in joined:
            return "1", "", 0  # already exists
        return "", "", 0

    monkeypatch.setattr(bp_databases, "_driver_exec", fake_run)
    bs_yaml = {
        "deployments": {
            "d1": {"relative_path": "copies/alice/My BP/backend", "stage": "live-dev"}
        }
    }
    await bp_databases.ensure_live_postgres_dbs("ws-test", bs_yaml, ["d1"])
    assert not any("CREATE DATABASE" in " ".join(c) for c in calls)


# =============================================================================
# Teardown (BP / copy delete)
# =============================================================================


class _FakeSvc:
    def __init__(self, enabled=True, running=True, name="ws__postgres-dev"):
        self.container_name = name
        self._enabled = enabled
        self._running = running

    def is_enabled(self):
        return self._enabled

    async def is_running(self):
        return self._running


def test_drop_bp_databases_covers_blue_green_and_clears_registry(tmp_path, monkeypatch):
    from app.services import bp_databases as bpdb

    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))
    reg = bpdb.load_registry()
    reg["bps"]["letsgo"] = {"bp_name": "letsgo", "stages": {"dev": {}}}
    bpdb.save_registry(reg)

    dropped: list[tuple[str, str, dict]] = []

    async def _capture(workspace, realm, names, results, key_prefix):
        dropped.append((realm, key_prefix, names))
        results[key_prefix] = "ok"

    monkeypatch.setattr(bpdb, "_drop_names_at_realm", _capture)
    res = asyncio.run(bpdb.drop_bp_databases("ws", "letsgo"))
    assert all(v == "ok" for v in res.values())

    # Every realm's single-backend names + production's blue-green 1/2.
    pg_names = {n["postgres_db"] for _, _, n in dropped}
    assert {"bp_letsgo", "bp_letsgo_1", "bp_letsgo_2"} <= pg_names
    prod = [r for r, _, _ in dropped if r == "production"]
    assert len(prod) == 3  # None + db1 + db2
    # Full success → the registry entry is gone.
    assert bpdb.get_bp_entry(bpdb.load_registry(), "letsgo") is None


def test_drop_bp_databases_keeps_registry_entry_on_error(tmp_path, monkeypatch):
    from app.services import bp_databases as bpdb

    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))
    reg = bpdb.load_registry()
    reg["bps"]["letsgo"] = {"bp_name": "letsgo", "stages": {"dev": {}}}
    bpdb.save_registry(reg)

    async def _fail(workspace, realm, names, results, key_prefix):
        results[key_prefix] = "error: service not running"

    monkeypatch.setattr(bpdb, "_drop_names_at_realm", _fail)
    res = asyncio.run(bpdb.drop_bp_databases("ws", "letsgo"))
    assert any(v.startswith("error") for v in res.values())
    # The kept entry is the retry marker for the idempotent delete re-run.
    assert bpdb.get_bp_entry(bpdb.load_registry(), "letsgo") is not None


def test_drop_copy_bp_databases_names_and_commands(tmp_path, monkeypatch):
    from app.services import bp_databases as bpdb
    from app.services import infra_service

    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))
    monkeypatch.setattr(
        infra_service, "get_service", lambda t, w, stage: _FakeSvc(name=f"c-{t}")
    )
    monkeypatch.setattr(
        bpdb,
        "get_service_secrets",
        lambda t, realm: {
            "POSTGRES_USER": "admin",
            "S3_HOST": "ws-garage-dev",
            "S3_PORT": "9000",
            "COUCHDB_USER": "cu",
            "COUCHDB_PASSWORD": "cp",
        },
    )
    _write_garage_creds(tmp_path, "dev", "_system", ak="GKsys", sk="sksys")
    _write_garage_creds(tmp_path, "dev", "copy-alice-bp-letsgo", ak="GKbp", sk="skbp")

    cmds: list[tuple[str, ...]] = []

    async def _exec(*args, cwd=None):
        cmds.append(args)
        if "curl" in args and "_all_dbs" in args[-1]:
            return '["copy-alice-bp-letsgo-x", "unrelated"]', "", 0
        if "GetBucketInfo" in args:
            return '{"id":"bkt1"}', "", 0
        return "", "", 0

    monkeypatch.setattr(bpdb, "_driver_exec", _exec)
    res = asyncio.run(bpdb.drop_copy_bp_databases("ws", "alice", ["letsgo"]))
    assert all(not v.startswith("error") for v in res.values()), res

    flat = ["\x00".join(c) for c in cmds]
    assert any('DROP DATABASE IF EXISTS "copy_alice_bp_letsgo";' in f for f in flat)
    # Bucket contents purged via rclone in the TOOLBOX (purge also deletes
    # the bucket on Garage), then the admin DeleteBucket no-op + key cleanup.
    assert any(
        "c-garage-toolbox" in f and "purge" in f and ":s3:copy-alice-bp-letsgo" in f
        for f in flat
    )
    assert any("DeleteBucket" in f and '"id":"bkt1"' in f for f in flat)
    assert any("DeleteKey" in f and '"id":"GKbp"' in f for f in flat)
    # The scoped creds file is gone.
    assert not (
        tmp_path / "secrets" / "garagecreds" / "dev" / "copy-alice-bp-letsgo"
    ).exists()
    # Only the prefixed couch db is DELETEd, not the unrelated one.
    assert any(
        "curl" in f and "DELETE" in f and "copy-alice-bp-letsgo-x" in f for f in flat
    )
    assert not any("curl" in f and "DELETE" in f and "unrelated" in f for f in flat)
