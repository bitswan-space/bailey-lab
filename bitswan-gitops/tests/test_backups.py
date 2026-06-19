"""Blue-green production backups model: live/standby slot pointer, retention
policy, the DR go-live swap (flip + audit), and the audit log — all versioned
in bitswan.yaml. Uses a real throwaway git repo so update_git commits."""

import asyncio
import subprocess

from app.utils import read_bitswan_yaml, dump_bitswan_yaml
from app.services import firewall_service as fws
from app.services.automation_service import AutomationService


def _git_svc(tmp_path, monkeypatch):
    monkeypatch.setattr(fws, "firewall_dir", lambda: str(tmp_path / "fw"))
    monkeypatch.delenv("HOST_PATH", raising=False)
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.email", "ci@x"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.name", "ci"], cwd=tmp_path, check=True)
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    with open(tmp_path / "bitswan.yaml", "w") as f:
        dump_bitswan_yaml({"deployments": {}}, f)
    subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-qm", "init"], cwd=tmp_path, check=True)
    return svc


def test_default_blue_green_state(tmp_path, monkeypatch):
    svc = _git_svc(tmp_path, monkeypatch)
    b = svc.read_backups("shop")
    # Fresh wiring: slot a is live on db1, slot b is DR on db2, slot c idle.
    assert b["live_db"] == 1 and b["standby_db"] == 2
    assert b["live_slot"] == "a"
    assert b["dr_slot"] == "b"
    assert b["idle_slots"] == ["c"]
    assert b["slots"] == {"a": {"db": 1}, "b": {"db": 2}}
    assert b["retention"] == {"daily": 7, "weekly": 0, "monthly": 3}
    assert b["log"] == []


def test_retention_persists_and_audits(tmp_path, monkeypatch):
    svc = _git_svc(tmp_path, monkeypatch)
    b = asyncio.run(
        svc.set_backup_retention(
            "shop", {"daily": 14, "weekly": 4, "monthly": 6}, by="tim@x"
        )
    )
    assert b["retention"] == {"daily": 14, "weekly": 4, "monthly": 6}
    assert b["log"][0]["action"] == "retention" and b["log"][0]["by"] == "tim@x"
    raw = read_bitswan_yaml(str(tmp_path))
    assert raw["backups"]["shop"]["retention"]["daily"] == 14


def test_swap_flips_live_db_and_slot_and_audits(tmp_path, monkeypatch):
    svc = _git_svc(tmp_path, monkeypatch)
    assert svc.live_slot("shop") == "a" and svc.live_db("shop") == 1
    # No production frontend deployed → repoint raises, caught; the pointer
    # flip + audit are still authoritative.
    b = asyncio.run(svc.swap_production_dr("shop", by="tim@x"))
    # DR slot b (on db2) becomes live; db flips to 2.
    assert b["live_slot"] == "b" and b["live_db"] == 2
    assert b["dr_slot"] == "a" and b["standby_db"] == 1
    assert b["log"][0]["action"] == "swapped"
    # swap back
    b2 = asyncio.run(svc.swap_production_dr("shop", by="tim@x"))
    assert b2["live_slot"] == "a" and b2["live_db"] == 1
    assert len(b2["log"]) == 2


def test_zero_downtime_promote_uses_idle_slot_keeps_db(tmp_path, monkeypatch):
    svc = _git_svc(tmp_path, monkeypatch)
    cur = svc.read_backups("shop")
    assert cur["live_slot"] == "a" and cur["idle_slots"] == ["c"]
    # Stage the new version on the idle slot (wired to the CURRENT live db).
    staged = asyncio.run(svc.begin_zero_downtime_promote("shop", by="tim@x"))
    assert staged["target_slot"] == "c"
    assert staged["slots"]["c"]["db"] == 1  # same live db — promote never moves data
    # Cut over: c becomes live, old live slot a retires to idle, db unchanged.
    done = asyncio.run(svc.finish_zero_downtime_promote("shop", "c", by="tim@x"))
    assert done["live_slot"] == "c" and done["live_db"] == 1
    assert "a" in done["idle_slots"]
    assert done["log"][0]["action"] == "promoted"


def test_record_backup_event(tmp_path, monkeypatch):
    svc = _git_svc(tmp_path, monkeypatch)
    b = asyncio.run(
        svc.record_backup_event("shop", "created", "manual snapshot 1.4 GB", by="tim@x")
    )
    assert b["log"][0]["action"] == "created"
    assert "manual snapshot" in b["log"][0]["detail"]


def test_backup_events_surface_in_deployment_history(tmp_path, monkeypatch):
    """Backup-domain events show up in bp_history on the right stage timeline:
    production-domain actions (swap) on production; a created snapshot on the
    stage it captured. Each is a read-only audit row (source == 'backup')."""
    svc = _git_svc(tmp_path, monkeypatch)
    asyncio.run(
        svc.record_backup_event(
            "shop", "created", "snap (dev)", by="tim@x", stage="dev"
        )
    )
    asyncio.run(svc.swap_production_dr("shop", by="tim@x"))  # production-domain

    prod = asyncio.run(svc.bp_history("shop", "production"))
    prod_bk = [e for e in prod["history"] if e["source"] == "backup"]
    assert any(e["backup"]["action"] == "swapped" for e in prod_bk)
    # the dev-created event must NOT leak onto the production timeline
    assert not any(e["backup"]["action"] == "created" for e in prod_bk)
    # backup events never become the "current" (live) version pointer
    assert prod["current"] is None

    dev = asyncio.run(svc.bp_history("shop", "dev"))
    dev_bk = [e for e in dev["history"] if e["source"] == "backup"]
    assert any(e["backup"]["action"] == "created" for e in dev_bk)
    assert not any(e["backup"]["action"] == "swapped" for e in dev_bk)
