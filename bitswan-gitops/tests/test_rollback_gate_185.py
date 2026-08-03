"""Issue #185 / BSY-07: rolling a BP back reinstates a prior committed state,
which for staging/production is itself a (re)deploy to that stage. It must
re-run the SAME promotion gate a forward promote does — admin/auditor + staging
frozen + audit sign-offs for production — so a superseded or known-vulnerable
production image can't be reinstated without sign-off. dev rollbacks stay
ungated (like a dev deploy).
"""

import asyncio

import pytest
from fastapi import HTTPException

import app.services.automation_service as mod
from app.services.automation_service import AutomationService


def _svc(tmp_path):
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    svc.secrets_dir = str(tmp_path / "secrets")
    return svc


def _as_role(monkeypatch, role):
    monkeypatch.setattr(mod, "daemon_user_role", lambda by: role)


def test_production_rollback_blocked_for_member(tmp_path, monkeypatch):
    svc = _svc(tmp_path)
    _as_role(monkeypatch, "member")
    with pytest.raises(HTTPException) as ei:
        asyncio.run(
            svc.rollback_business_process(
                "shop", "production", "deadbeef", deployed_by="member@x"
            )
        )
    assert ei.value.status_code == 403


def test_production_rollback_reruns_audit_gate_even_for_admin(tmp_path, monkeypatch):
    """An admin clears the role check, but the production rollback still requires
    the freeze + sign-off gate — with staging unfrozen it's a 409, proving the
    promotion audit gate is re-run rather than bypassed."""
    svc = _svc(tmp_path)
    _as_role(monkeypatch, "admin")
    with pytest.raises(HTTPException) as ei:
        asyncio.run(
            svc.rollback_business_process(
                "shop", "production", "deadbeef", deployed_by="admin@x"
            )
        )
    assert ei.value.status_code == 409  # "Freeze staging … before promoting"


def test_dev_rollback_not_role_gated(tmp_path, monkeypatch):
    """dev has no promotion gate: a member reaches the restore logic (which then
    fails on the bogus commit) — crucially NOT a 403."""
    svc = _svc(tmp_path)
    _as_role(monkeypatch, "member")
    with pytest.raises(Exception) as ei:
        asyncio.run(
            svc.rollback_business_process(
                "shop", "dev", "deadbeef", deployed_by="member@x"
            )
        )
    assert not (
        isinstance(ei.value, HTTPException) and ei.value.status_code == 403
    ), "dev rollback must not be role-gated"
