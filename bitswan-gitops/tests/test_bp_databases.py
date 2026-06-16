"""
Unit tests for per-BP database provisioning (app/services/bp_databases.py)
and the per-BP env injection in generate_docker_compose.

No Docker, no git: docker exec calls are faked at the module boundary and
BITSWAN_GITOPS_DIR points at a tmp_path.
"""

import os

import pytest
import yaml

from app.services import bp_databases
from app.services.bp_databases import (
    bp_resource_names,
    derive_bp_and_worktree,
    ensure_bp_databases,
    ensure_worktree_postgres_db,
    get_service_secrets,
    is_registered,
    load_registry,
    register_bp_stage,
    register_new_bps_for_members,
    save_registry,
    validate_bp_slug,
    worktree_db_name,
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
        "minio_bucket": "bp-my-bp",
    }


def test_bp_resource_names_truncates_long_slugs():
    slug = "a" * 99 + "b"
    names = bp_resource_names(slug)
    assert len(names["postgres_db"]) == 63
    assert len(names["minio_bucket"]) <= 63
    assert not names["minio_bucket"].endswith("-")


@pytest.mark.parametrize(
    "bad",
    ["", "Has Spaces", "UPPER", "-leading", "a/b", "a..b", "a" * 101, "a_b"],
)
def test_validate_bp_slug_rejects(bad):
    with pytest.raises(ValueError):
        validate_bp_slug(bad)


def test_derive_bp_and_worktree():
    assert derive_bp_and_worktree("Test BP/backend") == ("test-bp", "")
    assert derive_bp_and_worktree("worktrees/bar/Test BP/backend") == (
        "test-bp",
        "bar",
    )
    # Top-level automation: no BP segment.
    assert derive_bp_and_worktree("standalone") == ("", "")
    # Worktree root automation: worktree but no BP.
    assert derive_bp_and_worktree("worktrees/bar/standalone") == ("", "bar")
    assert derive_bp_and_worktree(None) == ("", "")
    assert derive_bp_and_worktree("") == ("", "")


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
    (secrets_dir / "minio").write_text("MINIO_ROOT_USER=admin\n")

    assert get_service_secrets("postgres", "dev") == {
        "POSTGRES_USER": "admin",
        "POSTGRES_PASSWORD": "pw",
        "POSTGRES_HOST": "h",
    }
    # production has no suffix
    assert get_service_secrets("minio", "production") == {"MINIO_ROOT_USER": "admin"}
    assert get_service_secrets("couchdb", "dev") is None


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
        return "", "", 0

    monkeypatch.setattr(bp_databases, "run_docker_command", fake_run)
    return calls


async def test_ensure_provisions_all_services(gitops_home, monkeypatch, fake_docker):
    secrets_dir = gitops_home / "secrets"
    secrets_dir.mkdir()
    (secrets_dir / "postgres-dev").write_text(
        "POSTGRES_USER=admin\nPOSTGRES_PASSWORD=pw\nPOSTGRES_HOST=h\n"
    )
    (secrets_dir / "minio-dev").write_text(
        "MINIO_ROOT_USER=admin\nMINIO_ROOT_PASSWORD=pw\n"
    )
    (secrets_dir / "couchdb-dev").write_text(
        "COUCHDB_USER=admin\nCOUCHDB_PASSWORD=pw\n"
    )

    def fake_get_service(svc_type, workspace, stage="production", **kw):
        return FakeService(f"{workspace}__{svc_type}-{stage}")

    monkeypatch.setattr("app.services.infra_service.get_service", fake_get_service)

    results = await ensure_bp_databases("ws-test", "my-bp", "My BP", "dev")
    assert results == {"postgres": "ok", "couchdb": "ok", "minio": "ok"}

    reg = load_registry()
    svc_state = reg["bps"]["my-bp"]["stages"]["dev"]["services"]
    assert all(svc_state[s]["provisioned"] for s in ("postgres", "couchdb", "minio"))

    # Postgres: existence check then CREATE DATABASE
    pg_calls = [c for c in fake_docker if "psql" in c]
    assert any('CREATE DATABASE "bp_my_bp";' in " ".join(c) for c in pg_calls)
    # MinIO: bucket created idempotently
    mc_calls = [c for c in fake_docker if "mc" in c]
    assert any("local/bp-my-bp" in " ".join(c) for c in mc_calls)

    # Second run: already provisioned, no further docker calls.
    fake_docker.clear()
    results = await ensure_bp_databases("ws-test", "my-bp", "My BP", "dev")
    assert results == {"postgres": "ok", "couchdb": "ok", "minio": "ok"}
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
    assert results["minio"] == "skipped: not enabled"

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

    monkeypatch.setattr(bp_databases, "run_docker_command", fake_run)
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


# ---------------------------------------------------------------------------
# worktree database
# ---------------------------------------------------------------------------


def test_worktree_db_name_sanitizes():
    assert worktree_db_name("foo") == "postgres_wt_foo"
    # Uppercase and non [a-z0-9_] chars collapse to underscores.
    assert worktree_db_name("Feat/Bar-1") == "postgres_wt_feat_bar_1"


async def test_ensure_worktree_db_clones_when_missing(
    gitops_home, monkeypatch, fake_docker
):
    """A BP added to an existing worktree (or a recreated dev-postgres) finds
    no `postgres_wt_<wt>` — ensure clones it from the dev default DB."""
    secrets_dir = gitops_home / "secrets"
    secrets_dir.mkdir()
    (secrets_dir / "postgres-dev").write_text(
        "POSTGRES_USER=admin\nPOSTGRES_PASSWORD=pw\nPOSTGRES_DB=postgres\n"
    )

    def fake_get_service(svc_type, workspace, stage="production", **kw):
        return FakeService(f"{workspace}__{svc_type}-{stage}")

    monkeypatch.setattr("app.services.infra_service.get_service", fake_get_service)

    # fake_docker reports the DB as nonexistent, so a clone must happen.
    name = await ensure_worktree_postgres_db("ws-test", "foo")
    assert name == "postgres_wt_foo"
    creates = [c for c in fake_docker if "CREATE DATABASE" in " ".join(c)]
    assert any(
        'CREATE DATABASE "postgres_wt_foo" WITH TEMPLATE "postgres";' in " ".join(c)
        for c in creates
    )


async def test_ensure_worktree_db_noop_when_present(gitops_home, monkeypatch):
    """When the worktree DB already exists, ensure is a no-op (no CREATE)."""
    secrets_dir = gitops_home / "secrets"
    secrets_dir.mkdir()
    (secrets_dir / "postgres-dev").write_text("POSTGRES_USER=admin\n")

    calls = []

    async def fake_run(*args, cwd=None):
        calls.append(list(args))
        joined = " ".join(args)
        if "pg_database WHERE datname" in joined:
            return "1", "", 0  # already exists
        return "", "", 0

    monkeypatch.setattr(bp_databases, "run_docker_command", fake_run)

    def fake_get_service(svc_type, workspace, stage="production", **kw):
        return FakeService(f"{workspace}__{svc_type}-{stage}")

    monkeypatch.setattr("app.services.infra_service.get_service", fake_get_service)

    name = await ensure_worktree_postgres_db("ws-test", "foo")
    assert name == "postgres_wt_foo"
    assert not any("CREATE DATABASE" in " ".join(c) for c in calls)


async def test_ensure_worktree_db_raises_when_postgres_down(gitops_home, monkeypatch):
    """Postgres dev not running is a hard failure — both the worktree-create
    path and the deploy path surface it and abort rather than start a backend
    against a missing database."""

    def fake_get_service(svc_type, workspace, stage="production", **kw):
        return FakeService("c", enabled=True, running=False)

    monkeypatch.setattr("app.services.infra_service.get_service", fake_get_service)

    with pytest.raises(RuntimeError, match="not running"):
        await ensure_worktree_postgres_db("ws-test", "foo")


async def test_ensure_worktree_db_or_abort_raises_http_500(
    gitops_home, automation_service, monkeypatch
):
    """A worktree live-dev deploy aborts with HTTP 500 (never starts the
    containers) when the database can't be ensured."""
    from fastapi import HTTPException

    async def boom(workspace, worktree):
        raise RuntimeError("postgres down")

    monkeypatch.setattr(bp_databases, "ensure_worktree_postgres_db", boom)

    with pytest.raises(HTTPException) as exc:
        await automation_service._ensure_worktree_db_or_abort("foo", "live-dev")
    assert exc.value.status_code == 500
    assert "postgres down" in exc.value.detail


async def test_ensure_worktree_db_or_abort_noop_off_worktree_live_dev(
    gitops_home, automation_service, monkeypatch
):
    """Non-worktree or non-live-dev deploys never touch the worktree DB."""
    called = []

    async def spy(workspace, worktree):
        called.append((workspace, worktree))
        return "x"

    monkeypatch.setattr(bp_databases, "ensure_worktree_postgres_db", spy)

    await automation_service._ensure_worktree_db_or_abort(None, "live-dev")
    await automation_service._ensure_worktree_db_or_abort("foo", "dev")
    await automation_service._ensure_worktree_db_or_abort("foo", "production")
    assert called == []


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


def test_worktree_members_never_register(gitops_home):
    out = register_new_bps_for_members(
        {"deployments": {}},
        [
            {
                "relative_path": "worktrees/foo/New BP/backend",
                "stage": "live-dev",
            }
        ],
    )
    assert out == []
    assert load_registry()["bps"] == {}


def test_worktree_deployments_do_not_block_registration(gitops_home):
    # Only non-worktree deployments count as "the BP already exists here".
    bs_yaml = {
        "deployments": {
            "backend-wt-foo-new-bp-live-dev": {
                "stage": "live-dev",
                "relative_path": "worktrees/foo/New BP/backend",
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
# env injection in generate_docker_compose
# ---------------------------------------------------------------------------


@pytest.fixture
def automation_service(gitops_home, monkeypatch):
    monkeypatch.delenv("KEYCLOAK_URL", raising=False)
    monkeypatch.delenv("BITSWAN_WORKSPACE_ID", raising=False)
    monkeypatch.delenv("BITSWAN_AOC_URL", raising=False)
    monkeypatch.delenv("BITSWAN_AOC_TOKEN", raising=False)
    monkeypatch.delenv("BITSWAN_CERTS_DIR", raising=False)
    from app.services.automation_service import AutomationService

    svc = AutomationService()
    os.makedirs(svc.gitops_dir, exist_ok=True)
    return svc


def _compose_env(svc, bs_yaml):
    """Environment dict of the single automation service in the compose."""
    dc_yaml, _ = svc.generate_docker_compose(bs_yaml)
    dc = yaml.safe_load(dc_yaml)
    (service_name,) = list(dc["services"])
    return dc["services"][service_name].get("environment", {})


def test_compose_injects_env_for_registered_bp(gitops_home, automation_service):
    reg = load_registry()
    register_bp_stage(reg, "my-bp", "My BP", "dev")
    save_registry(reg)

    # dev-stage deployment needs its checksum dir on disk.
    os.makedirs(os.path.join(automation_service.gitops_dir, "abc123"), exist_ok=True)
    bs_yaml = {
        "deployments": {
            "backend-my-bp-dev": {
                "stage": "dev",
                "checksum": "abc123",
                "relative_path": "My BP/backend",
                "automation_name": "backend",
                "context": "my-bp",
            }
        }
    }
    env = _compose_env(automation_service, bs_yaml)
    assert env["POSTGRES_DB"] == "bp_my_bp"
    assert env["COUCHDB_DB_PREFIX"] == "bp-my-bp-"
    assert env["MINIO_BUCKET"] == "bp-my-bp"


def test_compose_no_injection_for_unregistered_bp(gitops_home, automation_service):
    os.makedirs(os.path.join(automation_service.gitops_dir, "abc123"), exist_ok=True)
    bs_yaml = {
        "deployments": {
            "backend-my-bp-dev": {
                "stage": "dev",
                "checksum": "abc123",
                "relative_path": "My BP/backend",
                "automation_name": "backend",
                "context": "my-bp",
            }
        }
    }
    env = _compose_env(automation_service, bs_yaml)
    assert "POSTGRES_DB" not in env
    assert "COUCHDB_DB_PREFIX" not in env
    assert "MINIO_BUCKET" not in env


def test_compose_injection_gated_per_realm(gitops_home, automation_service):
    # Registered at dev only: a production deployment of the same BP gets nothing.
    reg = load_registry()
    register_bp_stage(reg, "my-bp", "My BP", "dev")
    save_registry(reg)

    os.makedirs(os.path.join(automation_service.gitops_dir, "abc123"), exist_ok=True)
    bs_yaml = {
        "deployments": {
            "backend-my-bp": {
                "stage": "",
                "checksum": "abc123",
                "relative_path": "My BP/backend",
                "automation_name": "backend",
                "context": "my-bp",
            }
        }
    }
    env = _compose_env(automation_service, bs_yaml)
    assert "POSTGRES_DB" not in env


def test_worktree_override_wins_over_bp_injection(gitops_home, automation_service):
    """Ordering is load-bearing: worktree live-dev keeps its cloned DB even
    when the BP is registered (live-dev maps to the dev realm)."""
    reg = load_registry()
    register_bp_stage(reg, "my-bp", "My BP", "dev")
    save_registry(reg)

    bs_yaml = {
        "deployments": {
            "backend-wt-foo-my-bp-live-dev": {
                "stage": "live-dev",
                "relative_path": "worktrees/foo/My BP/backend",
                "automation_name": "backend",
                "context": "wt-foo-my-bp",
            }
        }
    }
    dc_yaml, _ = automation_service.generate_docker_compose(bs_yaml)
    dc = yaml.safe_load(dc_yaml)
    (service_name,) = [s for s in dc["services"]]
    env = dc["services"][service_name]["environment"]
    assert env["POSTGRES_DB"] == "postgres_wt_foo"
    # CouchDB/MinIO names aren't worktree-cloned; they share the BP namespace.
    assert env["COUCHDB_DB_PREFIX"] == "bp-my-bp-"
    assert env["MINIO_BUCKET"] == "bp-my-bp"


def test_compose_live_dev_main_injects(gitops_home, automation_service):
    # Main (non-worktree) live-dev shares the dev realm → injected.
    reg = load_registry()
    register_bp_stage(reg, "my-bp", "My BP", "dev")
    save_registry(reg)

    bs_yaml = {
        "deployments": {
            "backend-my-bp-live-dev": {
                "stage": "live-dev",
                "relative_path": "My BP/backend",
                "automation_name": "backend",
                "context": "my-bp",
            }
        }
    }
    dc_yaml, _ = automation_service.generate_docker_compose(bs_yaml)
    dc = yaml.safe_load(dc_yaml)
    (service_name,) = [s for s in dc["services"]]
    env = dc["services"][service_name]["environment"]
    assert env["POSTGRES_DB"] == "bp_my_bp"
