"""Egress-firewall rule model: allow/deny rules stored + versioned in
bitswan.yaml (the audit log), per-realm posture (dev=monitor, staging/prod=
enforce), production RBAC (admin/auditor only), and pull-rules-forward. Git
writes are stubbed; the attempts telemetry is read from the firewall cache dir.
"""

import asyncio

import pytest
from fastapi import HTTPException

from app.utils import read_bitswan_yaml, dump_bitswan_yaml
from app.services import automation_service as asvc
from app.services import firewall_service as fws
from app.services.automation_service import AutomationService


def _svc(tmp_path, monkeypatch):
    async def _noop_update_git(*a, **k):
        return None

    monkeypatch.setattr(asvc, "update_git", _noop_update_git)
    monkeypatch.setattr(fws, "firewall_dir", lambda: str(tmp_path / "fw"))
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    with open(tmp_path / "bitswan.yaml", "w") as f:
        dump_bitswan_yaml({"deployments": {}, "secrets": {"keep": "me"}}, f)
    return svc


def test_posture_defaults_by_realm(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    assert svc.read_firewall("shop", "dev")["posture"] == "monitor"
    assert svc.read_firewall("shop", "staging")["posture"] == "enforce"
    assert svc.read_firewall("shop", "production")["posture"] == "enforce"
    assert svc.read_firewall("shop", "dev")["rules"] == []


def test_set_rule_persists_and_audits(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    fw = asyncio.run(
        svc.set_firewall_rule(
            "shop", "dev", "Sentry.io", "allowed", "errors", by="tim@x"
        )
    )
    assert fw["allowed"] == ["sentry.io"]  # normalized
    r = fw["rules"][0]
    assert r["host"] == "sentry.io" and r["status"] == "allowed"
    assert r["by"] == "tim@x" and r["purpose"] == "errors"
    raw = read_bitswan_yaml(str(tmp_path))
    assert raw["firewall"]["shop"]["dev"]["rules"]["sentry.io"]["by"] == "tim@x"
    assert raw["secrets"] == {"keep": "me"}  # coexists


def test_production_requires_admin_or_auditor(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    # non-privileged role on production → 403
    with pytest.raises(HTTPException) as e:
        asyncio.run(
            svc.set_firewall_rule(
                "shop", "production", "api.x.com", "allowed", by="u", role="member"
            )
        )
    assert e.value.status_code == 403
    # dev is fine for anyone
    asyncio.run(
        svc.set_firewall_rule(
            "shop", "dev", "api.x.com", "allowed", by="u", role="member"
        )
    )
    # admin/auditor allowed on production
    for role in ("admin", "auditor"):
        fw = asyncio.run(
            svc.set_firewall_rule(
                "shop", "production", "api.x.com", "allowed", by="a", role=role
            )
        )
        assert "api.x.com" in fw["allowed"]


def test_delete_rule(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    asyncio.run(svc.set_firewall_rule("shop", "dev", "a.com", "allowed", by="x"))
    fw = asyncio.run(svc.delete_firewall_rule("shop", "dev", "a.com", by="x"))
    assert fw["rules"] == []


def test_promote_pulls_rules_forward(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    asyncio.run(svc.set_firewall_rule("shop", "dev", "a.com", "allowed", by="x"))
    asyncio.run(svc.set_firewall_rule("shop", "dev", "bad.com", "denied", by="x"))
    # pull dev → staging
    fw = asyncio.run(svc.promote_firewall("shop", "dev", "staging", by="x"))
    hosts = {r["host"]: r["status"] for r in fw["rules"]}
    assert hosts == {"a.com": "allowed", "bad.com": "denied"}
    assert fw["allowed"] == ["a.com"]


def test_attempts_feed_from_gateway_jsonl(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    import os
    import json

    d = str(tmp_path / "fw")
    os.makedirs(d, exist_ok=True)
    with open(fws.attempts_log_path("shop", "production"), "w") as f:
        for h in ["evil.com", "evil.com", "pypi.org"]:
            f.write(
                json.dumps({"host": h, "proto": "tls", "at": "2026-06-18T00:00:00Z"})
                + "\n"
            )
    fw = svc.read_firewall("shop", "production")
    review = {a["host"]: a["count"] for a in fw["attempts"]}
    assert review == {"evil.com": 2, "pypi.org": 1}  # needs-review feed (no rules yet)
    # once a rule exists for a host, it drops out of needs-review
    asyncio.run(
        svc.set_firewall_rule(
            "shop", "production", "pypi.org", "denied", by="a", role="admin"
        )
    )
    fw2 = svc.read_firewall("shop", "production")
    assert {a["host"] for a in fw2["attempts"]} == {"evil.com"}
