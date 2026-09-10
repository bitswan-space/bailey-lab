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


async def test_automations_list_reports_a_slept_deployment_as_inactive(
    tmp_path, monkeypatch
):
    """`active` must survive the cache.

    The automations list is served from a static cache, and `active` is baked
    into it when the cache is built. Sleeping a deployment only rewrites
    bitswan.yaml — so an evicted deployment went on being reported as
    `active: true` (measured live), and a dashboard reading that field could not
    tell "asleep" from "no information", which is how a stage with a sleeping
    service still called itself Healthy.
    """
    svc = _svc(tmp_path)
    (tmp_path / "bitswan.yaml").write_text(
        yaml.safe_dump(
            {
                "deployments": {
                    "frontend-bp-staging": {
                        "active": False,  # slept
                        "automation_name": "frontend",
                        "context": "bp",
                        "stage": "staging",
                        "relative_path": "copies/main/bp/frontend",
                    }
                }
            }
        )
    )
    # The cache still holds the entry as it was when it was built: active.
    from app.models import DeployedAutomation

    stale = DeployedAutomation(
        container_id=None,
        endpoint_name=None,
        created_at=None,
        name="frontend-bp-staging",
        state=None,
        status=None,
        deployment_id="frontend-bp-staging",
        active=True,
        automation_url=None,
        relative_path="copies/main/bp/frontend",
        stage="staging",
    )
    svc._cache = {"main": [stale]}

    async def _no_containers():
        return []

    async def _no_mem():
        return {}

    monkeypatch.setattr(svc, "get_containers", _no_containers)
    monkeypatch.setattr(svc, "_container_mem_usage", _no_mem, raising=False)

    result = await svc.get_automations()
    entry = next(a for a in result if a.deployment_id == "frontend-bp-staging")
    assert entry.active is False, "the list still claimed a slept deployment was active"


def test_worse_state_lets_no_replica_hide_another(tmp_path):
    """Replicas share a deployment_id, so one entry is described by several
    containers. The worst of them is the honest reading — a dead replica beside
    a live one is not "running"."""
    svc = _svc(tmp_path)
    assert svc._worse_state(None, "running") == "running"
    assert svc._worse_state("running", "restarting") == "restarting"
    assert svc._worse_state("restarting", "running") == "restarting"
    assert svc._worse_state("running", "exited") == "exited"
    assert svc._worse_state("exited", "dead") == "dead"
    # An unrecognised state must not be mistaken for a clean bill.
    assert svc._worse_state("running", "weird-new-state") == "weird-new-state"
    assert svc._worse_state("weird-new-state", "running") == "weird-new-state"


async def test_a_crashlooping_replica_is_not_hidden_by_its_healthy_siblings(
    tmp_path, monkeypatch
):
    """The bug this pins: the overlay took the LAST container's word for the
    whole deployment, so a 3-replica deployment whose first replica was
    restarting 23,032 times reported state=running with no restart count."""
    svc = _svc(tmp_path)
    svc.workspace_name = "ws"
    from app.models import DeployedAutomation

    entry = DeployedAutomation(
        container_id=None,
        endpoint_name=None,
        created_at=None,
        name="backend-bp-production",
        state=None,
        status=None,
        deployment_id="backend-bp-production",
        active=True,
        automation_url=None,
        relative_path="copies/main/bp/backend",
        stage="production",
    )
    label = {"gitops.deployment_id": "backend-bp-production"}
    containers = [
        {"Id": "r1", "State": "restarting", "Status": "", "Labels": label, "RestartCount": 23032},
        {"Id": "r2", "State": "running", "Status": "", "Labels": label, "RestartCount": None},
        {"Id": "r3", "State": "running", "Status": "", "Labels": label, "RestartCount": None},
    ]
    svc._apply_docker_overlay([entry], containers, {}, {})
    assert entry.state == "restarting"
    assert entry.restart_count == 23032
