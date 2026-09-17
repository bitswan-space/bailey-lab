import asyncio

import app.services.automation_service as mod
from app.services.automation_service import AutomationService
from app.utils import read_bitswan_yaml, write_bp_bitswan


def _svc(tmp_path):
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    svc.secrets_dir = str(tmp_path / "secrets")
    return svc


def _on_disk(tmp_path, bs):
    write_bp_bitswan(str(tmp_path), "invoices", bs)


def test_a_deploy_state_write_keeps_a_sign_off_recorded_while_it_was_running(
    tmp_path, monkeypatch
):
    svc = _svc(tmp_path)
    commits = []

    async def no_git(*args, **kwargs):
        commits.append(args[2])

    monkeypatch.setattr(mod, "update_bp_git", no_git)
    monkeypatch.setattr(mod, "request_workspace_mirror_push", lambda *a: None)

    before = {
        "deployments": {
            "dep-1": {"context": "invoices", "stage": "dev", "checksum": "old"}
        },
        "staging_gate": {"invoices": {"frozen": True, "frozen_sha": "abc123"}},
    }
    _on_disk(tmp_path, before)
    stale = read_bitswan_yaml(str(tmp_path))

    recorded = read_bitswan_yaml(str(tmp_path))
    recorded["audits"] = {
        "invoices": {"abc123": [{"who": "auditor@example.com", "verdict": "approve"}]}
    }
    _on_disk(tmp_path, recorded)

    stale["deployments"]["dep-1"]["checksum"] = "new"
    asyncio.run(
        svc._persist_bp_state(
            stale, {"invoices"}, "dep-1", "deploy", owned_keys={"business_processes"}
        )
    )

    after = read_bitswan_yaml(str(tmp_path))
    assert after["deployments"]["dep-1"]["checksum"] == "new"
    assert after["audits"]["invoices"]["abc123"][0]["who"] == "auditor@example.com"
    assert after["staging_gate"]["invoices"]["frozen_sha"] == "abc123"
    assert commits == ["invoices"]


def test_a_governance_write_still_replaces_everything_it_was_given(
    tmp_path, monkeypatch
):
    svc = _svc(tmp_path)

    async def no_git(*args, **kwargs):
        return None

    monkeypatch.setattr(mod, "update_bp_git", no_git)
    monkeypatch.setattr(mod, "request_workspace_mirror_push", lambda *a: None)
    _on_disk(
        tmp_path,
        {
            "deployments": {
                "dep-1": {"context": "invoices", "stage": "dev", "checksum": "c"}
            },
            "audits": {
                "invoices": {"abc123": [{"who": "a@example.com", "verdict": "approve"}]}
            },
        },
    )
    snapshot = read_bitswan_yaml(str(tmp_path))
    snapshot["audits"]["invoices"]["abc123"].insert(
        0, {"who": "b@example.com", "verdict": "reject"}
    )
    asyncio.run(svc._persist_bp_state(snapshot, {"invoices"}, "invoices", "audit"))
    after = read_bitswan_yaml(str(tmp_path))
    assert [e["who"] for e in after["audits"]["invoices"]["abc123"]] == [
        "b@example.com",
        "a@example.com",
    ]
