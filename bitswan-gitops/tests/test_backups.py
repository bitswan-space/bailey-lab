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


def test_default_live_slot_is_a(tmp_path, monkeypatch):
    svc = _git_svc(tmp_path, monkeypatch)
    b = svc.read_backups("shop")
    assert b["live_slot"] == "a"
    assert b["standby_slot"] == "b"
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


def test_swap_flips_live_slot_and_audits(tmp_path, monkeypatch):
    svc = _git_svc(tmp_path, monkeypatch)
    assert svc.live_slot("shop") == "a"
    # repoint hook raises NotImplementedError (infra not provisioned) → caught;
    # the flip + audit are still authoritative.
    b = asyncio.run(svc.swap_production_dr("shop", by="tim@x"))
    assert b["live_slot"] == "b" and b["standby_slot"] == "a"
    assert b["log"][0]["action"] == "swapped"
    # swap back
    b2 = asyncio.run(svc.swap_production_dr("shop", by="tim@x"))
    assert b2["live_slot"] == "a"
    assert len(b2["log"]) == 2


def test_record_backup_event(tmp_path, monkeypatch):
    svc = _git_svc(tmp_path, monkeypatch)
    b = asyncio.run(
        svc.record_backup_event("shop", "created", "manual snapshot 1.4 GB", by="tim@x")
    )
    assert b["log"][0]["action"] == "created"
    assert "manual snapshot" in b["log"][0]["detail"]
