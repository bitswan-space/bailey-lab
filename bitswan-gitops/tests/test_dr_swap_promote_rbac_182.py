"""Issue #182 / BSY-03: the DR go-live swap and the zero-downtime production
promote both repoint/replace LIVE production, so — exactly like the
staging→production path — they require admin/auditor, resolved authoritatively
(fail-closed) from the daemon role store. A member, or a caller with no
resolvable identity, is rejected 403 before any work happens.
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


@pytest.mark.parametrize("op", ["swap_production_dr", "zero_downtime_promote"])
def test_member_cannot_swap_or_promote(tmp_path, monkeypatch, op):
    svc = _svc(tmp_path)
    _as_role(monkeypatch, "member")
    with pytest.raises(HTTPException) as ei:
        asyncio.run(getattr(svc, op)("shop", by="member@x"))
    assert ei.value.status_code == 403


@pytest.mark.parametrize("op", ["swap_production_dr", "zero_downtime_promote"])
def test_unidentified_caller_cannot_swap_or_promote(tmp_path, monkeypatch, op):
    svc = _svc(tmp_path)
    # by=None fails closed regardless of the role store.
    _as_role(monkeypatch, "admin")
    with pytest.raises(HTTPException) as ei:
        asyncio.run(getattr(svc, op)("shop", by=None))
    assert ei.value.status_code == 403


def test_admin_clears_the_swap_gate(tmp_path, monkeypatch):
    """An admin passes the role gate, so the swap proceeds and actually flips the
    live slot to the default DR slot — proving the gate let the admin through
    (a member/None caller is rejected 403 above, before any of this)."""
    svc = _svc(tmp_path)
    _as_role(monkeypatch, "admin")
    result = asyncio.run(svc.swap_production_dr("shop", by="admin@x"))
    assert result["live_slot"] == "green"
