"""The audit environment as the auditor's API sees it."""

import os

import pytest
import yaml
from fastapi import HTTPException

import app.services.automation_service as mod
from app.services import audit_env
from app.services.automation_service import AutomationService


def _svc(tmp_path):
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    svc.secrets_dir = str(tmp_path / "secrets")
    svc.workspace_name = "finance"
    return svc


def _freeze(tmp_path, bp="invoices", sha="abc123", frozen=True, **extra):
    """Write the bitswan.yaml a frozen (or unfrozen) staging gate produces."""
    state = {
        "staging_gate": {
            bp: {"frozen": frozen, "frozen_sha": sha if frozen else None, **extra}
        }
    }
    path = tmp_path / "bitswan.yaml"
    path.write_text(yaml.safe_dump(state))
    return path


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_AUDITS_DIR", str(tmp_path / "audits"))
    monkeypatch.setattr(mod, "daemon_user_role", lambda by: "auditor")
    src = audit_env.source_dir("invoices", "abc123")
    os.makedirs(os.path.join(src, "vendors"), exist_ok=True)
    open(os.path.join(src, "worker.py"), "w").write("TOTAL_VAT = 21\n")
    open(os.path.join(src, "vendors", "ares.py"), "w").write("LOOKUP = 'ares'\n")
    open(audit_env.diff_path("invoices", "abc123"), "w").write(
        "--- a/worker.py\n+TOTAL_VAT = 21\n"
    )
    _freeze(tmp_path)
    return _svc(tmp_path)


async def test_the_tree_is_the_audited_source(env):
    tree = await env.audit_env_tree("invoices")
    names = {e["name"] for e in tree["entries"]}
    assert names == {"worker.py", "vendors"}


async def test_a_file_comes_back_from_the_audited_source(env):
    got = await env.audit_env_file("invoices", "vendors/ares.py")
    assert got["content"] == "LOOKUP = 'ares'\n"
    assert got["truncated"] is False


async def test_a_path_that_climbs_out_is_refused(env):
    for bad in ("../../etc/passwd", "/etc/passwd", "vendors/../../escape"):
        with pytest.raises(HTTPException) as ei:
            await env.audit_env_file("invoices", bad)
        assert ei.value.status_code == 400


def test_search_and_diff_read_the_environment(env):
    hits = env.audit_env_search("invoices", "vat")
    assert [m["path"] for m in hits["matches"]] == ["worker.py"]
    assert "TOTAL_VAT" in env.audit_env_diff("invoices")["diff"]


def test_the_report_round_trips(env):
    assert env.audit_env_report("invoices")["content"] == ""
    env.write_audit_env_report(
        "invoices", "# Findings\n\nVAT handling reviewed.\n", "auditor@x"
    )
    assert "VAT handling reviewed" in env.audit_env_report("invoices")["content"]


def test_only_an_auditor_or_admin_may_write_the_report(env, monkeypatch):
    monkeypatch.setattr(mod, "daemon_user_role", lambda by: "member")
    with pytest.raises(HTTPException) as ei:
        env.write_audit_env_report("invoices", "# Mine\n", "member@x")
    assert ei.value.status_code == 403


async def test_with_staging_unfrozen_there_is_nothing_to_audit(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_AUDITS_DIR", str(tmp_path / "audits"))
    _freeze(tmp_path, frozen=False)
    svc = _svc(tmp_path)
    for call in (
        lambda: svc.audit_env_search("invoices", "x"),
        lambda: svc.audit_env_diff("invoices"),
        lambda: svc.audit_env_report("invoices"),
    ):
        with pytest.raises(HTTPException) as ei:
            call()
        assert ei.value.status_code == 409
        assert "not frozen" in ei.value.detail
    with pytest.raises(HTTPException):
        await svc.audit_env_tree("invoices")


def test_the_state_names_the_two_versions_it_compares(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_AUDITS_DIR", str(tmp_path / "audits"))
    monkeypatch.setattr(mod, "audit_agent_state", lambda *a: {"running": True})
    _freeze(
        tmp_path,
        frozen_commit="aaaaaaaaaaaa",
        production_commit_at_freeze="bbbbbbbbbbbb",
        frozen_by="auditor@x",
    )
    state = _svc(tmp_path).audit_env_state("invoices")
    assert state["audited_commit"] == "aaaaaaaaaaaa"
    assert state["production_commit"] == "bbbbbbbbbbbb"
    assert state["frozen_by"] == "auditor@x"
    assert state["agent"] == {"running": True}


def test_unfrozen_state_is_honest_about_having_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_AUDITS_DIR", str(tmp_path / "audits"))
    _freeze(tmp_path, frozen=False)
    state = _svc(tmp_path).audit_env_state("invoices")
    assert state["ready"] is False
    assert "not frozen" in state["reason"]


def test_stage_source_commit_needs_one_answer(tmp_path):
    svc = _svc(tmp_path)
    (tmp_path / "bitswan.yaml").write_text(
        yaml.safe_dump(
            {
                "business_processes": {
                    "invoices": {
                        "staging": {
                            "deployments": {
                                "a": {"source_commit": "aaaa"},
                                "b": {"source_commit": "aaaa"},
                            }
                        },
                        "production": {
                            "deployments": {
                                "a": {"source_commit": "aaaa"},
                                "b": {"source_commit": "bbbb"},
                            }
                        },
                    }
                }
            }
        )
    )
    assert svc.stage_source_commit("invoices", "staging") == "aaaa"
    # Mid-promotion, members disagree: there is no single version to audit.
    assert svc.stage_source_commit("invoices", "production") is None


def test_a_missing_agent_is_started_when_the_state_is_read(env, monkeypatch):
    """The container is disposable and the audit is not: opening the tab with a
    frozen image and no agent brings it back, and says why when it will not."""
    starts = []
    monkeypatch.setattr(mod, "audit_agent_state", lambda *a: {"running": False})
    monkeypatch.setattr(
        mod,
        "start_audit_agent",
        lambda *a: starts.append(a) or {"running": False, "reason": "no such image"},
    )
    state = env.audit_env_state("invoices")
    assert starts, "a frozen image with no agent must be started"
    assert state["agent"]["reason"] == "no such image"


def test_a_running_agent_is_left_alone(env, monkeypatch):
    monkeypatch.setattr(mod, "audit_agent_state", lambda *a: {"running": True})
    monkeypatch.setattr(
        mod,
        "start_audit_agent",
        lambda *a: (_ for _ in ()).throw(AssertionError("started twice")),
    )
    assert env.audit_env_state("invoices")["agent"] == {"running": True}
