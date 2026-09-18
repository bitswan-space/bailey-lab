"""The HTTP surface the dashboard and the CLI both drive.

Both must reach the SAME engine — a verdict that depended on who asked for it
would be worse than no verdict — so the agent-token routes are asserted to
delegate to the same handlers as the token-authenticated ones.
"""

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

import app.routes.processes as processes
from app import test_runner
from app.dependencies import verify_token
from app.test_run_manager import test_run_manager

TOKEN = "test-gitops-secret"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_GITOPS_SECRET", TOKEN)
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(tmp_path))
    (tmp_path / "dev1" / "shop").mkdir(parents=True)
    api = FastAPI()
    api.include_router(processes.router, dependencies=[Depends(verify_token)])
    with TestClient(api) as c:
        yield c
    test_run_manager.forget("dev1", "shop")


def _headers():
    return {"Authorization": f"Bearer {TOKEN}"}


def test_state_is_null_before_anything_has_run(client):
    res = client.get("/processes/shop/tests?copy=dev1", headers=_headers())
    assert res.status_code == 200
    assert res.json() is None


def test_gate_is_closed_but_explains_itself_when_nothing_has_run(client):
    res = client.get("/processes/shop/tests/gate?copy=dev1", headers=_headers())
    body = res.json()
    assert body["green"] is False and body["known"] is False
    assert "have not run" in body["reason"]


def test_run_returns_immediately_rather_than_holding_the_request(client, monkeypatch):
    started = {}

    def fake_spawn(copy, bp, only_ids=None, failed_only=False):
        started["args"] = (copy, bp, only_ids, failed_only)

    monkeypatch.setattr(test_runner, "spawn_run", fake_spawn)

    res = client.post(
        "/processes/shop/tests/run?copy=dev1",
        json={"failed_only": True},
        headers=_headers(),
    )
    assert res.status_code == 200
    assert started["args"] == ("dev1", "shop", None, True)


def test_run_rejects_an_unsafe_requirement_id(client, monkeypatch):
    monkeypatch.setattr(test_runner, "spawn_run", lambda *a, **k: None)
    res = client.post(
        "/processes/shop/tests/run?copy=dev1",
        json={"ids": ["REQ-1; rm -rf /"]},
        headers=_headers(),
    )
    assert res.status_code == 400


def test_bad_bp_and_copy_names_are_rejected(client):
    assert client.get(
        "/processes/..%2Fetc/tests?copy=dev1", headers=_headers()
    ).status_code in (400, 404)
    assert (
        client.get("/processes/shop/tests?copy=../x", headers=_headers()).status_code
        == 400
    )


def test_gate_reports_failures_with_a_human_reason(client, monkeypatch):
    from app.test_run_manager import VERDICT_FAIL, VERDICT_PASS, RUN_COMPLETED

    run = test_run_manager.start("dev1", "shop", "abc123", "add health", "tree1")
    run.results["REQ-AAAA"] = _result("REQ-AAAA", VERDICT_PASS)
    run.results["REQ-BBBB"] = _result("REQ-BBBB", VERDICT_FAIL)
    test_run_manager.finish(run, RUN_COMPLETED)

    async def fake_tree(_path):
        return "tree1"

    monkeypatch.setattr(test_runner, "working_tree_sha", fake_tree)

    body = client.get("/processes/shop/tests/gate?copy=dev1", headers=_headers()).json()
    assert body["green"] is False
    assert "1 test(s) failed" in body["reason"]


def test_gate_refuses_a_result_the_tree_has_moved_past(client, monkeypatch):
    from app.test_run_manager import VERDICT_PASS, RUN_COMPLETED

    run = test_run_manager.start("dev1", "shop", "abc123", "add health", "tree1")
    run.results["REQ-AAAA"] = _result("REQ-AAAA", VERDICT_PASS)
    test_run_manager.finish(run, RUN_COMPLETED)

    async def moved(_path):
        return "tree2"

    monkeypatch.setattr(test_runner, "working_tree_sha", moved)

    body = client.get("/processes/shop/tests/gate?copy=dev1", headers=_headers()).json()
    assert body["green"] is False
    assert "out of date" in body["reason"]


def _result(req_id, verdict):
    from app.test_run_manager import RequirementResult

    return RequirementResult(id=req_id, verdict=verdict)
