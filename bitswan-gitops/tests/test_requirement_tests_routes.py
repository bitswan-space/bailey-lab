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


@pytest.fixture(autouse=True)
def _clean_run_state():
    """Test state is a process-wide singleton, so a run left behind by one test
    is visible to the next — which is exactly what the gate reads. Clear it
    around every test rather than only in the `client` fixture, since not every
    test here needs a client."""
    test_run_manager.forget("dev1", "shop")
    yield
    test_run_manager.forget("dev1", "shop")


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


# ---- the deploy gate on the sync path ---------------------------------------


async def test_a_bp_with_no_requirements_is_not_gated(tmp_path, monkeypatch):
    """Most BPs have no contract at all. "No tests" is not "failing tests" —
    gating them would stop every one of them from ever deploying."""
    from app.routes.copies import _tests_gate_for

    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(tmp_path))
    (tmp_path / "dev1" / "shop").mkdir(parents=True)

    gate = await _tests_gate_for("dev1", "shop")
    assert gate["green"] is True


async def test_a_failing_run_blocks_the_sync_with_a_reason(tmp_path, monkeypatch):
    from app.routes.copies import _tests_gate_for
    from app.test_run_manager import RUN_COMPLETED, VERDICT_FAIL, RequirementResult

    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(tmp_path))
    bp_dir = tmp_path / "dev1" / "shop"
    bp_dir.mkdir(parents=True)
    (bp_dir / "testable-requirements.toml").write_text(
        '[[requirement]]\nid = "REQ-AAAA"\n'
    )

    run = test_run_manager.start("dev1", "shop", "abc123", "wip", "tree1")
    run.results["REQ-AAAA"] = RequirementResult(id="REQ-AAAA", verdict=VERDICT_FAIL)
    test_run_manager.finish(run, RUN_COMPLETED)

    async def same_tree(_path):
        return "tree1"

    monkeypatch.setattr(test_runner, "working_tree_sha", same_tree)

    gate = await _tests_gate_for("dev1", "shop")
    assert gate["green"] is False
    assert "1 test(s) failed" in gate["reason"]


async def test_the_gate_starts_nothing(tmp_path, monkeypatch):
    """A read must not spawn a run: the work-in-progress commit that precedes
    it already triggers one, and a request that leaves a background task behind
    hangs whoever is waiting on the event loop."""
    from app.routes.copies import _tests_gate_for

    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(tmp_path))
    bp_dir = tmp_path / "dev1" / "shop"
    (bp_dir / "backend").mkdir(parents=True)
    (bp_dir / "testable-requirements.toml").write_text(
        '[[requirement]]\nid = "REQ-AAAA"\n'
    )
    # A test exists, so this BP is one the gate genuinely holds back — the case
    # where it would be most tempting to kick a run off.
    (bp_dir / "backend" / "app_test.go").write_text(
        "func TestREQ_AAAA_Health(t *testing.T) {}\n"
    )

    spawned = []
    monkeypatch.setattr(test_runner, "spawn_run", lambda *a, **k: spawned.append(a))

    gate = await _tests_gate_for("dev1", "shop")
    assert gate["green"] is False
    assert spawned == []


async def test_requirements_with_no_tests_do_not_hold_back_a_deploy(
    tmp_path, monkeypatch
):
    """The walkthrough's shape, and a common one: requirements written, no
    tests yet, nothing has run. A run would report `no_test` for all of them
    and let the deploy through, so waiting for it gates on nothing."""
    from app.routes.copies import _tests_gate_for

    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(tmp_path))
    bp_dir = tmp_path / "dev1" / "shop"
    bp_dir.mkdir(parents=True)
    (bp_dir / "testable-requirements.toml").write_text(
        '[[requirement]]\nid = "REQ-AAAA"\ndescription = "VAT matches the PO"\n\n'
        '[[requirement]]\nid = "REQ-BBBB"\ndescription = "Held for approval"\n'
    )

    gate = await _tests_gate_for("dev1", "shop")
    assert gate["green"] is True


async def test_a_requirement_with_a_test_still_waits_for_its_verdict(
    tmp_path, monkeypatch
):
    """The other half: once a test exists there IS something to wait for, and
    publishing before it has run would be publishing on no evidence."""
    from app.routes.copies import _tests_gate_for

    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(tmp_path))
    bp_dir = tmp_path / "dev1" / "shop"
    (bp_dir / "backend").mkdir(parents=True)
    (bp_dir / "testable-requirements.toml").write_text(
        '[[requirement]]\nid = "REQ-AAAA"\n'
    )
    (bp_dir / "backend" / "app_test.go").write_text(
        "func TestREQ_AAAA_Health(t *testing.T) {}\n"
    )

    gate = await _tests_gate_for("dev1", "shop")
    assert gate["green"] is False
    assert "have not run yet" in gate["reason"]


def test_test_file_discovery_matches_the_runners(tmp_path, monkeypatch):
    from app.services.testable_requirements import (
        find_tested_requirement_ids,
        is_test_path,
    )

    assert is_test_path("backend/app_test.go")
    assert is_test_path("worker/test_app.py")
    assert is_test_path("frontend/src/App.test.tsx")
    assert is_test_path("tests/anything.py")
    # A helper script naming an id in its usage text is not a test.
    assert not is_test_path("scripts/run-req-test.sh")

    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(tmp_path))
    bp_dir = tmp_path / "dev1" / "shop"
    (bp_dir / "backend").mkdir(parents=True)
    (bp_dir / "backend" / "x_test.go").write_text("func TestREQ_AAAA_Health() {}")
    (bp_dir / "backend" / "notes.md").write_text("REQ_BBBB is discussed here")

    found = find_tested_requirement_ids("dev1", "shop", ["REQ-AAAA", "REQ-BBBB"])
    # Only a test file counts; prose mentioning an id does not.
    assert found == {"REQ-AAAA"}


async def test_an_edit_does_not_block_a_bp_with_nothing_to_verify(
    tmp_path, monkeypatch
):
    """Publishing commits first, which makes any previous run stale. A business
    process with no tests has nothing to be stale ABOUT, so staleness must not
    hold it back — otherwise every second deploy is refused."""
    from app.routes.copies import _tests_gate_for
    from app.test_run_manager import RUN_COMPLETED, VERDICT_NO_TEST, RequirementResult

    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(tmp_path))
    bp_dir = tmp_path / "dev1" / "shop"
    bp_dir.mkdir(parents=True)
    (bp_dir / "testable-requirements.toml").write_text(
        '[[requirement]]\nid = "REQ-AAAA"\n'
    )

    run = test_run_manager.start("dev1", "shop", "abc123", "v1", "tree1")
    run.results["REQ-AAAA"] = RequirementResult(id="REQ-AAAA", verdict=VERDICT_NO_TEST)
    test_run_manager.finish(run, RUN_COMPLETED)

    async def moved(_path):
        return "tree2"  # the v2 edit just landed

    monkeypatch.setattr(test_runner, "working_tree_sha", moved)

    gate = await _tests_gate_for("dev1", "shop")
    assert gate["green"] is True


async def test_a_stale_run_still_blocks_when_a_test_exists(tmp_path, monkeypatch):
    """The other side: once something can be verified, a verdict that describes
    code which has since changed is not evidence about what is being published."""
    from app.routes.copies import _tests_gate_for
    from app.test_run_manager import RUN_COMPLETED, VERDICT_PASS, RequirementResult

    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(tmp_path))
    bp_dir = tmp_path / "dev1" / "shop"
    (bp_dir / "backend").mkdir(parents=True)
    (bp_dir / "testable-requirements.toml").write_text(
        '[[requirement]]\nid = "REQ-AAAA"\n'
    )
    (bp_dir / "backend" / "app_test.go").write_text(
        "func TestREQ_AAAA_Health(t *testing.T) {}\n"
    )

    run = test_run_manager.start("dev1", "shop", "abc123", "v1", "tree1")
    run.results["REQ-AAAA"] = RequirementResult(id="REQ-AAAA", verdict=VERDICT_PASS)
    test_run_manager.finish(run, RUN_COMPLETED)

    async def moved(_path):
        return "tree2"

    monkeypatch.setattr(test_runner, "working_tree_sha", moved)

    gate = await _tests_gate_for("dev1", "shop")
    assert gate["green"] is False
