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

    class _FakeDriver:
        async def container_stats(self, ctx, **kwargs):
            return []

    # Patch the DRIVER, not a method that does not exist: the previous version
    # patched `_container_mem_usage` with raising=False, which silently added an
    # attribute nothing calls and left the test making a real HTTP request to
    # the infra-driver on every run.
    monkeypatch.setattr(svc, "get_containers", _no_containers)
    svc._infra_driver = _FakeDriver()  # the backing field the property reads

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
    # `dead` and `exited` are the same thing to every consumer (the dashboard
    # maps both to "stopped"), so which literal survives is not a claim about
    # anything — the bucket is.
    assert svc._worse_state("exited", "dead") in ("exited", "dead")
    # `paused` is NOT up, whatever its name suggests, and the dashboard ranks it
    # with the stopped ones — above a restart loop. The two layers collapse the
    # same replicas, so they must not disagree about which is worse.
    assert svc._worse_state("restarting", "paused") == "paused"
    assert svc._worse_state("paused", "restarting") == "paused"
    # An unrecognised state sits at the bottom: it never outranks something we
    # could actually read — see the dedicated test below for why — and it never
    # hides a fault either.
    assert svc._worse_state("running", "weird-new-state") == "running"
    assert svc._worse_state("weird-new-state", "exited") == "exited"


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
        {
            "Id": "r1",
            "State": "restarting",
            "Status": "",
            "Labels": label,
            "RestartCount": 23032,
        },
        {
            "Id": "r2",
            "State": "running",
            "Status": "",
            "Labels": label,
            "RestartCount": None,
        },
        {
            "Id": "r3",
            "State": "running",
            "Status": "",
            "Labels": label,
            "RestartCount": None,
        },
    ]
    svc._apply_docker_overlay([entry], containers, {}, {})
    assert entry.state == "restarting"
    assert entry.restart_count == 23032


def test_an_unreadable_state_never_outranks_something_seen(tmp_path):
    """`removing` — or whatever Docker adds next — is an observation we cannot
    read, and it sits at the BOTTOM: it can never hide a replica we can read as
    dead, and it must not drag a deployment whose other replicas are plainly
    running into "not accounted for" during a rolling restart. Same principle,
    and the same ordering, as the dashboard's worstStatus."""
    svc = _svc(tmp_path)
    assert svc._worse_state("exited", "removing") == "exited"
    assert svc._worse_state("removing", "exited") == "exited"  # order must not matter
    assert svc._worse_state("running", "removing") == "running"
    assert svc._worse_state("removing", "running") == "running"
    assert svc._worse_state("restarting", "removing") == "restarting"


async def test_the_merged_record_describes_one_container(tmp_path, monkeypatch):
    """Merging the state across replicas while the id, the creation time and the
    memory reading came from whichever replica was last emitted one record
    describing two different containers."""
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
        {
            "Id": "sick",
            "State": "restarting",
            "Status": "",
            "Labels": label,
            "RestartCount": 40,
        },
        {"Id": "healthy", "State": "running", "Status": "healthy", "Labels": label},
    ]
    svc._apply_docker_overlay([entry], containers, {"_mem": {"healthy": 999}}, {})
    assert entry.state == "restarting"
    assert (
        entry.container_id == "sick"
    ), "the record must point at the container it describes"
    assert entry.status != "healthy", "state and status must not contradict each other"
    assert (
        entry.mem_usage_bytes is None
    ), "the healthy replica's memory is not this record's"


async def test_the_replica_order_does_not_decide_what_the_record_says(
    tmp_path, monkeypatch
):
    """The same two replicas, the other way round.

    With the healthy one first, the record took its id and memory, then switched
    the id to the sick replica when that one won the state — but `docker stats`
    has no row for a restarting container, so the healthy replica's usage (and
    its over-reservation flag) stayed behind on a record now describing the sick
    one.
    """
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
    label = {
        "gitops.deployment_id": "backend-bp-production",
        "gitops.mem_reservation_mb": "50",
    }
    containers = [
        {"Id": "healthy", "State": "running", "Status": "healthy", "Labels": label},
        {
            "Id": "sick",
            "State": "restarting",
            "Status": "",
            "Labels": label,
            "RestartCount": 40,
        },
    ]
    svc._apply_docker_overlay(
        [entry], containers, {"_mem": {"healthy": 900 * 1024 * 1024}}, {}
    )
    assert entry.state == "restarting"
    assert entry.container_id == "sick"
    assert entry.mem_usage_bytes is None, "that was the OTHER replica's memory"
    assert entry.mem_over_reservation is False, "and that was the other replica's flag"
    assert entry.restart_count == 40


async def test_an_unhealthy_replica_is_not_lost_to_a_healthy_one(tmp_path):
    """Docker's healthcheck verdict rides on `status`, and every other field
    belongs to the replica whose STATE won. With two replicas both `running`,
    one failing its healthcheck, the winner is whichever came first — so the
    verdict has to survive on its own, or the only fault anyone reported about
    this deployment never reaches the wire."""
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
        {"Id": "ok", "State": "running", "Status": "healthy", "Labels": label},
        {"Id": "sick", "State": "running", "Status": "unhealthy", "Labels": label},
    ]
    svc._apply_docker_overlay([entry], containers, {}, {})
    assert entry.state == "running"
    assert entry.status == "unhealthy"


def test_active_is_read_the_same_way_everywhere(tmp_path):
    """One reading, three readers.

    A missing `active` key means nobody ever slept it. This file used to read
    that as True in two places and False in a third, so the automations list
    reported a legacy entry as live while the deploy path skipped it — a member
    stuck at "not accounted for" that nothing was ever going to start.
    """
    svc = _svc(tmp_path)
    assert svc._is_active({}) is True, "absence is not a sleep"
    assert svc._is_active({"active": True}) is True
    assert svc._is_active({"active": False}) is False
    assert svc._is_active(None) is True
    # And the deploy path agrees with it, on the same yaml.
    (tmp_path / "bitswan.yaml").write_text(
        yaml.safe_dump(
            {
                "deployments": {
                    "legacy": {"stage": "dev"},  # predates normalisation
                    "slept": {"stage": "dev", "active": False},
                    "live": {"stage": "dev", "active": True},
                }
            }
        )
    )
    active = svc.get_active_automations()
    assert set(active) == {"legacy", "live"}
