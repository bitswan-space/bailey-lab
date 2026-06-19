"""Per-BP disaster-recovery test log: cadence policy + the hand-kept manual
recovery-test log, persisted in bitswan.yaml under the top-level
`disaster_recovery` key (versioned in git, same pattern as secrets).

The read/policy/record round-trip is exercised with git writes stubbed; the
overdue/days_since derivation is tested against the policy window.
"""

import asyncio
from datetime import date, timedelta

import pytest

from app.utils import read_bitswan_yaml, dump_bitswan_yaml
from app.services import automation_service as asvc
from app.services.automation_service import AutomationService


def _svc(tmp_path, monkeypatch):
    async def _noop_update_git(*a, **k):
        return None

    monkeypatch.setattr(asvc, "update_git", _noop_update_git)
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    # Start from a file that already has unrelated top-level keys so we verify
    # disaster_recovery coexists with them.
    with open(tmp_path / "bitswan.yaml", "w") as f:
        dump_bitswan_yaml({"deployments": {}, "secrets": {"keep": "me"}}, f)
    return svc


def test_read_dr_defaults_when_empty(tmp_path, monkeypatch):
    """A BP with no DR record reports the default quarterly policy, no tests,
    and is overdue (never tested)."""
    svc = _svc(tmp_path, monkeypatch)
    dr = svc.read_dr("shop")
    assert dr["policy"] == "quarterly"
    assert dr["window_days"] == 91
    assert dr["tests"] == []
    assert dr["last"] is None
    assert dr["days_since"] is None
    assert dr["overdue"] is True


def test_write_dr_policy_persists_and_changes_window(tmp_path, monkeypatch):
    """Setting a policy persists it (coexisting with other top-level keys) and
    changes the overdue window."""
    svc = _svc(tmp_path, monkeypatch)
    dr = asyncio.run(svc.write_dr_policy("shop", "monthly", deployed_by="tim@x"))
    assert dr["policy"] == "monthly"
    assert dr["window_days"] == 30

    # Persisted under the new top-level key; unrelated keys untouched.
    raw = read_bitswan_yaml(str(tmp_path))
    assert raw["disaster_recovery"]["shop"]["policy"] == "monthly"
    assert raw["secrets"] == {"keep": "me"}

    # Re-reading reflects the new policy.
    assert svc.read_dr("shop")["window_days"] == 30


def test_write_dr_policy_rejects_unknown_policy(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    with pytest.raises(ValueError):
        asyncio.run(svc.write_dr_policy("shop", "weekly"))


def test_record_dr_test_clears_overdue_and_sets_last(tmp_path, monkeypatch):
    """Recording a test today (against the backup currently restored into DR)
    makes the BP not-overdue, sets `last`, and `days_since` to 0."""
    svc = _svc(tmp_path, monkeypatch)
    asyncio.run(svc.record_dr_restore("shop", "20260616-120000-abcd1234", by="tim@x"))
    dr = asyncio.run(
        svc.record_dr_test(
            "shop",
            by="tim@x",
            note="Restored prod into staging, verified order totals.",
            snapshot="20260616-120000-abcd1234",
        )
    )
    assert dr["overdue"] is False
    assert dr["days_since"] == 0
    assert dr["last"]["by"] == "tim@x"
    assert len(dr["tests"]) == 1

    test = dr["tests"][0]
    assert test["verified"] is True
    assert test["id"].startswith("dr")
    assert test["date"] == date.today().isoformat()
    # snapshot + note are woven into the note text.
    assert "20260616-120000-abcd1234" in test["note"]
    assert "verified order totals" in test["note"]


def test_record_dr_test_defaults_by_and_note(tmp_path, monkeypatch):
    """Missing `by`/`note` fall back to sane defaults; an omitted snapshot falls
    back to the backup currently restored into DR."""
    svc = _svc(tmp_path, monkeypatch)
    asyncio.run(svc.record_dr_restore("shop", "snapX", by="tim@x"))
    dr = asyncio.run(svc.record_dr_test("shop", by=None, note=None, snapshot=None))
    test = dr["tests"][0]
    assert test["by"] == "unknown"
    assert test["snapshot"] == "snapX"
    assert "Recovery procedure performed and data verified by hand." in test["note"]


def test_record_dr_test_requires_restored_backup(tmp_path, monkeypatch):
    """A test can only be recorded once a backup is restored into DR, and only
    against THAT backup — anything else is a ValueError."""
    svc = _svc(tmp_path, monkeypatch)
    # Nothing restored yet → can't test.
    with pytest.raises(ValueError):
        asyncio.run(svc.record_dr_test("shop", by="a@x", note="x", snapshot="snapA"))
    # Restore snapA; testing a DIFFERENT backup still fails.
    asyncio.run(svc.record_dr_restore("shop", "snapA", by="a@x"))
    with pytest.raises(ValueError):
        asyncio.run(svc.record_dr_test("shop", by="a@x", note="x", snapshot="snapB"))
    # Testing the restored backup succeeds.
    dr = asyncio.run(svc.record_dr_test("shop", by="a@x", note="x", snapshot="snapA"))
    assert dr["tests"][0]["snapshot"] == "snapA"
    assert dr["restored"]["snapshot"] == "snapA"


def test_record_dr_test_prepends_newest_first(tmp_path, monkeypatch):
    """Multiple tests are stored newest-first."""
    svc = _svc(tmp_path, monkeypatch)
    asyncio.run(svc.record_dr_restore("shop", "snapX", by="a@x"))
    asyncio.run(svc.record_dr_test("shop", by="a@x", note="first", snapshot="snapX"))
    asyncio.run(svc.record_dr_test("shop", by="b@x", note="second", snapshot="snapX"))
    dr = svc.read_dr("shop")
    assert [t["by"] for t in dr["tests"]] == ["b@x", "a@x"]
    assert dr["last"]["by"] == "b@x"


def test_overdue_respects_policy_window(tmp_path, monkeypatch):
    """A test older than the policy window flips overdue back to True."""
    svc = _svc(tmp_path, monkeypatch)
    asyncio.run(svc.write_dr_policy("shop", "monthly"))  # 30-day window

    # Hand-write a 45-day-old test directly into the file.
    bs = read_bitswan_yaml(str(tmp_path))
    old = (date.today() - timedelta(days=45)).isoformat()
    bs["disaster_recovery"]["shop"]["tests"] = [
        {
            "id": "drold",
            "by": "tim@x",
            "at": "old",
            "date": old,
            "note": "old test",
            "verified": True,
        }
    ]
    with open(tmp_path / "bitswan.yaml", "w") as f:
        dump_bitswan_yaml(bs, f)

    dr = svc.read_dr("shop")
    assert dr["days_since"] == 45
    assert dr["overdue"] is True  # 45 > 30
