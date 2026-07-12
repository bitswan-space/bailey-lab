"""Off-site (restic) backups through the AOC proxy: env-derived restic
repository, credential-free config, key mirroring via AOC, and the
self-enable flow. GitOps must never see object-storage credentials —
restic talks to AOC's REST-server endpoints with the AOC token.

Distinct from test_backups.py, which covers the per-BP blue-green
backup model in bitswan.yaml."""

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.services import backup_service

AOC_URL = "https://aoc.example.com"
TOKEN = "test-aoc-token"
WORKSPACE_ID = "11111111-2222-3333-4444-555555555555"


@pytest.fixture
def aoc_env(monkeypatch, tmp_path):
    monkeypatch.setenv("BITSWAN_AOC_URL", AOC_URL)
    monkeypatch.setenv("BITSWAN_AOC_TOKEN", TOKEN)
    monkeypatch.setenv("BITSWAN_WORKSPACE_ID", WORKSPACE_ID)
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))
    return tmp_path


@pytest.fixture
def no_aoc_env(monkeypatch, tmp_path):
    monkeypatch.delenv("BITSWAN_AOC_URL", raising=False)
    monkeypatch.delenv("BITSWAN_AOC_TOKEN", raising=False)
    monkeypatch.delenv("BITSWAN_WORKSPACE_ID", raising=False)
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))
    return tmp_path


def test_restic_env_uses_aoc_rest_backend(aoc_env):
    backup_service._save_key("unit-test-key")
    env = backup_service._restic_env({"enabled": True})
    assert env["RESTIC_REPOSITORY"] == (
        f"rest:{AOC_URL}/api/automation_server/workspaces/"
        f"{WORKSPACE_ID}/backups/repo/"
    )
    assert env["RESTIC_REST_USERNAME"] == WORKSPACE_ID
    assert env["RESTIC_REST_PASSWORD"] == TOKEN
    assert env["RESTIC_PASSWORD"] == "unit-test-key"
    # The whole point: no object-storage credentials in the environment
    assert "AWS_ACCESS_KEY_ID" not in env
    assert "AWS_SECRET_ACCESS_KEY" not in env


def test_config_roundtrip(aoc_env):
    config = {"enabled": True, "retention": {"daily": 7, "monthly": 3}}
    backup_service.save_backup_config(config)
    assert backup_service.get_backup_config() == config


def test_is_configured_states(aoc_env):
    assert not backup_service.is_configured()  # nothing saved yet

    backup_service.save_backup_config({"enabled": True, "retention": {}})
    assert not backup_service.is_configured()  # no key yet

    backup_service.generate_restic_key()
    assert backup_service.is_configured()

    backup_service.save_backup_config({"enabled": False, "retention": {}})
    assert not backup_service.is_configured()  # explicitly disabled


def test_is_configured_false_without_aoc(no_aoc_env):
    backup_service.save_backup_config({"enabled": True, "retention": {}})
    backup_service.generate_restic_key()
    assert not backup_service.is_configured()


async def test_ensure_backups_noop_without_aoc(no_aoc_env):
    ok, msg = await backup_service.ensure_backups_enabled()
    assert not ok
    assert "not connected" in msg.lower()
    assert backup_service.get_backup_config() is None


async def test_ensure_backups_respects_disabled(aoc_env):
    backup_service.save_backup_config({"enabled": False, "retention": {}})
    ok, msg = await backup_service.ensure_backups_enabled()
    assert not ok
    assert "disabled" in msg.lower()
    assert backup_service.get_restic_key() is None


async def test_ensure_backups_generates_key_and_inits(aoc_env, monkeypatch):
    restic_calls = []
    uploaded = []

    async def fake_run_restic(args, config, timeout=3600):
        restic_calls.append(args)
        return "", "", 0

    async def fake_download():
        return None

    async def fake_upload(key):
        uploaded.append(key)
        return True, "Key uploaded"

    monkeypatch.setattr(backup_service, "_run_restic", fake_run_restic)
    monkeypatch.setattr(backup_service, "download_key_remote", fake_download)
    monkeypatch.setattr(backup_service, "upload_key_remote", fake_upload)

    ok, msg = await backup_service.ensure_backups_enabled()
    assert ok, msg
    assert ["init"] in restic_calls
    config = backup_service.get_backup_config()
    assert config["enabled"] is True
    assert config["retention"] == backup_service.DEFAULT_RETENTION
    key = backup_service.get_restic_key()
    assert key
    assert uploaded == [key]  # fresh key gets mirrored off-site


async def test_ensure_backups_recovers_remote_key(aoc_env, monkeypatch):
    uploaded = []

    async def fake_run_restic(args, config, timeout=3600):
        return "", "", 0

    async def fake_download():
        return "recovered-key"

    async def fake_upload(key):
        uploaded.append(key)
        return True, "Key uploaded"

    monkeypatch.setattr(backup_service, "_run_restic", fake_run_restic)
    monkeypatch.setattr(backup_service, "download_key_remote", fake_download)
    monkeypatch.setattr(backup_service, "upload_key_remote", fake_upload)

    ok, msg = await backup_service.ensure_backups_enabled()
    assert ok
    assert "recovered" in msg.lower()
    assert backup_service.get_restic_key() == "recovered-key"
    assert uploaded == []  # recovered key is already mirrored


async def test_ensure_backups_is_idempotent(aoc_env, monkeypatch):
    async def fake_run_restic(args, config, timeout=3600):
        return "", "repository master key and config already initialized", 1

    async def fake_download():
        return None

    async def fake_upload(key):
        return True, "Key uploaded"

    monkeypatch.setattr(backup_service, "_run_restic", fake_run_restic)
    monkeypatch.setattr(backup_service, "download_key_remote", fake_download)
    monkeypatch.setattr(backup_service, "upload_key_remote", fake_upload)

    ok1, _ = await backup_service.ensure_backups_enabled()
    key1 = backup_service.get_restic_key()
    ok2, _ = await backup_service.ensure_backups_enabled()
    assert ok1 and ok2
    assert backup_service.get_restic_key() == key1  # key is stable


def _backups_client():
    from app.routes import backups as routes_mod

    app = FastAPI()
    app.include_router(routes_mod.router)
    return TestClient(app)


def test_config_route_rejects_without_aoc(no_aoc_env):
    client = _backups_client()
    response = client.post("/backups/config", json={})
    assert response.status_code == 400
    assert "not connected" in response.json()["detail"].lower()


def test_config_route_enables_with_retention(aoc_env, monkeypatch):
    async def fake_ensure():
        return True, "Repository initialized"

    monkeypatch.setattr(backup_service, "ensure_backups_enabled", fake_ensure)
    client = _backups_client()
    response = client.post(
        "/backups/config", json={"retention_daily": 14, "retention_monthly": 6}
    )
    assert response.status_code == 200
    assert response.json()["status"] == "configured"
    config = backup_service.get_backup_config()
    assert config == {
        "enabled": True,
        "retention": {"daily": 14, "monthly": 6},
    }


def test_config_route_disable(aoc_env):
    client = _backups_client()
    response = client.post("/backups/config", json={"enabled": False})
    assert response.status_code == 200
    assert response.json()["status"] == "disabled"
    assert backup_service.get_backup_config()["enabled"] is False


def test_get_config_reports_state(aoc_env):
    client = _backups_client()
    assert client.get("/backups/config").json() == {
        "configured": False,
        "aoc_connected": True,
    }

    backup_service.save_backup_config(
        {"enabled": True, "retention": {"daily": 30, "monthly": 12}}
    )
    backup_service.generate_restic_key()
    body = client.get("/backups/config").json()
    assert body == {
        "configured": True,
        "aoc_connected": True,
        "enabled": True,
        "retention": {"daily": 30, "monthly": 12},
        "has_key": True,
        "last_run": None,
        "running": False,
    }
    # No credential fields of any kind
    assert not any(k.startswith("s3_") for k in body)


def test_config_file_never_contains_credentials(aoc_env):
    backup_service.save_backup_config(
        {"enabled": True, "retention": {"daily": 30, "monthly": 12}}
    )
    raw = open(backup_service._get_config_path()).read()
    assert "access" not in raw and "secret" not in raw
    assert json.loads(raw) == {
        "enabled": True,
        "retention": {"daily": 30, "monthly": 12},
    }


# -- whole-server run_backup: stage-aware coverage -----------------------------


class _FakeContainer:
    def __init__(self, name, state="running"):
        self.name = name
        self.state = state


class _FakeDriver:
    """Driver whose container_list/exec serve the postgres dump path."""

    def __init__(self, containers, dump=b"-- dump\n"):
        self.containers = containers
        self.dump = dump
        self.execs = []

    async def container_list(self, ctx):
        return self.containers

    async def exec(self, ctx, spec, on_stdout=None):
        self.execs.append(spec)
        if on_stdout:
            await on_stdout(self.dump)
        return 0


class _FakeService:
    """infra_service.get_service stand-in: enabled per (type, stage)."""

    def __init__(self, service_type, workspace, stage, enabled_map):
        suffix = "" if stage == "production" else f"-{stage}"
        self.container_name = f"{workspace}__{service_type}{suffix}"
        self._enabled = (service_type, stage) in enabled_map
        self._type = service_type
        self._stage = stage

    def is_enabled(self):
        return self._enabled

    async def backup(self, backup_dir):
        import os as _os

        path = _os.path.join(backup_dir, f"{self._type}-backup-20260710-120000.tar.gz")
        with open(path, "wb") as f:
            f.write(f"{self._type}-{self._stage}".encode())
        return {"backup_path": path}


async def test_run_backup_is_stage_aware(aoc_env, monkeypatch, tmp_path):
    """Services enabled on dev/staging are backed up too — not just
    production — and the gitops worktree is covered alongside the
    workspace repo."""

    backup_service._save_key("k")

    workspace_repo = tmp_path / "workspace-repo"
    (workspace_repo / "copies" / "main" / "bp").mkdir(parents=True)
    (workspace_repo / "copies" / "main" / "bp" / "app.py").write_text("x")
    monkeypatch.setenv("BITSWAN_WORKSPACE_REPO_DIR", str(workspace_repo))
    monkeypatch.setenv("BITSWAN_WORKSPACE_NAME", "dev")

    gitops_worktree = tmp_path / "gitops"
    gitops_worktree.mkdir()
    (gitops_worktree / "bitswan.yaml").write_text("deployments: {}\n")

    # postgres + minio enabled on dev only; couchdb nowhere (like the
    # on-demand dev workspace that motivated this).
    enabled = {("postgres", "dev"), ("minio", "dev")}
    import app.services.infra_service as infra_mod

    monkeypatch.setattr(
        infra_mod,
        "get_service",
        lambda t, ws, stage="production", **kw: _FakeService(t, ws, stage, enabled),
    )
    import app.services.bp_databases as bpdb_mod

    monkeypatch.setattr(
        bpdb_mod, "get_service_secrets", lambda t, s: {"POSTGRES_USER": "pguser"}
    )

    driver = _FakeDriver([_FakeContainer("dev__postgres-dev")])
    monkeypatch.setattr(
        backup_service, "_driver_and_ctx", lambda ws: (driver, object())
    )

    restic_calls = []

    async def fake_run_restic(args, config, timeout=3600):
        restic_calls.append(list(args))
        return "snapshot abc123 saved", "", 0

    monkeypatch.setattr(backup_service, "_run_restic", fake_run_restic)

    results = await backup_service.run_backup({"enabled": True, "retention": {}})

    backups = [c for c in restic_calls if c[0] == "backup"]
    joined_all = [" ".join(c) for c in backups]

    # workspace repo + gitops worktree
    assert any(str(workspace_repo) in j and "--tag workspace" in j for j in joined_all)
    assert any(str(gitops_worktree) in j and "--tag gitops" in j for j in joined_all)

    # dev-stage postgres dump (correct user, stage tag)
    assert driver.execs and driver.execs[0].cmd == ["pg_dumpall", "-U", "pguser"]
    assert any("--tag postgres" in j and "--tag stage:dev" in j for j in joined_all)

    # dev-stage minio tarball; couchdb skipped everywhere
    assert any("--tag minio" in j and "--tag stage:dev" in j for j in joined_all)
    assert not any("--tag couchdb" in j for j in joined_all)

    assert results["postgres"]["success"] is True
    assert "dev:" in results["postgres"]["output"]
    assert results["couchdb"]["output"] == "CouchDB not enabled on any stage, skipped"
    assert results["minio"]["success"] is True
    assert results["workspace"]["success"] is True
    assert results["gitops"]["success"] is True
    assert backup_service.get_last_run()["ok"] is True

    # exactly one retention pass at the end
    forgets = [c for c in restic_calls if c[0] == "forget"]
    assert len(forgets) == 1


async def test_run_backup_stage_failure_is_isolated(aoc_env, monkeypatch, tmp_path):
    """One stage failing marks the service failed but doesn't abort the run."""
    monkeypatch.setenv("BITSWAN_WORKSPACE_REPO_DIR", str(tmp_path / "nope"))
    monkeypatch.setenv("BITSWAN_WORKSPACE_NAME", "dev")

    enabled = {("minio", "dev"), ("minio", "production")}

    class _ExplodingService(_FakeService):
        async def backup(self, backup_dir):
            if self._stage == "dev":
                raise RuntimeError("mc mirror blew up")
            return await super().backup(backup_dir)

    import app.services.infra_service as infra_mod

    monkeypatch.setattr(
        infra_mod,
        "get_service",
        lambda t, ws, stage="production", **kw: _ExplodingService(
            t, ws, stage, enabled
        ),
    )

    restic_calls = []

    async def fake_run_restic(args, config, timeout=3600):
        restic_calls.append(list(args))
        return "ok", "", 0

    monkeypatch.setattr(backup_service, "_run_restic", fake_run_restic)

    results = await backup_service.run_backup({"enabled": True, "retention": {}})

    assert results["minio"]["success"] is False
    assert "dev: mc mirror blew up" in results["minio"]["output"]
    assert "production: ok" in results["minio"]["output"]
    # production minio still got backed up despite the dev failure
    assert any(
        "--tag minio" in " ".join(c) and "--tag stage:production" in " ".join(c)
        for c in restic_calls
        if c[0] == "backup"
    )
    assert backup_service.get_last_run()["ok"] is False
