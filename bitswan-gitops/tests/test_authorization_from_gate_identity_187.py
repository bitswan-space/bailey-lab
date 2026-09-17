import asyncio

import pytest
import yaml
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

import app.routes.tasks as tasks_routes
import app.services.automation_service as mod
from app.dependencies import verify_token
from app.main import _RequesterMiddleware
from app.services.automation_service import AutomationService
from app.task_queue import current_requester

ROLES = {"admin@x": "admin", "auditor@x": "auditor", "member@x": "member"}


def _svc(tmp_path, monkeypatch):
    monkeypatch.setattr(mod, "daemon_user_role", lambda email: ROLES.get(email, ""))
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    svc.secrets_dir = str(tmp_path / "secrets")
    (tmp_path / "bitswan.yaml").write_text(
        yaml.safe_dump(
            {"staging_gate": {"invoices": {"frozen": True, "frozen_sha": "abc123"}}}
        )
    )

    async def persisted(bs, bps, bp, kind, deployed_by=None, message=None):
        (tmp_path / "bitswan.yaml").write_text(yaml.safe_dump(bs))

    monkeypatch.setattr(svc, "_persist_bp_state", persisted)
    return svc


def test_naming_an_admin_in_the_request_does_not_grant_the_admin_gate(
    tmp_path, monkeypatch
):
    svc = _svc(tmp_path, monkeypatch)
    current_requester.set(None)
    with pytest.raises(HTTPException) as ei:
        asyncio.run(svc.set_staging_freeze("invoices", False, by="admin@x"))
    assert ei.value.status_code == 403
    current_requester.set("member@x")
    with pytest.raises(HTTPException) as ei:
        asyncio.run(svc.record_audit("invoices", "approve", by="admin@x"))
    assert ei.value.status_code == 403


def test_the_gate_identity_is_who_gets_recorded_not_the_claimed_name(
    tmp_path, monkeypatch
):
    svc = _svc(tmp_path, monkeypatch)
    current_requester.set("auditor@x")
    asyncio.run(svc.record_audit("invoices", "approve", by="mallory@x"))
    gate = svc.read_staging_gate("invoices")
    assert [s["who"] for s in gate["signoffs"]] == ["auditor@x"]
    asyncio.run(svc.set_staging_freeze("invoices", False, by="mallory@x"))
    assert svc.read_staging_gate("invoices")["frozen"] is False
    bs = yaml.safe_load((tmp_path / "bitswan.yaml").read_text())
    unfreeze = [
        e for e in bs["staging_gate"]["invoices"]["log"] if e["event"] == "unfreeze"
    ]
    assert unfreeze and unfreeze[-1]["who"] == "auditor@x"


def test_production_secrets_follow_the_gate_identity_not_a_query_name(
    tmp_path, monkeypatch
):
    svc = _svc(tmp_path, monkeypatch)
    current_requester.set("admin@x")
    asyncio.run(
        svc.write_bp_secrets(
            "shop", {"production": {"K": "real"}}, deployed_by="admin@x"
        )
    )
    current_requester.set("member@x")
    assert svc.read_bp_secrets("shop")["production"] == {}
    current_requester.set(None)
    assert svc.read_bp_secrets("shop")["production"] == {}
    current_requester.set("auditor@x")
    assert svc.read_bp_secrets("shop")["production"]["K"] == "real"


@pytest.fixture()
def tasks_client(monkeypatch):
    monkeypatch.setenv("BITSWAN_GITOPS_SECRET", "t")
    monkeypatch.setattr(
        tasks_routes, "daemon_user_role", lambda email: ROLES.get(email, "")
    )
    api = FastAPI()
    api.add_middleware(_RequesterMiddleware)
    api.include_router(tasks_routes.router, dependencies=[Depends(verify_token)])
    with TestClient(api) as c:
        yield c


def test_clearing_the_queue_ignores_a_by_query_parameter(tasks_client):
    auth = {"Authorization": "Bearer t"}
    assert tasks_client.post("/tasks/clear?by=admin@x", headers=auth).status_code == 403
    assert (
        tasks_client.post(
            "/tasks/clear?by=admin@x", headers={**auth, "X-Forwarded-Email": "member@x"}
        ).status_code
        == 403
    )
    assert (
        tasks_client.post(
            "/tasks/clear", headers={**auth, "X-Forwarded-Email": "admin@x"}
        ).status_code
        == 200
    )
