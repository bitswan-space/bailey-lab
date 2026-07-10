"""Ephemeral (dev + live-dev) deployment pool: cap the number of RUNNING
instances, evict the oldest (LRU by last-activity) by marking it inactive +
removing its worker containers (so it costs nothing), and rehydrate on wake by
re-activating + redeploying. staging/production are PROTECTED (never evicted).
Eviction never touches the shared per-BP egress gateway."""

import asyncio
import os

from app.services.automation_service import AutomationService


class _Container:
    def __init__(self, ctx, dep, created, state="running", stage="live-dev"):
        self.id = f"cid-{dep}"
        self.created = created
        self.state = state
        self.labels = {
            "gitops.context": ctx,
            "gitops.deployment_id": dep,
            "gitops.stage": stage,
            "gitops.workspace": "ws",
        }

    def to_docker_dict(self):
        return {"Id": self.id, "Labels": self.labels, "State": self.state}


class _FakeDriver:
    def __init__(self, containers):
        self.containers = containers
        self.removed: list[str] = []

    async def container_list(self, ctx, labels=None):
        return list(self.containers)

    async def container_remove(self, ctx, cid):
        self.removed.append(cid)


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
    evicted_deps: list[str] = []

    async def _evict(dep):
        evicted_deps.append(dep)

    monkeypatch.setattr(svc, "_evict_instance_deployment", _evict)

    res = asyncio.run(svc.enforce_live_dev_cap())
    assert res["cap"] == 2 and res["running"] == 3
    assert res["evicted"] == ["copy-a-bp"]  # the oldest, exactly one over cap
    assert set(evicted_deps) == {"be-a", "fe-a"}  # BOTH of the oldest's workers


def test_dev_is_ephemeral_staging_protected(tmp_path, monkeypatch):
    # dev + live-dev count toward the cap; staging/production are protected and
    # never counted or evicted. cap=1, 2 ephemeral (dev + live-dev) running.
    conts = [
        _Container("foo", "be-foo-dev", 100, stage="dev"),  # main dev, oldest
        _Container("copy-x-foo", "be-x", 200, stage="live-dev"),
        _Container("foo", "be-foo-stg", 50, stage="staging"),  # protected, ignored
        _Container("foo", "be-foo-prod", 10, stage="production"),  # protected
    ]
    svc = _svc(tmp_path, cap=1, containers=conts)
    evicted_deps: list[str] = []

    async def _evict(dep):
        evicted_deps.append(dep)

    monkeypatch.setattr(svc, "_evict_instance_deployment", _evict)
    res = asyncio.run(svc.enforce_live_dev_cap())
    # Only the 2 ephemeral counted; oldest (the dev instance) evicted.
    assert res["running"] == 2
    assert res["evicted"] == ["foo"]
    assert evicted_deps == ["be-foo-dev"]  # never the staging/production members


def test_stopped_ephemeral_is_reaped_even_under_cap(tmp_path, monkeypatch):
    # A fully-stopped (exited) ephemeral instance is removed even when under the
    # cap — idle must cost nothing; a wake redeploys it.
    conts = [_Container("copy-a-bp", "be-a", 100, state="exited")]
    svc = _svc(tmp_path, cap=15, containers=conts)
    evicted: list[str] = []

    async def _evict(dep):
        evicted.append(dep)

    monkeypatch.setattr(svc, "_evict_instance_deployment", _evict)
    res = asyncio.run(svc.enforce_live_dev_cap())
    assert res["evicted"] == ["copy-a-bp"]
    assert evicted == ["be-a"]


def test_evict_removes_containers_after_marking_inactive(tmp_path, monkeypatch):
    # _evict_instance_deployment marks inactive THEN removes the containers.
    conts = [_Container("copy-a-bp", "be-a", 100)]
    svc = _svc(tmp_path, cap=99, containers=conts)
    calls: list[str] = []

    async def _mark_inactive(dep):
        calls.append(f"inactive:{dep}")

    monkeypatch.setattr(svc, "mark_as_inactive", _mark_inactive)
    asyncio.run(svc._evict_instance_deployment("be-a"))
    assert calls == ["inactive:be-a"]
    assert svc._infra_driver.removed == ["cid-be-a"]  # container removed


def test_under_cap_is_noop(tmp_path, monkeypatch):
    conts = [_Container("copy-a-bp", "be-a", 100), _Container("copy-b-bp", "be-b", 200)]
    svc = _svc(tmp_path, cap=15, containers=conts)
    evicted: list[str] = []

    async def _evict(dep):
        evicted.append(dep)

    monkeypatch.setattr(svc, "_evict_instance_deployment", _evict)
    res = asyncio.run(svc.enforce_live_dev_cap())
    assert res["evicted"] == [] and evicted == []


def test_access_marker_beats_created_for_lru(tmp_path, monkeypatch):
    # a is oldest by container Created, but was just accessed (marker), so b
    # (older activity) is evicted instead. cap=1.
    conts = [_Container("copy-a-bp", "be-a", 100), _Container("copy-b-bp", "be-b", 200)]
    svc = _svc(tmp_path, cap=1, containers=conts)
    svc.touch_live_dev_access("copy-a-bp")  # a is now most-recently-active
    evicted: list[str] = []

    async def _evict(dep):
        evicted.append(dep)

    monkeypatch.setattr(svc, "_evict_instance_deployment", _evict)
    res = asyncio.run(svc.enforce_live_dev_cap())
    assert res["evicted"] == ["copy-b-bp"]  # b evicted, a kept (recently accessed)
    assert evicted == ["be-b"]


def test_wake_reactivates_and_redeploys(tmp_path, monkeypatch):
    # Evicted (removed) instance: no live containers → wake re-activates its
    # members and redeploys to recreate them, stamping activity.
    svc = _svc(tmp_path, cap=15, containers=[])  # nothing running (evicted)

    import app.services.automation_service as mod

    orig_read = mod.read_bitswan_yaml

    def _read(path):
        bs = orig_read(path) or {}
        bs.setdefault("deployments", {})["be-a"] = {
            "context": "copy-a-bp",
            "stage": "live-dev",
            "active": False,
        }
        return bs

    monkeypatch.setattr(mod, "read_bitswan_yaml", _read)
    activated: list[str] = []
    applied: list[list[str]] = []

    async def _mark_active(dep):
        activated.append(dep)

    async def _apply(ids, deployed_by=None, report=None):
        applied.append(list(ids))
        return {}

    monkeypatch.setattr(svc, "mark_as_active", _mark_active)
    monkeypatch.setattr(svc, "apply_compose_for_deployments", _apply)

    res = asyncio.run(svc.wake_live_dev("copy-a-bp"))
    assert activated == ["be-a"]  # re-activated
    assert applied == [["be-a"]]  # redeployed (recreates the removed container)
    assert res["deployment_ids"] == ["be-a"]
    assert os.path.exists(os.path.join(svc._live_dev_access_dir(), "copy-a-bp"))


def test_wake_hydrating_instance_is_touch_only(tmp_path, monkeypatch):
    # A running / mid-startup instance must NOT be disturbed (anti-flap + the
    # dashboard fires wake on every BP-load as an LRU touch).
    for state in ("running", "created"):
        conts = [_Container("copy-a-bp", "be-a", 100, state=state)]
        svc = _svc(tmp_path, cap=15, containers=conts)
        applied: list = []

        async def _apply(ids, deployed_by=None, report=None):
            applied.append(list(ids))

        monkeypatch.setattr(svc, "apply_compose_for_deployments", _apply)
        res = asyncio.run(svc.wake_live_dev("copy-a-bp"))
        assert res.get("already_running") is True
        assert applied == []  # not redeployed


def test_manual_sleep_evicts_stage_group(tmp_path, monkeypatch):
    # sleep_context_stage resolves a (context, stage) group's deployment_ids from
    # bitswan.yaml and evicts them (mark inactive + remove) — the manual power-off.
    svc = _svc(tmp_path, cap=15, containers=[])
    import app.services.automation_service as mod

    orig_read = mod.read_bitswan_yaml

    def _read(path):
        bs = orig_read(path) or {}
        deps = bs.setdefault("deployments", {})
        deps["be-shop-staging"] = {"context": "shop", "stage": "staging"}
        deps["fe-shop-staging"] = {"context": "shop", "stage": "staging"}
        deps["be-shop-dev"] = {"context": "shop", "stage": "dev"}  # other stage
        return bs

    monkeypatch.setattr(mod, "read_bitswan_yaml", _read)
    evicted: list[str] = []

    async def _evict(ids):
        evicted.extend(ids)
        return {"evicted": list(ids), "hosts": []}

    monkeypatch.setattr(svc, "evict_deployments", _evict)
    res = asyncio.run(svc.sleep_context_stage("shop", "staging"))
    # Only the staging members of context "shop" — never the dev one.
    assert set(res["slept"]) == {"be-shop-staging", "fe-shop-staging"}
    assert "be-shop-dev" not in evicted


def test_manual_wake_reactivates_stage_group(tmp_path, monkeypatch):
    # wake_context_stage re-activates + redeploys a (context, stage) group.
    svc = _svc(tmp_path, cap=15, containers=[])
    import app.services.automation_service as mod

    orig_read = mod.read_bitswan_yaml

    def _read(path):
        bs = orig_read(path) or {}
        bs.setdefault("deployments", {})["be-shop-staging"] = {
            "context": "shop",
            "stage": "staging",
            "active": False,
        }
        return bs

    monkeypatch.setattr(mod, "read_bitswan_yaml", _read)
    activated: list[str] = []
    applied: list[list[str]] = []

    async def _mark_active(dep):
        activated.append(dep)

    async def _apply(ids, deployed_by=None, report=None):
        applied.append(list(ids))
        return {}

    monkeypatch.setattr(svc, "mark_as_active", _mark_active)
    monkeypatch.setattr(svc, "apply_compose_for_deployments", _apply)
    res = asyncio.run(svc.wake_context_stage("shop", "staging"))
    assert activated == ["be-shop-staging"]
    assert applied == [["be-shop-staging"]]
    assert res["deployment_ids"] == ["be-shop-staging"]
