"""Issue #181 / BSY-02: production secrets are admin/auditor-only to READ; they
must be equally protected on WRITE.

A non-privileged caller (or one with no resolvable identity) may edit dev /
staging but must NOT be able to change the production realm — since they cannot
even read it, their submitted production values must never overwrite the real
ones. Enforced fail-closed via the daemon role store, mirroring
`read_bp_secrets` / `_is_production_role`.
"""

import asyncio

import app.services.automation_service as mod
from app.services.automation_service import AutomationService


def _svc(tmp_path, monkeypatch):
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    svc.secrets_dir = str(tmp_path / "secrets")

    async def _noop_apply(ids, deployed_by=None, report=None):
        return {"deployment_ids": list(ids)}

    monkeypatch.setattr(svc, "apply_compose_for_deployments", _noop_apply)
    return svc


def _as_role(monkeypatch, role):
    monkeypatch.setattr(mod, "daemon_user_role", lambda by: role)


def test_admin_can_set_production_secret(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    _as_role(monkeypatch, "admin")
    asyncio.run(
        svc.write_bp_secrets(
            "shop", {"production": {"K": "prod-v1"}}, deployed_by="admin@x"
        )
    )
    assert svc.read_bp_secrets("shop", by="admin@x")["production"]["K"] == "prod-v1"


def test_member_cannot_change_production_but_can_edit_dev(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    # Admin seeds a real production secret.
    _as_role(monkeypatch, "admin")
    asyncio.run(
        svc.write_bp_secrets(
            "shop", {"production": {"K": "real"}}, deployed_by="admin@x"
        )
    )
    # A member submits a write that both edits dev AND tries to overwrite prod.
    _as_role(monkeypatch, "member")
    asyncio.run(
        svc.write_bp_secrets(
            "shop",
            {"dev": {"D": "dev-v1"}, "production": {"K": "hacked"}},
            deployed_by="member@x",
        )
    )
    # Read back as a privileged caller: production is untouched, dev edit applied.
    _as_role(monkeypatch, "admin")
    got = svc.read_bp_secrets("shop", by="admin@x")
    assert got["production"]["K"] == "real", "member overwrote a production secret"
    assert got["dev"]["D"] == "dev-v1", "member's dev edit was dropped"


def test_unidentified_writer_cannot_change_production(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    _as_role(monkeypatch, "admin")
    asyncio.run(
        svc.write_bp_secrets(
            "shop", {"production": {"K": "real"}}, deployed_by="admin@x"
        )
    )
    # No identity → fail-closed → production preserved.
    asyncio.run(
        svc.write_bp_secrets("shop", {"production": {"K": "wiped"}}, deployed_by=None)
    )
    assert svc.read_bp_secrets("shop", by="admin@x")["production"]["K"] == "real"
