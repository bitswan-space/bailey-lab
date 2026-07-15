"""Sleep-reason observability.

When a deployment is put to sleep — automatically (memory pressure) or manually
(an operator's Sleep) — that must be attributable, in the logs AND to the
dashboard, instead of a container silently vanishing. This covers the reason
marker round-trip, that eviction stamps + logs the reason, and that the manual
vs automatic paths carry the right reason.
"""

import asyncio
import logging

import yaml

from app.services.automation_service import AutomationService


def _svc(tmp_path):
    (tmp_path / "bitswan.yaml").write_text(yaml.safe_dump({"deployments": {}}))
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    svc.secrets_dir = str(tmp_path / "secrets")
    svc.workspace_name = "ws"
    return svc


def test_reason_marker_roundtrip(tmp_path):
    svc = _svc(tmp_path)
    assert svc.sleep_reason_for("d1") is None
    svc._record_sleep_reason("d1", "memory-pressure")
    assert svc.sleep_reason_for("d1") == "memory-pressure"
    svc._record_sleep_reason("d1", "manual")  # a re-sleep overwrites
    assert svc.sleep_reason_for("d1") == "manual"
    svc._clear_sleep_reason("d1")  # wake clears it
    assert svc.sleep_reason_for("d1") is None


def test_evict_stamps_and_logs_reason(tmp_path, monkeypatch, caplog):
    svc = _svc(tmp_path)
    removed = []

    class _FakeDriver:
        async def container_remove(self, ctx, cid):
            removed.append(cid)

    svc._infra_driver = _FakeDriver()

    async def _noop_inactive(did):
        return None

    async def _one_container(did):
        return [{"Id": f"c-{did}"}]

    monkeypatch.setattr(svc, "mark_as_inactive", _noop_inactive)
    monkeypatch.setattr(svc, "get_container", _one_container)

    with caplog.at_level(logging.INFO):
        asyncio.run(svc._evict_instance_deployment("d1", "manual"))

    assert removed == ["c-d1"], "the container must be removed"
    assert svc.sleep_reason_for("d1") == "manual", "reason must be persisted"
    assert any(
        "SLEEP" in r.message and "reason=manual" in r.message for r in caplog.records
    ), "eviction must log the reason (that's what would have made this debuggable)"


def test_default_reason_is_memory_pressure(tmp_path, monkeypatch):
    """The automatic sweep path defaults to memory-pressure (no explicit reason)."""
    svc = _svc(tmp_path)

    class _FakeDriver:
        async def container_remove(self, ctx, cid):
            return None

    async def _noop_inactive(did):
        return None

    async def _no_containers(did):
        return []

    svc._infra_driver = _FakeDriver()
    monkeypatch.setattr(svc, "mark_as_inactive", _noop_inactive)
    monkeypatch.setattr(svc, "get_container", _no_containers)

    asyncio.run(svc._evict_instance_deployment("d2"))
    assert svc.sleep_reason_for("d2") == "memory-pressure"
