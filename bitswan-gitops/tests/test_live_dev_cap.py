"""Live-dev instance pool: cap the number of RUNNING (copy×BP) live-dev
instances, evict the oldest (LRU by last-activity), and rehydrate on wake.
Eviction stops WORKER containers only (never the shared per-BP egress gateway)
and keeps the deploy entry, so a wake is a cheap restart."""

import asyncio
import os

from app.services.automation_service import AutomationService


class _Container:
    def __init__(self, ctx, dep, created, state="running"):
        self.id = f"cid-{dep}"
        self.created = created
        self.state = state
        self.labels = {
            "gitops.context": ctx,
            "gitops.deployment_id": dep,
            "gitops.stage": "live-dev",
            "gitops.workspace": "ws",
        }

    def to_docker_dict(self):
        return {"Id": self.id, "Labels": self.labels, "State": self.state}


class _FakeDriver:
    def __init__(self, containers):
        self.containers = containers
        self.restarted: list[str] = []

    async def container_list(self, ctx, labels=None):
        return list(self.containers)

    async def container_restart(self, ctx, cid):
        self.restarted.append(cid)


def _svc(tmp_path, cap, containers):
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    svc.secrets_dir = str(tmp_path / "secrets")
    svc.workspace_name = "ws"
    svc._infra_driver = _FakeDriver(containers)
    os.environ["BITSWAN_MAX_LIVE_DEV"] = str(cap)
    return svc


def test_cap_evicts_oldest_workers_only(tmp_path, monkeypatch):
    # 3 running instances (a oldest=100, b=200, c=300), cap=2 → evict a.
    conts = [
        _Container("copy-a-bp", "be-a", 100),
        _Container("copy-a-bp", "fe-a", 100),  # both of a's workers
        _Container("copy-b-bp", "be-b", 200),
        _Container("copy-c-bp", "be-c", 300),
    ]
    svc = _svc(tmp_path, cap=2, containers=conts)
    stopped: list[str] = []

    async def _stop(dep):
        stopped.append(dep)

    monkeypatch.setattr(svc, "stop_automation", _stop)

    res = asyncio.run(svc.enforce_live_dev_cap())
    assert res["cap"] == 2 and res["running"] == 3
    assert res["evicted"] == ["copy-a-bp"]  # the oldest, exactly one over cap
    assert set(stopped) == {"be-a", "fe-a"}  # BOTH of the oldest instance's workers


def test_under_cap_is_noop(tmp_path, monkeypatch):
    conts = [_Container("copy-a-bp", "be-a", 100), _Container("copy-b-bp", "be-b", 200)]
    svc = _svc(tmp_path, cap=15, containers=conts)
    stopped: list[str] = []

    async def _stop(dep):
        stopped.append(dep)

    monkeypatch.setattr(svc, "stop_automation", _stop)
    res = asyncio.run(svc.enforce_live_dev_cap())
    assert res["evicted"] == [] and stopped == []


def test_access_marker_beats_created_for_lru(tmp_path, monkeypatch):
    # a is the oldest by container Created, but was just accessed (marker), so
    # b (older activity) is evicted instead. cap=1.
    conts = [
        _Container("copy-a-bp", "be-a", 100),
        _Container("copy-b-bp", "be-b", 200),
    ]
    svc = _svc(tmp_path, cap=1, containers=conts)
    svc.touch_live_dev_access("copy-a-bp")  # a is now most-recently-active
    stopped: list[str] = []

    async def _stop(dep):
        stopped.append(dep)

    monkeypatch.setattr(svc, "stop_automation", _stop)
    res = asyncio.run(svc.enforce_live_dev_cap())
    assert res["evicted"] == ["copy-b-bp"]  # b evicted, a kept (recently accessed)
    assert stopped == ["be-b"]


def test_wake_restarts_stopped_workers_and_stamps(tmp_path, monkeypatch):
    # Warm path: the workers exist but are stopped → wake restarts them in place
    # (docker restart, no compose recreate) + marks active + stamps activity.
    conts = [_Container("copy-a-bp", "be-a", 100, state="exited")]
    svc = _svc(tmp_path, cap=15, containers=conts)
    active: list[str] = []

    async def _mark(dep):
        active.append(dep)

    monkeypatch.setattr(svc, "mark_as_active", _mark)

    res = asyncio.run(svc.wake_live_dev("copy-a-bp"))
    assert res["deployment_ids"] == ["be-a"]
    assert svc._infra_driver.restarted == [
        "cid-be-a"
    ]  # container_restart, not recreate
    assert active == ["be-a"]
    assert os.path.exists(os.path.join(svc._live_dev_access_dir(), "copy-a-bp"))


def test_wake_skips_hydrating_instance(tmp_path, monkeypatch):
    # A mid-startup (created) instance must NOT be re-triggered (anti-flap): the
    # loading page polls every few seconds while it comes up.
    conts = [_Container("copy-a-bp", "be-a", 100, state="created")]
    svc = _svc(tmp_path, cap=15, containers=conts)
    res = asyncio.run(svc.wake_live_dev("copy-a-bp"))
    assert res.get("already_running") is True
    assert svc._infra_driver.restarted == []  # not touched


def test_wake_running_instance_is_touch_only(tmp_path, monkeypatch):
    # A RUNNING instance must NOT be restarted (the dashboard fires wake on every
    # BP-load as an LRU touch); it just refreshes recency.
    conts = [_Container("copy-a-bp", "be-a", 100, state="running")]
    svc = _svc(tmp_path, cap=15, containers=conts)
    started: list[str] = []

    async def _start(dep):
        started.append(dep)

    monkeypatch.setattr(svc, "start_automation", _start)
    res = asyncio.run(svc.wake_live_dev("copy-a-bp"))
    assert started == []  # not restarted
    assert res.get("already_running") is True
    assert os.path.exists(os.path.join(svc._live_dev_access_dir(), "copy-a-bp"))
