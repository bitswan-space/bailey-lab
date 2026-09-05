"""Auditing happens in a copy of the version under audit.

The audited image itself is read-only — sign-offs key off its content hash, and
nothing an auditor does in a copy can change it. What a copy adds is the other
exit: an auditor who finds something can fix it and deploy, which is a new
version going through dev and its own sign-off like any other.
"""

import pytest
from fastapi import HTTPException

from app.routes import copies
from app.routes.copies import (
    COPY_KIND_AUDIT,
    COPY_KIND_EXPERIMENT,
    COPY_KIND_USER,
    audit_copy_name,
    audit_report_path,
    audited_image,
    copy_scope_bps,
    scoped_copy_bp,
)


def test_one_audit_copy_per_image_and_auditor():
    sha = "aa11bb22cc33dd44"
    mine = audit_copy_name(sha, "auditor@acme.com")
    theirs = audit_copy_name(sha, "other@acme.com")
    assert mine != theirs, "two auditors reviewing one image get their own copies"
    assert mine == audit_copy_name(
        sha, "AUDITOR@acme.com"
    ), "re-opening returns to the same copy"
    assert (
        audit_copy_name("ffffffffffff", "auditor@acme.com") != mine
    ), "a new image is a new audit"
    # A copy name becomes a branch name and part of per-(copy, bp) resource
    # names, so it stays short and legal.
    assert len(mine) <= 24
    copies._validate_new_copy_name(mine)


def test_the_report_is_a_file_in_the_business_process():
    assert audit_report_path("invoices") == "invoices/AUDIT.md"


def test_an_audit_copy_is_about_one_business_process():
    meta = {"kind": COPY_KIND_AUDIT, "bp": "invoices", "audited_sha": "abc123"}
    assert scoped_copy_bp(meta) == "invoices"
    assert scoped_copy_bp({"kind": COPY_KIND_EXPERIMENT, "bp": "orders"}) == "orders"
    assert scoped_copy_bp({"kind": COPY_KIND_USER}) is None
    assert scoped_copy_bp(None) is None


def test_copy_scope_is_the_audited_process_only(tmp_path, monkeypatch):
    copy_path = tmp_path / "audit-abc12345-ab12cd"
    (copy_path / "invoices" / ".git").mkdir(parents=True)
    (copy_path / "orders" / ".git").mkdir(parents=True)
    meta = {"kind": COPY_KIND_AUDIT, "bp": "invoices", "audited_sha": "abc"}
    # A stray clone in the directory does not widen an audit: the copy is about
    # the process whose image is frozen, and nothing else.
    assert copy_scope_bps(str(copy_path), meta) == ["invoices"]


def test_the_audited_image_is_recorded_on_the_copy():
    meta = {
        "kind": COPY_KIND_AUDIT,
        "bp": "invoices",
        "audited_sha": "aa11bb22",
        "audited_commit": "9b72ebb340326dcba7a28fa2b3ffe98125726d72",
    }
    assert audited_image(meta) == {
        "sha": "aa11bb22",
        "commit": "9b72ebb340326dcba7a28fa2b3ffe98125726d72",
    }
    assert audited_image({"kind": COPY_KIND_USER}) is None
    assert audited_image({"kind": COPY_KIND_AUDIT}) is None


class _Service:
    def __init__(self, role="auditor", frozen=True, sha="abc12345", commit="9b72ebb3"):
        self._role, self._frozen, self._sha, self._commit = role, frozen, sha, commit

    def _role_of(self, _by):
        return self._role

    def read_staging_gate(self, _bp):
        return {"frozen": self._frozen, "frozen_sha": self._sha}

    def stage_source_commit(self, _bp, _stage):
        return self._commit


@pytest.fixture()
def as_auditor(tmp_path, monkeypatch):
    monkeypatch.setattr(copies, "_copies_dir", lambda: str(tmp_path))
    from app.task_queue import current_requester

    current_requester.set("auditor@acme.com")

    def use(service):
        import app.dependencies as deps

        monkeypatch.setattr(deps, "get_automation_service", lambda: service)
        return service

    return use


async def test_only_an_admin_or_auditor_opens_an_audit(as_auditor):
    as_auditor(_Service(role="member"))
    with pytest.raises(HTTPException) as ei:
        await copies.open_audit(copies.OpenAuditRequest(bp="invoices"))
    assert ei.value.status_code == 403


async def test_there_is_nothing_to_audit_until_staging_is_frozen(as_auditor):
    as_auditor(_Service(frozen=False))
    with pytest.raises(HTTPException) as ei:
        await copies.open_audit(copies.OpenAuditRequest(bp="invoices"))
    assert ei.value.status_code == 409
    assert "not frozen" in ei.value.detail

    state = await copies.audit_state(bp="invoices")
    assert state.frozen is False
    assert state.exists is False
    assert state.name is None


async def test_a_promotion_part_way_through_has_no_single_version_to_audit(as_auditor):
    as_auditor(_Service(commit=None))
    with pytest.raises(HTTPException) as ei:
        await copies.open_audit(copies.OpenAuditRequest(bp="invoices"))
    assert ei.value.status_code == 409
    assert "part-way" in ei.value.detail


async def test_the_state_names_the_copy_before_it_exists(as_auditor):
    as_auditor(_Service())
    state = await copies.audit_state(bp="invoices")
    assert state.frozen is True
    assert state.exists is False
    assert state.name == audit_copy_name("abc12345", "auditor@acme.com")
    assert state.audited_sha == "abc12345"
    assert state.report_path == "invoices/AUDIT.md"
    assert state.proposed_changes == []


async def test_the_state_reports_what_the_auditor_has_changed(
    as_auditor, tmp_path, monkeypatch
):
    as_auditor(_Service())
    name = audit_copy_name("abc12345", "auditor@acme.com")
    (tmp_path / name / "invoices").mkdir(parents=True)

    async def fake_status(copy, bp=None):
        assert copy == name and bp == "invoices"
        return {"changed": [{"path": "invoices/worker.py", "kind": "modified"}]}

    monkeypatch.setattr(copies, "get_copy_status", fake_status)
    state = await copies.audit_state(bp="invoices")
    assert state.exists is True
    # Proposing a change is the other exit from an audit, and the panel needs
    # to tell it from signing the frozen version off.
    assert state.proposed_changes == ["invoices/worker.py"]
