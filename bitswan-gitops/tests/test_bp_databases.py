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


def _automation_services(dc):
    """The automation (non-gateway/infra) services in a generated compose."""
    return {
        n: s
        for n, s in dc["services"].items()
        if (s.get("labels", {}) or {}).get("gitops.firewall_gateway") != "true"
        and "BITSWAN_AUTOMATION_STAGE" in (s.get("environment") or {})
    }


def _compose_env(svc, bs_yaml, slot=None):
    """Environment dict of one automation service. A production deployment now
    emits two app slots (a/b); `slot` picks one, else the live slot (the one
    whose deployment_id is canonical — no '@slot' suffix) is returned."""
    dc_yaml, _, _ = svc.generate_docker_compose(bs_yaml)
    dc = yaml.safe_load(dc_yaml)
    svcs = _automation_services(dc)
    if slot is not None:
        for s in svcs.values():
            if (s.get("labels", {}) or {}).get("gitops.slot") == slot:
                return s.get("environment", {})
        raise AssertionError(f"no service for slot {slot!r}")
    for s in svcs.values():
        lbl = s.get("labels", {}) or {}
        if "@" not in (lbl.get("gitops.deployment_id") or ""):
            return s.get("environment", {})
    return next(iter(svcs.values())).get("environment", {})


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


def test_production_emits_two_slots_wired_to_two_dbs(gitops_home, automation_service):
    """A registered production BP emits two app slots (a/b), each a distinct
    container wired to its own logical DB (bp_<slug>_1 / bp_<slug>_2). The live
    slot keeps the canonical deployment_id + owns the canonical hostname."""
    reg = load_registry()
    register_bp_stage(reg, "my-bp", "My BP", "production")
    save_registry(reg)

    os.makedirs(os.path.join(automation_service.gitops_dir, "abc123"), exist_ok=True)
    bs_yaml = {
        "deployments": {
            "backend-my-bp": {
                "stage": "production",
                "checksum": "abc123",
                "relative_path": "My BP/backend",
                "automation_name": "backend",
                "context": "my-bp",
            }
        }
    }
    dc_yaml, _, _ = automation_service.generate_docker_compose(bs_yaml)
    dc = yaml.safe_load(dc_yaml)
    svcs = _automation_services(dc)
    # Two distinct container sets, one per active slot.
    slots = {(s.get("labels", {}) or {}).get("gitops.slot") for s in svcs.values()}
    assert slots == {"a", "b"}, slots
    # Slot a → db1, slot b → db2 — never the same DB.
    env_a = _compose_env(automation_service, bs_yaml, slot="a")
    env_b = _compose_env(automation_service, bs_yaml, slot="b")
    assert env_a["POSTGRES_DB"] == "bp_my_bp_1"
    assert env_b["POSTGRES_DB"] == "bp_my_bp_2"
    assert env_a["MINIO_BUCKET"] == "bp-my-bp-1"
    assert env_b["MINIO_BUCKET"] == "bp-my-bp-2"
    # Live slot (a, by default) keeps the canonical deployment_id; the DR slot
    # (b) is slot-suffixed.
    by_slot = {(s["labels"] or {}).get("gitops.slot"): s for s in svcs.values()}
    assert by_slot["a"]["labels"]["gitops.deployment_id"] == "backend-my-bp"
    assert by_slot["b"]["labels"]["gitops.deployment_id"] == "backend-my-bp@b"
    # Same-slot peer discovery: each slot's URL template is slot-scoped, so a
    # slot's containers resolve their own slot's peers (never the other slot).
    if env_a.get("BITSWAN_URL_TEMPLATE"):
        assert "-a." in env_a["BITSWAN_URL_TEMPLATE"]
        assert "-b." in env_b["BITSWAN_URL_TEMPLATE"]


def test_copy_override_wins_over_bp_injection(gitops_home, automation_service):
    """Ordering is load-bearing: copy live-dev keeps its cloned DB even
    when the BP is registered (live-dev maps to the dev realm)."""
    reg = load_registry()
    register_bp_stage(reg, "my-bp", "My BP", "dev")
    save_registry(reg)

    bs_yaml = {
        "deployments": {
            "backend-copy-foo-my-bp-live-dev": {
                "stage": "live-dev",
                "relative_path": "copies/foo/My BP/backend",
                "automation_name": "backend",
                "context": "copy-foo-my-bp",
            }
        }
    }
    dc_yaml, _, _ = automation_service.generate_docker_compose(bs_yaml)
    dc = yaml.safe_load(dc_yaml)
    (service_name,) = [s for s in dc["services"]]
    env = dc["services"][service_name]["environment"]
    assert env["POSTGRES_DB"] == "postgres_copy_foo"
    # CouchDB/MinIO names aren't copy-cloned; they share the BP namespace.
    assert env["COUCHDB_DB_PREFIX"] == "bp-my-bp-"
    assert env["MINIO_BUCKET"] == "bp-my-bp"


def test_compose_live_dev_main_injects(gitops_home, automation_service):
    # Main (non-copy) live-dev shares the dev realm → injected.
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
    dc_yaml, _, _ = automation_service.generate_docker_compose(bs_yaml)
    dc = yaml.safe_load(dc_yaml)
    (service_name,) = [s for s in dc["services"]]
    env = dc["services"][service_name]["environment"]
    assert env["POSTGRES_DB"] == "bp_my_bp"
