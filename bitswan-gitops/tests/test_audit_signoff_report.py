"""A sign-off carries the report that justifies it.

A verdict on its own is a checkbox. What makes it evidence is the reasoning,
and that has to still be there when the copy it was written in is gone.
"""

import pytest
import yaml
from fastapi import HTTPException

import app.services.automation_service as mod
from app.services.automation_service import MAX_AUDIT_REPORT_CHARS, AutomationService

REPORT = "# Audit — invoices\n\n## Risk\n\nThe approval threshold is a constant.\n"


def _svc(tmp_path):
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    svc.secrets_dir = str(tmp_path / "secrets")
    svc.workspace_name = "finance"
    return svc


@pytest.fixture()
def frozen(tmp_path, monkeypatch):
    monkeypatch.setattr(mod, "daemon_user_role", lambda by: "auditor")
    (tmp_path / "bitswan.yaml").write_text(
        yaml.safe_dump(
            {"staging_gate": {"invoices": {"frozen": True, "frozen_sha": "abc123"}}}
        )
    )

    async def persisted(bs, bps, bp, kind, deployed_by=None, message=None):
        (tmp_path / "bitswan.yaml").write_text(yaml.safe_dump(bs))

    svc = _svc(tmp_path)
    monkeypatch.setattr(svc, "_persist_bp_state", persisted)
    return svc, tmp_path


def _records(tmp_path):
    bs = yaml.safe_load((tmp_path / "bitswan.yaml").read_text())
    return ((bs.get("audits") or {}).get("invoices") or {}).get("abc123") or []


async def test_the_report_is_stored_with_the_verdict(frozen):
    svc, tmp_path = frozen
    await svc.record_audit("invoices", "approve", by="auditor@x", report=REPORT)

    record = _records(tmp_path)[0]
    assert record["verdict"] == "approve"
    assert record["who"] == "auditor@x"
    assert "approval threshold is a constant" in record["report"]


async def test_requesting_changes_keeps_its_report_too(frozen):
    svc, tmp_path = frozen
    await svc.record_audit("invoices", "reject", by="auditor@x", report=REPORT)
    assert _records(tmp_path)[0]["report"].startswith("# Audit")


async def test_a_verdict_without_a_report_is_still_recorded(frozen):
    svc, tmp_path = frozen
    await svc.record_audit("invoices", "approve", by="auditor@x")
    assert _records(tmp_path)[0]["report"] is None


async def test_an_enormous_report_is_bounded(frozen):
    svc, tmp_path = frozen
    await svc.record_audit(
        "invoices", "approve", by="auditor@x", report="x" * (MAX_AUDIT_REPORT_CHARS * 2)
    )
    # bitswan.yaml is read by every workspace operation; one audit must not
    # bloat it without limit.
    assert len(_records(tmp_path)[0]["report"]) == MAX_AUDIT_REPORT_CHARS


async def test_signing_off_still_needs_a_frozen_image(tmp_path, monkeypatch):
    monkeypatch.setattr(mod, "daemon_user_role", lambda by: "auditor")
    (tmp_path / "bitswan.yaml").write_text(
        yaml.safe_dump({"staging_gate": {"invoices": {"frozen": False}}})
    )
    with pytest.raises(HTTPException) as ei:
        await _svc(tmp_path).record_audit(
            "invoices", "approve", by="a@x", report=REPORT
        )
    assert ei.value.status_code == 409


async def test_the_report_is_readable_from_the_gate_long_after(frozen, monkeypatch):
    svc, tmp_path = frozen
    monkeypatch.setattr(svc, "staging_content_sha", lambda bp: "abc123")
    await svc.record_audit("invoices", "approve", by="auditor@x", report=REPORT)

    gate = svc.read_staging_gate("invoices")
    assert gate["signoffs"][0]["report"].startswith("# Audit")
    # The production promote badge reads `approved_by`; an auditor looking back
    # at a release should find the reasoning there, not only a name.
    assert "approval threshold is a constant" in gate["approved_by"][0]["report"]
