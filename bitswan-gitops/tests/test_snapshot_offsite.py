"""Off-site tier for per-BP snapshots (app/services/snapshot_offsite.py):
push tagging + index lifecycle, list merging, fetch, retention, and the
fetch route. restic is faked at backup_service._run_restic; a real-restic
E2E lives at the bottom (skipped without the binary)."""

import json
import os
import shutil

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.services import backup_service, snapshot_offsite

AOC_URL = "https://aoc.example.com"
TOKEN = "test-aoc-token"
WORKSPACE_ID = "11111111-2222-3333-4444-555555555555"

BP = "my-bp"
STAGE = "dev"
SNAP_ID = "20260710-120000-ab12cd34"


def _manifest(snapshot_id=SNAP_ID, stage=STAGE, **extra):
    return {
        "version": 1,
        "id": snapshot_id,
        "bp": BP,
        "bp_name": "My BP",
        "stage": stage,
        "label": "golden",
        "kind": "manual",
        "created_at": "2026-07-10T12:00:00+00:00",
        "workspace": "ws-test",
        "services": {},
        "total_size_bytes": 42,
        **extra,
    }


@pytest.fixture
def offsite_env(monkeypatch, tmp_path):
    """AOC-connected, backup-configured environment with a local snapshot."""
    monkeypatch.setenv("BITSWAN_AOC_URL", AOC_URL)
    monkeypatch.setenv("BITSWAN_AOC_TOKEN", TOKEN)
    monkeypatch.setenv("BITSWAN_WORKSPACE_ID", WORKSPACE_ID)
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))
    monkeypatch.setenv("BITSWAN_WORKSPACE_NAME", "ws-test")
    backup_service.save_backup_config({"enabled": True, "retention": {}})
    backup_service.generate_restic_key()
    # reset the module singleton so snapshots_root picks up tmp_path
    import app.services.snapshot_service as snap_mod

    monkeypatch.setattr(snap_mod, "_snapshot_service", None)
    return tmp_path


@pytest.fixture
def local_snapshot(offsite_env):
    snap_dir = offsite_env / "snapshots" / BP / STAGE / SNAP_ID
    snap_dir.mkdir(parents=True)
    (snap_dir / "manifest.json").write_text(json.dumps(_manifest()))
    (snap_dir / "postgres.sql").write_bytes(b"-- sql\n")
    return snap_dir


@pytest.fixture
def restic_calls(monkeypatch):
    """Fake _run_restic recording args; behavior configurable per test."""
    calls = []
    responses = {
        "backup": ('{"message_type":"summary","snapshot_id":"abcdef1234567890"}', "", 0)
    }

    async def fake_run_restic(args, config, timeout=3600):
        calls.append(list(args))
        return responses.get(args[0], ("", "", 0))

    monkeypatch.setattr(backup_service, "_run_restic", fake_run_restic)
    fake_run_restic.responses = responses
    return calls


# -- push -----------------------------------------------------------------------


async def test_push_tags_and_index(offsite_env, local_snapshot, restic_calls):
    await snapshot_offsite.push_snapshot(BP, STAGE, SNAP_ID, _manifest())

    (backup_call,) = restic_calls
    assert backup_call[0] == "backup"
    assert str(local_snapshot) in backup_call
    joined = " ".join(backup_call)
    assert "--tag bp-snapshot" in joined
    assert f"--tag bp:{BP}" in joined
    assert f"--tag stage:{STAGE}" in joined
    assert f"--tag id:{SNAP_ID}" in joined

    entry = snapshot_offsite.offsite_status_for(BP)[SNAP_ID]
    assert entry["status"] == "synced"
    assert entry["restic_id"] == "abcdef12"
    assert entry["manifest"]["id"] == SNAP_ID
    assert entry["stage"] == STAGE


async def test_push_failure_marks_failed_and_never_raises(
    offsite_env, local_snapshot, monkeypatch
):
    async def failing(args, config, timeout=3600):
        return "", "repo locked", 1

    monkeypatch.setattr(backup_service, "_run_restic", failing)
    await snapshot_offsite.push_snapshot(BP, STAGE, SNAP_ID, _manifest())

    entry = snapshot_offsite.offsite_status_for(BP)[SNAP_ID]
    assert entry["status"] == "failed"
    assert "repo locked" in entry["error"]


async def test_push_noop_without_aoc(monkeypatch, tmp_path, restic_calls):
    monkeypatch.delenv("BITSWAN_AOC_URL", raising=False)
    monkeypatch.delenv("BITSWAN_AOC_TOKEN", raising=False)
    monkeypatch.delenv("BITSWAN_WORKSPACE_ID", raising=False)
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))

    snapshot_offsite.spawn_push(BP, STAGE, SNAP_ID, _manifest())
    await snapshot_offsite.push_snapshot(BP, STAGE, SNAP_ID, _manifest())
    assert restic_calls == []
    assert snapshot_offsite.offsite_status_for(BP) == {}


async def test_push_crash_is_contained(offsite_env, local_snapshot, monkeypatch):
    async def exploding(args, config, timeout=3600):
        raise OSError("boom")

    monkeypatch.setattr(backup_service, "_run_restic", exploding)
    # must not raise
    await snapshot_offsite.push_snapshot(BP, STAGE, SNAP_ID, _manifest())
    assert snapshot_offsite.offsite_status_for(BP)[SNAP_ID]["status"] == "pending"


def test_corrupt_index_treated_as_empty(offsite_env):
    path = snapshot_offsite._index_path(BP)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write("{not json")
    assert snapshot_offsite.offsite_status_for(BP) == {}


# -- list merge (route) -----------------------------------------------------------


def _snapshots_client():
    from app.routes import snapshots as routes_mod

    app = FastAPI()
    app.include_router(routes_mod.router)
    return TestClient(app)


async def test_list_merges_offsite_state(offsite_env, local_snapshot, restic_calls):
    # one local+synced, one off-site-only, one failed entry (hidden)
    await snapshot_offsite.push_snapshot(BP, STAGE, SNAP_ID, _manifest())
    gone_id = "20260709-110000-cd34ef56"
    await snapshot_offsite._update_entry(
        BP,
        gone_id,
        {
            "status": "synced",
            "stage": STAGE,
            "restic_id": "12345678",
            "pushed_at": "2026-07-09T11:01:00+00:00",
            "error": None,
            "manifest": _manifest(gone_id, created_at="2026-07-09T11:00:00+00:00"),
        },
    )
    await snapshot_offsite._update_entry(
        BP,
        "20260708-100000-ef56ab78",
        {
            "status": "failed",
            "stage": STAGE,
            "restic_id": None,
            "pushed_at": None,
            "error": "x",
            "manifest": {},
        },
    )

    body = _snapshots_client().get(f"/snapshots/{BP}").json()
    assert body["offsite_enabled"] is True
    rows = {s["id"]: s for s in body["snapshots"]}
    assert rows[SNAP_ID]["local"] is True
    assert rows[SNAP_ID]["offsite"] == "synced"
    assert rows[gone_id]["local"] is False
    assert rows[gone_id]["offsite"] == "synced"
    assert "20260708-100000-ef56ab78" not in rows  # failed + not local → hidden
    # newest first
    ids = [s["id"] for s in body["snapshots"]]
    assert ids.index(SNAP_ID) < ids.index(gone_id)


async def test_list_without_aoc_is_plain_local(monkeypatch, tmp_path):
    monkeypatch.delenv("BITSWAN_AOC_URL", raising=False)
    monkeypatch.delenv("BITSWAN_AOC_TOKEN", raising=False)
    monkeypatch.delenv("BITSWAN_WORKSPACE_ID", raising=False)
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))
    import app.services.snapshot_service as snap_mod

    monkeypatch.setattr(snap_mod, "_snapshot_service", None)

    snap_dir = tmp_path / "snapshots" / BP / STAGE / SNAP_ID
    snap_dir.mkdir(parents=True)
    (snap_dir / "manifest.json").write_text(json.dumps(_manifest()))

    body = _snapshots_client().get(f"/snapshots/{BP}").json()
    assert body["offsite_enabled"] is False
    (row,) = body["snapshots"]
    assert row["local"] is True and row["offsite"] == "none"


# -- fetch ------------------------------------------------------------------------


async def test_fetch_is_idempotent_when_local(
    offsite_env, local_snapshot, restic_calls
):
    manifest = await snapshot_offsite.fetch_snapshot(BP, STAGE, SNAP_ID)
    assert manifest["id"] == SNAP_ID
    assert restic_calls == []  # no restic needed


async def test_fetch_restores_and_renames(offsite_env, monkeypatch):
    # index says synced, no local files
    await snapshot_offsite._update_entry(
        BP,
        SNAP_ID,
        {
            "status": "synced",
            "stage": STAGE,
            "restic_id": "abcdef12",
            "pushed_at": "x",
            "error": None,
            "manifest": _manifest(),
        },
    )

    async def fake_run_restic(args, config, timeout=3600):
        if args[0] == "restore":
            target = args[args.index("--target") + 1]
            # restic recreates the ORIGINAL absolute path (from a different
            # BITSWAN_GITOPS_DIR) inside the target
            orig = os.path.join(
                target, "old-server-root", "snapshots", BP, STAGE, SNAP_ID
            )
            os.makedirs(orig)
            with open(os.path.join(orig, "manifest.json"), "w") as f:
                json.dump(_manifest(), f)
            with open(os.path.join(orig, "postgres.sql"), "wb") as f:
                f.write(b"-- from offsite\n")
            return "", "", 0
        return "", "", 0

    monkeypatch.setattr(backup_service, "_run_restic", fake_run_restic)

    steps = []

    async def progress(step, message):
        steps.append(step)

    manifest = await snapshot_offsite.fetch_snapshot(
        BP, STAGE, SNAP_ID, progress=progress
    )

    assert manifest["id"] == SNAP_ID
    assert steps == ["fetch_offsite"]
    final = os.path.join(str(offsite_env), "snapshots", BP, STAGE, SNAP_ID)
    with open(os.path.join(final, "postgres.sql"), "rb") as f:
        assert f.read() == b"-- from offsite\n"
    # no scratch dirs left behind
    stage_dir = os.path.dirname(final)
    assert [d for d in os.listdir(stage_dir) if d.startswith(".fetch-")] == []


async def test_fetch_rejects_wrong_manifest_id(offsite_env, monkeypatch):
    await snapshot_offsite._update_entry(
        BP,
        SNAP_ID,
        {
            "status": "synced",
            "stage": STAGE,
            "restic_id": "abcdef12",
            "pushed_at": "x",
            "error": None,
            "manifest": _manifest(),
        },
    )

    async def fake_run_restic(args, config, timeout=3600):
        if args[0] == "restore":
            target = args[args.index("--target") + 1]
            orig = os.path.join(target, "snapshots", BP, STAGE, SNAP_ID)
            os.makedirs(orig)
            with open(os.path.join(orig, "manifest.json"), "w") as f:
                json.dump(_manifest("20200101-000000-deadbeef"), f)
            return "", "", 0
        return "", "", 0

    monkeypatch.setattr(backup_service, "_run_restic", fake_run_restic)
    with pytest.raises(RuntimeError, match="no matching manifest"):
        await snapshot_offsite.fetch_snapshot(BP, STAGE, SNAP_ID)


async def test_fetch_unknown_raises_lookup(offsite_env, restic_calls):
    restic_calls  # unknown id, empty index, rebuild finds nothing
    with pytest.raises(LookupError):
        await snapshot_offsite.fetch_snapshot(BP, STAGE, "20200101-000000-deadbeef")


# -- retention ---------------------------------------------------------------------


async def test_retention_per_bp_args_and_reconcile(
    offsite_env, local_snapshot, monkeypatch
):
    await snapshot_offsite._update_entry(
        BP,
        SNAP_ID,
        {
            "status": "synced",
            "stage": STAGE,
            "restic_id": "abcdef12",
            "pushed_at": "x",
            "error": None,
            "manifest": _manifest(),
        },
    )
    # a second entry that retention will have pruned remotely
    pruned_id = "20260601-100000-aa11bb22"
    await snapshot_offsite._update_entry(
        BP,
        pruned_id,
        {
            "status": "synced",
            "stage": STAGE,
            "restic_id": "99999999",
            "pushed_at": "x",
            "error": None,
            "manifest": _manifest(pruned_id),
        },
    )

    calls = []

    async def fake_run_restic(args, config, timeout=3600):
        calls.append(list(args))
        if args[0] == "snapshots":
            # after forget, only SNAP_ID remains remotely
            return (
                json.dumps(
                    [
                        {
                            "short_id": "abcdef12",
                            "time": "t",
                            "tags": [
                                "bp-snapshot",
                                f"bp:{BP}",
                                f"stage:{STAGE}",
                                f"id:{SNAP_ID}",
                            ],
                            "paths": ["/x"],
                        },
                    ]
                ),
                "",
                0,
            )
        return "", "", 0

    monkeypatch.setattr(backup_service, "_run_restic", fake_run_restic)

    class FakeAutomation:
        def read_backups(self, bp):
            return {"retention": {"daily": 7, "weekly": 0, "monthly": 3}}

    import app.dependencies as deps

    monkeypatch.setattr(deps, "get_automation_service", lambda: FakeAutomation())

    await snapshot_offsite.apply_offsite_retention()

    forget = next(c for c in calls if c[0] == "forget")
    joined = " ".join(forget)
    assert f"--tag bp-snapshot,bp:{BP}" in joined
    assert "--group-by host" in joined
    assert "--keep-daily 7" in joined
    assert "--keep-monthly 3" in joined
    assert "--keep-weekly" not in joined  # weekly=0 omitted
    assert [c for c in calls if c[0] == "prune"] != []  # single trailing prune
    assert len([c for c in calls if c[0] == "prune"]) == 1

    entries = snapshot_offsite.offsite_status_for(BP)
    assert SNAP_ID in entries
    assert pruned_id not in entries  # reconciled away


async def test_retention_skips_all_zero_policy(
    offsite_env, local_snapshot, monkeypatch
):
    await snapshot_offsite._update_entry(
        BP,
        SNAP_ID,
        {
            "status": "synced",
            "stage": STAGE,
            "restic_id": "a",
            "pushed_at": "x",
            "error": None,
            "manifest": _manifest(),
        },
    )
    calls = []

    async def fake_run_restic(args, config, timeout=3600):
        calls.append(list(args))
        return "[]", "", 0

    monkeypatch.setattr(backup_service, "_run_restic", fake_run_restic)

    class FakeAutomation:
        def read_backups(self, bp):
            return {"retention": {"daily": 0, "weekly": 0, "monthly": 0}}

    import app.dependencies as deps

    monkeypatch.setattr(deps, "get_automation_service", lambda: FakeAutomation())

    await snapshot_offsite.apply_offsite_retention()
    assert [c for c in calls if c[0] == "forget"] == []
    assert [c for c in calls if c[0] == "prune"] == []


async def test_whole_server_retention_is_tag_scoped(offsite_env, monkeypatch):
    calls = []

    async def fake_run_restic(args, config, timeout=3600):
        calls.append(list(args))
        return "", "", 0

    monkeypatch.setattr(backup_service, "_run_restic", fake_run_restic)
    await backup_service._apply_retention({"retention": {"daily": 30, "monthly": 12}})
    (forget,) = calls
    joined = " ".join(forget)
    for tag in ("workspace", "postgres", "couchdb", "minio"):
        assert f"--tag {tag}" in joined
    assert "bp-snapshot" not in joined


# -- fetch route -------------------------------------------------------------------


async def test_fetch_route_states(offsite_env, local_snapshot):
    client = _snapshots_client()

    # already local → 200
    r = client.post(f"/snapshots/{BP}/{STAGE}/{SNAP_ID}/fetch")
    assert r.status_code == 200
    assert r.json()["status"] == "already_local"

    # unknown off-site → 404
    r = client.post(f"/snapshots/{BP}/{STAGE}/20200101-000000-deadbeef/fetch")
    assert r.status_code == 404


async def test_fetch_route_400_without_aoc(monkeypatch, tmp_path):
    monkeypatch.delenv("BITSWAN_AOC_URL", raising=False)
    monkeypatch.delenv("BITSWAN_AOC_TOKEN", raising=False)
    monkeypatch.delenv("BITSWAN_WORKSPACE_ID", raising=False)
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))
    r = _snapshots_client().post(f"/snapshots/{BP}/{STAGE}/{SNAP_ID}/fetch")
    assert r.status_code == 400


async def test_delete_reports_offsite_retained(offsite_env, local_snapshot):
    await snapshot_offsite._update_entry(
        BP,
        SNAP_ID,
        {
            "status": "synced",
            "stage": STAGE,
            "restic_id": "a",
            "pushed_at": "x",
            "error": None,
            "manifest": _manifest(),
        },
    )
    r = _snapshots_client().delete(f"/snapshots/{BP}/{STAGE}/{SNAP_ID}")
    assert r.status_code == 200
    assert r.json()["offsite_retained"] is True
    # local files gone, off-site entry still listed
    assert not os.path.isdir(str(local_snapshot))
    assert snapshot_offsite.offsite_status_for(BP)[SNAP_ID]["status"] == "synced"


# -- E2E with real restic (local filesystem repo) ------------------------------------


@pytest.mark.skipif(
    shutil.which("restic") is None, reason="restic binary not installed"
)
async def test_e2e_real_restic_roundtrip(offsite_env, monkeypatch, tmp_path):
    repo = tmp_path / "restic-repo"

    def fake_env(config):
        env = os.environ.copy()
        env["RESTIC_REPOSITORY"] = str(repo)
        env["RESTIC_PASSWORD"] = "test"
        return env

    monkeypatch.setattr(backup_service, "_restic_env", fake_env)
    _, _, rc = await backup_service._run_restic(["init"], {})
    assert rc == 0

    # two snapshots
    other_id = "20260709-110000-cd34ef56"
    for sid in (SNAP_ID, other_id):
        d = offsite_env / "snapshots" / BP / STAGE / sid
        d.mkdir(parents=True, exist_ok=True)
        (d / "manifest.json").write_text(json.dumps(_manifest(sid)))
        (d / "postgres.sql").write_bytes(f"-- sql {sid}\n".encode())
        await snapshot_offsite.push_snapshot(BP, STAGE, sid, _manifest(sid))

    entries = snapshot_offsite.offsite_status_for(BP)
    assert entries[SNAP_ID]["status"] == "synced"
    assert entries[other_id]["status"] == "synced"

    # real tags visible
    stdout, _, rc = await backup_service._run_restic(
        ["snapshots", "--json", "--tag", f"bp-snapshot,bp:{BP}"], {}
    )
    assert rc == 0
    assert len(json.loads(stdout)) == 2

    # delete locally, fetch back, byte-compare
    shutil.rmtree(offsite_env / "snapshots" / BP / STAGE / SNAP_ID)
    manifest = await snapshot_offsite.fetch_snapshot(BP, STAGE, SNAP_ID)
    assert manifest["id"] == SNAP_ID
    restored = offsite_env / "snapshots" / BP / STAGE / SNAP_ID / "postgres.sql"
    assert restored.read_bytes() == f"-- sql {SNAP_ID}\n".encode()

    # rebuild_index from a wiped index
    os.remove(snapshot_offsite._index_path(BP))
    rebuilt = await snapshot_offsite.rebuild_index(BP)
    assert set(rebuilt["entries"]) == {SNAP_ID, other_id}
    assert rebuilt["entries"][other_id]["manifest"]["id"] == other_id
