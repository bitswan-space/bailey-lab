"""
Unit tests for the read-only data explorer (app/services/data_explorer.py).

No Docker: the exec seam (`data_explorer._exec`) is a scripted fake and
BITSWAN_GITOPS_DIR points at a tmp_path — the pattern of test_bp_databases.py.
"""

import base64
import json

import pytest

from app.services import bp_databases, data_explorer
from app.services.bp_databases import register_bp_stage, save_registry
from app.services.data_explorer import (
    ExplorerUnavailableError,
    _ro_role,
    resolve_target,
)


@pytest.fixture
def gitops_home(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))
    monkeypatch.setenv("BITSWAN_WORKSPACE_NAME", "ws-test")
    return tmp_path


@pytest.fixture
def registered(gitops_home):
    reg = bp_databases.load_registry()
    register_bp_stage(reg, "my-bp", "My BP", "dev")
    register_bp_stage(reg, "my-bp", "My BP", "production")
    save_registry(reg)
    return reg


class FakeService:
    def __init__(self, enabled=True, running=True):
        self._enabled = enabled
        self._running = running

    def is_enabled(self):
        return self._enabled

    async def is_running(self):
        return self._running


@pytest.fixture
def services_up(monkeypatch):
    """postgres + minio enabled and running."""

    def fake_get_service(svc_type, workspace, stage="production", **kw):
        return FakeService()

    monkeypatch.setattr("app.services.infra_service.get_service", fake_get_service)


TABLES_JSON = json.dumps(
    [
        {"name": "orders", "kind": "table", "row_estimate": 42, "total_bytes": 8192},
        {"name": 'we"ird.tbl', "kind": "table", "row_estimate": -1,
         "total_bytes": 0},
    ]
)
COLUMNS_JSON = json.dumps(
    [
        {"name": "id", "type": "integer", "nullable": False, "position": 1},
        {"name": "note", "type": "text", "nullable": True, "position": 2},
    ]
)


@pytest.fixture
def fake_exec(monkeypatch):
    """Scripted recorder for the docker-exec seam. `handlers` is a list of
    (predicate(argv) -> bool, (stdout, stderr, rc)) tried in order; default ok."""
    calls: list[list[str]] = []
    handlers: list = []

    async def fake(*args):
        argv = list(args)
        calls.append(argv)
        for pred, result in handlers:
            if pred(argv):
                return result
        joined = " ".join(argv)
        if "FROM pg_class" in joined:
            return TABLES_JSON + "\n", "", 0
        if "information_schema.columns" in joined:
            return COLUMNS_JSON + "\n", "", 0
        return "", "", 0

    monkeypatch.setattr(data_explorer, "_exec", fake)
    fake.calls = calls
    fake.handlers = handlers
    return fake


def _psql_calls(calls):
    return [c for c in calls if "psql" in c]


# ---------------------------------------------------------------------------
# role-name mirror
# ---------------------------------------------------------------------------


def test_ro_role_mirrors_go_derivation():
    assert _ro_role("bp_my_bp") == "ro_bp_my_bp"
    # Must match scopedROPGRole in the automation server's bpcreds.go:
    # prefix + truncate at the 63-byte Postgres identifier cap.
    long = "a" * 70
    assert _ro_role(long) == ("ro_" + long)[:63]
    assert len(_ro_role(long)) == 63


# ---------------------------------------------------------------------------
# target resolution
# ---------------------------------------------------------------------------


def test_resolve_dev_and_staging(registered):
    t = resolve_target("My BP", "dev")
    assert (t.postgres_db, t.s3_bucket, t.db) == ("bp_my_bp", "bp-my-bp", None)
    assert t.pg_container == "ws-test__postgres-dev"
    assert t.garage_container == "ws-test__garage-dev"
    assert t.toolbox_container == "ws-test__garage-dev-toolbox"
    # Staging not registered -> 404-shaped error.
    with pytest.raises(LookupError):
        resolve_target("My BP", "staging")


def test_resolve_production_defaults_to_live_db(registered, monkeypatch):
    class FakeAutomationService:
        def live_db(self, bp):
            assert bp == "my-bp"
            return 2

    monkeypatch.setattr(
        "app.dependencies.get_automation_service", lambda: FakeAutomationService()
    )
    t = resolve_target("my-bp", "production")
    assert (t.postgres_db, t.s3_bucket, t.db) == ("bp_my_bp_2", "bp-my-bp-2", 2)
    assert t.pg_container == "ws-test__postgres"  # production: no suffix
    # Explicit override skips live_db.
    t = resolve_target("my-bp", "production", db=1)
    assert (t.postgres_db, t.db) == ("bp_my_bp_1", 1)
    with pytest.raises(ValueError):
        resolve_target("my-bp", "production", db=3)


def test_resolve_copy_scope(registered):
    t = resolve_target("my-bp", "dev", copy="bar")
    assert t.postgres_db == "copy_bar_bp_my_bp"
    assert t.s3_bucket == "copy-bar-bp-my-bp"
    # main copy == plain dev names (and doesn't need its own registration).
    t = resolve_target("my-bp", "dev", copy="main")
    assert t.postgres_db == "bp_my_bp"
    # Copy scope is dev-only, blue-green is production-only.
    with pytest.raises(ValueError):
        resolve_target("my-bp", "staging", copy="bar")
    with pytest.raises(ValueError):
        resolve_target("my-bp", "dev", copy="bar", db=1)
    with pytest.raises(ValueError):
        resolve_target("my-bp", "dev", copy="Bad Copy!")
    # A copy target skips the registry gate (per-copy DBs aren't registered).
    resolve_target("unregistered-bp", "dev", copy="bar")


def test_resolve_rejects_bad_input(registered):
    with pytest.raises(ValueError):
        resolve_target("my-bp", "live-dev")
    with pytest.raises(ValueError):
        resolve_target("my-bp", "dev", db=1)
    with pytest.raises(ValueError):
        resolve_target("", "dev")


async def test_service_gates(registered, monkeypatch, fake_exec):
    def stopped(svc_type, workspace, stage="production", **kw):
        return FakeService(enabled=True, running=False)

    monkeypatch.setattr("app.services.infra_service.get_service", stopped)
    with pytest.raises(ExplorerUnavailableError):
        await data_explorer.list_tables(resolve_target("my-bp", "dev"))

    def disabled(svc_type, workspace, stage="production", **kw):
        return FakeService(enabled=False)

    monkeypatch.setattr("app.services.infra_service.get_service", disabled)
    with pytest.raises(LookupError):
        await data_explorer.list_tables(resolve_target("my-bp", "dev"))


async def test_overview_reports_flags(registered, services_up):
    out = await data_explorer.overview("my-bp", "dev")
    assert out["registered"] is True
    assert out["postgres"] == {
        "enabled": True,
        "running": True,
        "database": "bp_my_bp",
    }
    assert out["garage"]["bucket"] == "bp-my-bp"
    # Unregistered BP: flags still reported, no resource names, no raise.
    out = await data_explorer.overview("ghost-bp", "dev")
    assert out["registered"] is False
    assert "database" not in out["postgres"]


# ---------------------------------------------------------------------------
# SQL explorer
# ---------------------------------------------------------------------------


async def test_list_tables_shape_and_argv(registered, services_up, fake_exec):
    t = resolve_target("my-bp", "dev")
    tables = await data_explorer.list_tables(t)
    assert [x["name"] for x in tables] == ["orders", 'we"ird.tbl']
    (call,) = _psql_calls(fake_exec.calls)
    assert call[2] == "ws-test__postgres-dev"
    assert call[call.index("-U") + 1] == "ro_bp_my_bp"
    assert call[call.index("-d") + 1] == "bp_my_bp"
    assert "ON_ERROR_STOP=1" in call
    assert "SET statement_timeout TO '5s'" in call[-1]


async def test_list_tables_parses_multiline_json_agg(
    registered, services_up, fake_exec
):
    # Raw json_agg (without the ::jsonb cast) puts a newline between array
    # elements — exactly what a real psql run produced. The parser must not
    # depend on the value being single-line.
    multiline = (
        '[{"name":"gallery_images","kind":"table","row_estimate":-1,'
        '"total_bytes":49152}, \n {"name":"user_counters","kind":"table",'
        '"row_estimate":-1,"total_bytes":32768}]\n'
    )
    fake_exec.handlers.append(
        (lambda argv: "FROM pg_class" in " ".join(argv), (multiline, "", 0))
    )
    t = resolve_target("my-bp", "dev")
    tables = await data_explorer.list_tables(t)
    assert [x["name"] for x in tables] == ["gallery_images", "user_counters"]
    # A stray command tag before the JSON must not break parsing either.
    fake_exec.handlers[-1] = (
        lambda argv: "FROM pg_class" in " ".join(argv),
        ("SET\n" + multiline, "", 0),
    )
    tables = await data_explorer.list_tables(t)
    assert len(tables) == 2


async def test_rows_page_and_quoting(registered, services_up, fake_exec):
    rows = [{"id": i, "note": "n"} for i in range(51)]  # limit+1 => has_more
    fake_exec.handlers.append(
        (lambda argv: 'FROM "orders"' in " ".join(argv), (json.dumps(rows), "", 0))
    )
    t = resolve_target("my-bp", "dev")
    page = await data_explorer.table_rows(
        t, "orders", limit=50, offset=0, sort="id", order="desc"
    )
    assert page["has_more"] is True
    assert len(page["rows"]) == 50
    assert page["row_estimate"] == 42
    assert [c["name"] for c in page["columns"]] == ["id", "note"]
    sql = _psql_calls(fake_exec.calls)[-1][-1]
    assert "SET statement_timeout TO '10s'" in sql
    assert 'left(("id")::text, 2048) AS "id"' in sql
    assert 'ORDER BY "id" DESC' in sql
    assert "LIMIT 51 OFFSET 0" in sql


async def test_rows_weird_table_name_roundtrips(registered, services_up, fake_exec):
    fake_exec.handlers.append(
        (lambda argv: 'FROM "we""ird.tbl"' in " ".join(argv), ("[]", "", 0))
    )
    t = resolve_target("my-bp", "dev")
    page = await data_explorer.table_rows(t, 'we"ird.tbl')
    assert page["rows"] == []
    # The listed name was quoted with doubled double-quotes, byte-for-byte.
    assert any(
        'FROM "we""ird.tbl"' in c[-1] for c in _psql_calls(fake_exec.calls)
    )


async def test_rows_rejects_unlisted_identifiers(registered, services_up, fake_exec):
    t = resolve_target("my-bp", "dev")
    with pytest.raises(LookupError):
        await data_explorer.table_rows(t, "no_such_table")
    with pytest.raises(ValueError):
        await data_explorer.table_rows(t, "orders", sort="no_such_col")
    with pytest.raises(ValueError):
        await data_explorer.table_rows(t, "orders", sort="id", order="sideways")
    with pytest.raises(ValueError):
        await data_explorer.table_rows(t, "bad\x00name")
    with pytest.raises(ValueError):
        await data_explorer.table_rows(t, "x" * 64)


async def test_self_heal_provisions_ro_role_once(
    registered, services_up, fake_exec, gitops_home, monkeypatch
):
    (gitops_home / "secrets" / "postgres-dev").write_text(
        "POSTGRES_USER=admin\nPOSTGRES_PASSWORD=pw\n"
    )
    state = {"healed": False}

    def ro_query(argv):
        return "ro_bp_my_bp" in argv and "FROM pg_class" in " ".join(argv)

    async def scripted(*args):
        argv = list(args)
        fake_exec.calls.append(argv)
        if ro_query(argv):
            if not state["healed"]:
                return "", 'FATAL:  role "ro_bp_my_bp" does not exist', 1
            return TABLES_JSON, "", 0
        if "CREATE ROLE" in " ".join(argv):
            state["healed"] = True
        return "", "", 0

    monkeypatch.setattr(data_explorer, "_exec", scripted)
    t = resolve_target("my-bp", "dev")
    tables = await data_explorer.list_tables(t)
    assert [x["name"] for x in tables] == ["orders", 'we"ird.tbl']
    joined_all = [" ".join(c) for c in fake_exec.calls]
    # Heal ran as the admin superuser and re-granted, then the query retried.
    assert any(
        "CREATE ROLE" in j and "-U admin" in j and '"ro_bp_my_bp"' in j
        for j in joined_all
    )
    assert any(
        "ALTER DEFAULT PRIVILEGES FOR ROLE" in j and '"u_bp_my_bp"' in j
        for j in joined_all
    )
    assert sum("CREATE ROLE" in j for j in joined_all) == 1


async def test_self_heal_gives_up_after_one_retry(
    registered, services_up, fake_exec, gitops_home
):
    (gitops_home / "secrets" / "postgres-dev").write_text("POSTGRES_USER=admin\n")
    fake_exec.handlers.append(
        (
            lambda argv: "ro_bp_my_bp" in argv,
            ("", 'psql: error: permission denied for table "orders"', 1),
        )
    )
    t = resolve_target("my-bp", "dev")
    with pytest.raises(RuntimeError):
        await data_explorer.list_tables(t)


# ---------------------------------------------------------------------------
# object storage explorer
# ---------------------------------------------------------------------------

RCLONE_LS = json.dumps(
    [
        {
            "Path": "report.pdf",
            "Name": "report.pdf",
            "Size": 123,
            "MimeType": "application/pdf",
            "ModTime": "2026-07-16T10:00:00.000000000Z",
            "IsDir": False,
        },
        {
            "Path": "sub",
            "Name": "sub",
            "Size": 0,
            "MimeType": "inode/directory",
            "ModTime": "2000-01-01T00:00:00.000000000Z",
            "IsDir": True,
        },
    ]
)


def _write_garage_secrets(gitops_home, realm="dev"):
    d = gitops_home / "secrets"
    d.mkdir(exist_ok=True)
    (d / f"garage-{realm}").write_text(
        "GARAGE_ADMIN_TOKEN=tok\nS3_HOST=ws-test-garage-dev\nS3_PORT=9000\n"
    )


def _write_scoped_creds(gitops_home, realm="dev", bucket="bp-my-bp"):
    _write_garage_secrets(gitops_home, realm)
    d = gitops_home / "secrets" / "garagecreds" / realm
    d.mkdir(parents=True, exist_ok=True)
    (d / bucket).write_text("S3_ACCESS_KEY=GKscoped\nS3_SECRET_KEY=sk\n")


def _rclone_calls(calls):
    return [c for c in calls if "rclone" in c]


async def test_list_objects_parses_and_sorts(
    registered, services_up, fake_exec, gitops_home
):
    _write_scoped_creds(gitops_home)
    fake_exec.handlers.append(
        (lambda argv: "lsjson" in argv, (RCLONE_LS, "", 0))
    )
    t = resolve_target("my-bp", "dev")
    out = await data_explorer.list_objects(t, "")
    assert out["bucket"] == "bp-my-bp"
    # Folders first, trailing slash appended, dir size/mtime suppressed.
    assert [(e["type"], e["key"], e["size"]) for e in out["entries"]] == [
        ("folder", "sub/", None),
        ("file", "report.pdf", 123),
    ]
    # Exec went to the TOOLBOX with the scoped key as rclone flags.
    (call,) = _rclone_calls(fake_exec.calls)
    assert call[2] == "ws-test__garage-dev-toolbox"
    assert "GKscoped" in call
    assert "http://ws-test-garage-dev:9000" in call
    assert ":s3:bp-my-bp/" in call


async def test_list_objects_system_key_fallback(
    registered, services_up, fake_exec, gitops_home
):
    # No scoped creds file — the realm _system key carries the request.
    _write_garage_secrets(gitops_home)
    d = gitops_home / "secrets" / "garagecreds" / "dev"
    d.mkdir(parents=True, exist_ok=True)
    (d / "_system").write_text("S3_ACCESS_KEY=GKsystem\nS3_SECRET_KEY=ssk\n")
    fake_exec.handlers.append((lambda argv: "lsjson" in argv, ("[]", "", 0)))
    t = resolve_target("my-bp", "dev")
    out = await data_explorer.list_objects(t, "")
    assert out["entries"] == []
    (call,) = _rclone_calls(fake_exec.calls)
    assert "GKsystem" in call
    # Neither key provisioned -> 404-shaped error, not a crash.
    (d / "_system").unlink()
    with pytest.raises(LookupError):
        await data_explorer.list_objects(t, "")


async def test_list_objects_missing_prefix_is_empty(
    registered, services_up, fake_exec, gitops_home
):
    _write_scoped_creds(gitops_home)
    fake_exec.handlers.append(
        (
            lambda argv: "lsjson" in argv,
            ("", "ERROR : : error listing: directory not found", 3),
        )
    )
    t = resolve_target("my-bp", "dev")
    out = await data_explorer.list_objects(t, "gone/")
    assert out["entries"] == []
    # But a missing BUCKET (prefix="") is a 404-shaped error.
    with pytest.raises(LookupError):
        await data_explorer.list_objects(t, "")


async def test_list_objects_malformed_json(
    registered, services_up, fake_exec, gitops_home
):
    _write_scoped_creds(gitops_home)
    fake_exec.handlers.append(
        (lambda argv: "lsjson" in argv, ("{not json", "", 0))
    )
    t = resolve_target("my-bp", "dev")
    with pytest.raises(RuntimeError):
        await data_explorer.list_objects(t, "")


async def test_rclone_connection_refused_is_503(
    registered, services_up, fake_exec, gitops_home
):
    _write_scoped_creds(gitops_home)
    fake_exec.handlers.append(
        (
            lambda argv: "lsjson" in argv,
            ("", "Failed to lsjson: connection refused", 1),
        )
    )
    t = resolve_target("my-bp", "dev")
    with pytest.raises(data_explorer.ExplorerUnavailableError):
        await data_explorer.list_objects(t, "")


@pytest.mark.parametrize(
    "bad_prefix", ["/abs/", "a/../b/", "no-trailing-slash", "x" * 1025 + "/"]
)
async def test_object_prefix_validation(
    registered, services_up, fake_exec, gitops_home, bad_prefix
):
    _write_scoped_creds(gitops_home)
    t = resolve_target("my-bp", "dev")
    with pytest.raises(ValueError):
        await data_explorer.list_objects(t, bad_prefix)
    with pytest.raises(ValueError):
        await data_explorer.stat_object(t, "trailing/")


async def test_preview_size_gate_skips_copy(
    registered, services_up, fake_exec, gitops_home
):
    _write_scoped_creds(gitops_home)
    big_stat = json.dumps(
        {
            "Path": "big.mp4",
            "Name": "big.mp4",
            "Size": 10_000_000,
            "MimeType": "video/mp4",
            "ModTime": "2026-07-16T10:00:00Z",
            "IsDir": False,
        }
    )
    fake_exec.handlers.append((lambda argv: "--stat" in argv, (big_stat, "", 0)))
    t = resolve_target("my-bp", "dev")
    out = await data_explorer.preview_object(t, "big.mp4")
    assert out["truncated"] is True
    assert "content_base64" not in out
    assert out["content_type"] == "video/mp4"
    # No copyto / copy-out happened.
    assert not any("copyto" in c for c in fake_exec.calls)


async def test_preview_and_download_roundtrip(
    registered, services_up, fake_exec, gitops_home, monkeypatch, tmp_path
):
    _write_scoped_creds(gitops_home)
    small_stat = json.dumps(
        {
            "Path": "notes.txt",
            "Name": "notes.txt",
            "Size": 5,
            "MimeType": "text/plain; charset=utf-8",
            "ModTime": "2026-07-16T10:00:00Z",
            "IsDir": False,
        }
    )
    fake_exec.handlers.append((lambda argv: "--stat" in argv, (small_stat, "", 0)))

    import io
    import tarfile as tarfile_mod

    async def fake_to_file(args, out_path, gzip_output=False):
        # Emit a one-member TAR like the driver's copy-out — and prove the cp
        # ref targets the TOOLBOX container.
        assert args[:2] == ["docker", "cp"] and args[-1] == "-"
        assert args[2].startswith("ws-test__garage-dev-toolbox:")
        buf = io.BytesIO()
        with tarfile_mod.open(fileobj=buf, mode="w") as tf:
            data = b"hello"
            info = tarfile_mod.TarInfo(name="obj")
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
        with open(out_path, "wb") as f:
            f.write(buf.getvalue())
        return "", 0

    monkeypatch.setattr(
        "app.services.snapshot_service.run_docker_command_to_file", fake_to_file
    )
    t = resolve_target("my-bp", "dev")
    out = await data_explorer.preview_object(t, "notes.txt")
    assert out["truncated"] is False
    assert base64.b64decode(out["content_base64"]) == b"hello"
    # In-container scratch dir was cleaned up (in the toolbox).
    assert any(
        "rm" in c and "-rf" in c and any(a.startswith("/tmp/bpexp-") for a in c)
        for c in fake_exec.calls
    )

    tmpdir, path, stat = await data_explorer.download_object(t, "notes.txt")
    try:
        with open(path, "rb") as f:
            assert f.read() == b"hello"
        assert stat["content_type"] == "text/plain; charset=utf-8"
    finally:
        import shutil

        shutil.rmtree(tmpdir, ignore_errors=True)


async def test_download_size_gate(registered, services_up, fake_exec, gitops_home):
    _write_scoped_creds(gitops_home)
    huge = json.dumps(
        {
            "Name": "huge.bin",
            "Size": data_explorer.DOWNLOAD_MAX_BYTES + 1,
            "IsDir": False,
        }
    )
    fake_exec.handlers.append((lambda argv: "--stat" in argv, (huge, "", 0)))
    t = resolve_target("my-bp", "dev")
    with pytest.raises(ValueError):
        await data_explorer.download_object(t, "huge.bin")


# ---------------------------------------------------------------------------
# teardown role cleanup (bp_databases._drop_postgres_db)
# ---------------------------------------------------------------------------


async def test_drop_postgres_db_drops_scoped_roles(monkeypatch):
    calls = []

    async def fake_run(*args, cwd=None):
        calls.append(list(args))
        return "", "", 0

    monkeypatch.setattr(bp_databases, "_driver_exec", fake_run)
    await bp_databases._drop_postgres_db("c", "admin", "bp_my_bp")
    joined = [" ".join(c) for c in calls]
    assert any('DROP DATABASE IF EXISTS "bp_my_bp";' in j for j in joined)
    assert any('DROP ROLE IF EXISTS "u_bp_my_bp";' in j for j in joined)
    assert any('DROP ROLE IF EXISTS "ro_bp_my_bp";' in j for j in joined)
    # Role drops come AFTER the database drop.
    db_i = next(i for i, j in enumerate(joined) if "DROP DATABASE" in j)
    role_i = [i for i, j in enumerate(joined) if "DROP ROLE" in j]
    assert all(i > db_i for i in role_i)


async def test_drop_postgres_db_role_failure_is_nonfatal(monkeypatch):
    async def fake_run(*args, cwd=None):
        if "DROP ROLE" in " ".join(args):
            return "", "role busy", 1
        return "", "", 0

    monkeypatch.setattr(bp_databases, "_driver_exec", fake_run)
    # Must not raise — role cleanup is best-effort.
    await bp_databases._drop_postgres_db("c", "admin", "bp_my_bp")
