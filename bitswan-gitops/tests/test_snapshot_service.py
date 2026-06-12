"""
Unit tests for the per-BP snapshot engine (app/services/snapshot_service.py).

Docker is faked at the module boundary (run_docker_command* helpers); the
snapshot store lives in a tmp_path.
"""

import gzip
import json
import os
import tarfile

import pytest

from app.services import snapshot_service as snap_mod
from app.services.bp_databases import (
    load_registry,
    register_bp_stage,
    save_registry,
)
from app.services.snapshot_service import (
    SnapshotService,
    new_snapshot_id,
    validate_snapshot_id,
)


@pytest.fixture
def gitops_home(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))
    monkeypatch.setenv("BITSWAN_WORKSPACE_NAME", "ws-test")
    secrets = tmp_path / "secrets"
    secrets.mkdir()
    for stage in ("dev", "staging", ""):
        suffix = f"-{stage}" if stage else ""
        (secrets / f"postgres{suffix}").write_text(
            "POSTGRES_USER=admin\nPOSTGRES_PASSWORD=pw\nPOSTGRES_HOST=h\nPOSTGRES_DB=postgres\n"
        )
        (secrets / f"couchdb{suffix}").write_text(
            "COUCHDB_USER=admin\nCOUCHDB_PASSWORD=pw\n"
        )
        (secrets / f"minio{suffix}").write_text(
            "MINIO_ROOT_USER=admin\nMINIO_ROOT_PASSWORD=pw\n"
        )
    reg = load_registry()
    register_bp_stage(reg, "my-bp", "My BP", "dev")
    register_bp_stage(reg, "my-bp", "My BP", "staging")
    save_registry(reg)
    return tmp_path


class FakeInfraService:
    def __init__(self, container_name):
        self.container_name = container_name

    def is_enabled(self):
        return True

    async def is_running(self):
        return True


@pytest.fixture
def service(gitops_home, monkeypatch):
    def fake_get_service(svc_type, workspace, stage="production", **kw):
        suffix = "" if stage == "production" else f"-{stage}"
        return FakeInfraService(f"{workspace}__{svc_type}{suffix}")

    monkeypatch.setattr(snap_mod, "get_service", fake_get_service)
    monkeypatch.setattr("app.services.infra_service.get_service", fake_get_service)
    return SnapshotService("ws-test")


@pytest.fixture
def fake_docker(monkeypatch):
    """Fake all three docker helpers with a tiny in-memory 'cluster'.

    State: per-stage postgres dump content, couch dbs, minio tar bytes —
    enough to verify dump→clear→load plumbing end to end.
    """
    state = {
        "calls": [],
        "pg_dump": {"dev": b"-- sql dump dev\n", "staging": b"-- sql staging\n"},
        "pg_loaded": {},  # stage -> bytes piped into psql
        "pg_dropped": [],
        "couch_dbs": {
            "dev": ["bp-my-bp-orders", "bp-my-bp-users", "unrelated-db"],
            "staging": ["bp-my-bp-old"],
        },
        "couch_docs": {
            "bp-my-bp-orders": {
                "rows": [{"doc": {"_id": "o1", "_rev": "1-x", "v": 1}}]
            },
            "bp-my-bp-users": {"rows": []},
        },
        "couch_created": [],
        "couch_deleted": [],
        "couch_bulk": {},
        "minio_tar": {},  # stage -> tar bytes piped in on restore
    }

    def _stage_of(args_or_container) -> str:
        # ws-test__postgres-dev → dev; no suffix → production. Accepts either
        # the container name or the full args (skipping flags like `-i`).
        if isinstance(args_or_container, list):
            container = next(a for a in args_or_container if "__" in a)
        else:
            container = args_or_container
        # `docker cp` fuses the container with a path (container:/tmp/...);
        # drop the path before deriving the stage suffix.
        container = container.split(":", 1)[0]
        tail = container.split("__", 1)[1]
        parts = tail.split("-", 1)
        return parts[1] if len(parts) > 1 else "production"

    async def fake_run(*args):
        args = list(args)
        state["calls"].append(args)
        joined = " ".join(args)
        stage = _stage_of(args)
        if "psql" in args:
            sql = args[-1]
            if "DROP DATABASE" in sql:
                state["pg_dropped"].append((stage, sql))
            return "", "", 0
        if "/_all_dbs" in joined:
            return json.dumps(state["couch_dbs"].get(stage, [])), "", 0
        if "-X" in args and "DELETE" in args:
            db = args[-1].rsplit("/", 1)[-1]
            state["couch_deleted"].append((stage, db))
            state["couch_dbs"][stage] = [
                d for d in state["couch_dbs"].get(stage, []) if d != db
            ]
            return "{}", "", 0
        if "-X" in args and "PUT" in args:
            db = args[-1].rsplit("/", 1)[-1]
            state["couch_created"].append((stage, db))
            state["couch_dbs"].setdefault(stage, []).append(db)
            return "{}", "", 0
        if "mc" in joined or "alias" in joined:
            return "", "", 0
        if args[-2:] == ["rm", "-rf"] or "rm" in args:
            return "", "", 0
        return "", "", 0

    async def fake_to_file(args, out_path, gzip_output=False):
        state["calls"].append(list(args))
        joined = " ".join(args)
        stage = _stage_of(args)
        if "pg_dump" in joined:
            data = state["pg_dump"].get(stage, b"")
        elif "_all_docs" in joined:
            # extract db name from URL .../{db}/_all_docs?...
            url = args[-1]
            db = url.split("5984/", 1)[1].split("/_all_docs", 1)[0]
            data = json.dumps(state["couch_docs"].get(db, {"rows": []})).encode()
        elif args[:2] == ["docker", "cp"]:
            # minio dump: `docker cp container:scratch -` emits a plain tar;
            # the helper gzips it (gzip_output=True), so produce uncompressed.
            import io

            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w") as tar:
                ti = tarfile.TarInfo("obj.txt")
                content = f"minio-{stage}".encode()
                ti.size = len(content)
                tar.addfile(ti, io.BytesIO(content))
            data = buf.getvalue()
        else:
            data = b""
        opener = gzip.open if gzip_output else open
        with opener(out_path, "wb") as f:
            f.write(data)
        return "", 0

    async def fake_from_file(args, in_path, gunzip_input=False):
        state["calls"].append(list(args))
        joined = " ".join(args)
        stage = _stage_of(args)
        opener = gzip.open if gunzip_input else open
        with opener(in_path, "rb") as f:
            data = f.read()
        if "psql" in joined:
            state["pg_loaded"][stage] = data
        elif "_bulk_docs" in joined:
            db = joined.split("5984/", 1)[1].split("/_bulk_docs", 1)[0]
            state["couch_bulk"][(stage, db)] = json.loads(data)
        elif args[:2] == ["docker", "cp"]:
            # minio restore: `docker cp - container:/tmp` (gunzip_input=True).
            state["minio_tar"][stage] = data
        return "", "", 0

    monkeypatch.setattr(snap_mod, "run_docker_command", fake_run)
    monkeypatch.setattr(snap_mod, "run_docker_command_to_file", fake_to_file)
    monkeypatch.setattr(snap_mod, "run_docker_command_from_file", fake_from_file)
    # restore_snapshot provisions the target via bp_databases — keep that
    # off real docker too.
    from app.services import bp_databases

    async def fake_bp_run(*args, cwd=None):
        state["calls"].append(list(args))
        return "", "", 0

    monkeypatch.setattr(bp_databases, "run_docker_command", fake_bp_run)
    return state


# ---------------------------------------------------------------------------
# ids
# ---------------------------------------------------------------------------


def test_snapshot_id_roundtrip():
    sid = new_snapshot_id()
    validate_snapshot_id(sid)


@pytest.mark.parametrize(
    "bad",
    ["", "..", "x/y", "20250101-000000-zzzzzzzz", "20250101-000000-abc", "a" * 40],
)
def test_snapshot_id_rejects(bad):
    with pytest.raises(ValueError):
        validate_snapshot_id(bad)


# ---------------------------------------------------------------------------
# create
# ---------------------------------------------------------------------------


async def test_create_snapshot_writes_manifest_and_files(service, fake_docker):
    steps = []

    async def progress(step, message):
        steps.append(step)

    manifest = await service.create_snapshot(
        "my-bp", "dev", label="before-release", progress=progress
    )

    assert manifest["bp"] == "my-bp"
    assert manifest["stage"] == "dev"
    assert manifest["kind"] == "manual"
    assert manifest["label"] == "before-release"
    for svc_type in ("postgres", "couchdb", "minio"):
        assert manifest["services"][svc_type]["included"] is True
    assert manifest["total_size_bytes"] > 0
    assert steps == ["snapshot_postgres", "snapshot_couchdb", "snapshot_minio"]

    snap_dir = service._snapshot_dir("my-bp", "dev", manifest["id"])
    assert os.path.isdir(snap_dir)
    for fname in ("manifest.json", "postgres.sql.gz", "couchdb.tar.gz", "minio.tar.gz"):
        assert os.path.exists(os.path.join(snap_dir, fname))

    # postgres dump content round-trips through gzip
    with gzip.open(os.path.join(snap_dir, "postgres.sql.gz")) as f:
        assert f.read() == b"-- sql dump dev\n"

    # couchdb archive only contains the prefixed dbs (not unrelated-db)
    with tarfile.open(os.path.join(snap_dir, "couchdb.tar.gz")) as tar:
        names = tar.getnames()
    assert "bp-my-bp-orders.json" in names
    assert "bp-my-bp-users.json" in names
    assert "unrelated-db.json" not in names


async def test_create_snapshot_fails_when_nothing_available(
    gitops_home, monkeypatch, fake_docker
):
    class Disabled(FakeInfraService):
        def is_enabled(self):
            return False

    monkeypatch.setattr(snap_mod, "get_service", lambda *a, **k: Disabled("c"))
    service = SnapshotService("ws-test")
    with pytest.raises(ValueError, match="No data services available"):
        await service.create_snapshot("my-bp", "dev")


async def test_create_rejects_bad_inputs(service, fake_docker):
    with pytest.raises(ValueError):
        await service.create_snapshot("my-bp", "live-dev")
    with pytest.raises(ValueError):
        await service.create_snapshot("../etc", "dev")
    with pytest.raises(ValueError):
        await service.create_snapshot("my-bp", "dev", kind="weird")


# ---------------------------------------------------------------------------
# list / delete / prune / disk usage
# ---------------------------------------------------------------------------


async def test_list_delete_and_disk_usage(service, fake_docker):
    m1 = await service.create_snapshot("my-bp", "dev", label="one")
    m2 = await service.create_snapshot("my-bp", "staging", label="two")

    listed = service.list_snapshots("my-bp")
    assert {m["id"] for m in listed} == {m1["id"], m2["id"]}
    assert service.disk_usage("my-bp") > 0

    service.delete_snapshot("my-bp", "dev", m1["id"])
    assert {m["id"] for m in service.list_snapshots("my-bp")} == {m2["id"]}
    with pytest.raises(LookupError):
        service.delete_snapshot("my-bp", "dev", m1["id"])


async def test_prune_keeps_manual_and_newest_autos(service, fake_docker):
    manual = await service.create_snapshot("my-bp", "dev", label="keep me")
    autos = []
    for _ in range(7):
        m = await service.create_snapshot("my-bp", "dev", kind="auto")
        autos.append(m["id"])

    deleted = service.prune_auto_snapshots("my-bp", "dev", keep=5)
    remaining = {m["id"] for m in service.list_snapshots("my-bp")}

    assert len(deleted) == 2
    assert manual["id"] in remaining  # manual snapshots are never pruned
    assert len([i for i in autos if i in remaining]) == 5


# ---------------------------------------------------------------------------
# restore
# ---------------------------------------------------------------------------


async def test_restore_validates_before_destruction(service, fake_docker, monkeypatch):
    manifest = await service.create_snapshot("my-bp", "dev")

    class Stopped(FakeInfraService):
        async def is_running(self):
            return False

    monkeypatch.setattr(snap_mod, "get_service", lambda *a, **k: Stopped("c"))
    fake_docker["calls"].clear()
    with pytest.raises(ValueError, match="unavailable"):
        await service.restore_snapshot("my-bp", manifest["id"], "dev", "staging")
    # Validation failed → not a single docker command ran.
    assert fake_docker["calls"] == []


async def test_restore_cross_stage_with_auto_snapshot(service, fake_docker):
    manifest = await service.create_snapshot("my-bp", "dev", label="golden")
    steps = []

    async def progress(step, message):
        steps.append(step)

    result = await service.restore_snapshot(
        "my-bp", manifest["id"], "dev", "staging", progress=progress
    )

    assert result["pre_restore_snapshot_id"] is not None
    assert steps[0] == "validating"
    assert "pre_restore_snapshot" in steps
    assert steps.index("restore_postgres") < steps.index("restore_couchdb")
    assert steps.index("restore_couchdb") < steps.index("restore_minio")

    # The auto-snapshot of staging exists, marked kind=auto with provenance.
    autos = [
        m
        for m in service.list_snapshots("my-bp")
        if m["kind"] == "auto" and m["stage"] == "staging"
    ]
    assert len(autos) == 1
    assert autos[0]["source"]["restored_snapshot_id"] == manifest["id"]

    # Postgres on staging was dropped and reloaded with the DEV dump.
    assert any("staging" == s for s, _ in fake_docker["pg_dropped"])
    assert fake_docker["pg_loaded"]["staging"] == b"-- sql dump dev\n"

    # Staging's stale prefixed couch DB was deleted; dev's were recreated.
    assert ("staging", "bp-my-bp-old") in fake_docker["couch_deleted"]
    assert ("staging", "bp-my-bp-orders") in fake_docker["couch_created"]
    # _rev was stripped before bulk insert.
    bulk = fake_docker["couch_bulk"][("staging", "bp-my-bp-orders")]
    assert bulk["docs"][0]["_id"] == "o1"
    assert "_rev" not in bulk["docs"][0]

    # MinIO tarball was streamed into staging.
    assert "staging" in fake_docker["minio_tar"]

    # Target stage got registered/provisioned in the registry by the restore.
    reg = load_registry()
    assert "staging" in reg["bps"]["my-bp"]["stages"]


async def test_restore_failure_names_pre_restore_snapshot(
    service, fake_docker, monkeypatch
):
    manifest = await service.create_snapshot("my-bp", "dev")

    async def exploding_from_file(args, in_path, gunzip_input=False):
        if "psql" in " ".join(args):
            return "", "disk full", 1
        return "", "", 0

    monkeypatch.setattr(snap_mod, "run_docker_command_from_file", exploding_from_file)
    with pytest.raises(RuntimeError) as exc:
        await service.restore_snapshot("my-bp", manifest["id"], "dev", "staging")
    msg = str(exc.value)
    assert "pre-restore state was saved as snapshot" in msg


async def test_restore_unknown_snapshot(service, fake_docker):
    with pytest.raises(LookupError):
        await service.restore_snapshot(
            "my-bp", "20200101-000000-deadbeef", "dev", "staging"
        )
