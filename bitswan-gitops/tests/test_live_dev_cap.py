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
        out = []
        for c in self.containers:
            if labels and any(c.labels.get(k) != v for k, v in labels.items()):
                continue
            out.append(c)
        return out

    async def container_remove(self, ctx, cid):
        self.removed.append(cid)
        self.containers = [c for c in self.containers if c.id != cid]


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

    async def _evict(dep, reason="memory-pressure"):
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

    async def _evict(dep, reason="memory-pressure"):
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

    async def _evict(dep, reason="memory-pressure"):
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

    async def _evict(dep, reason="memory-pressure"):
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

    async def _evict(dep, reason="memory-pressure"):
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

    seen_reason: list[str] = []

    async def _evict(ids, reason="memory-pressure"):
        evicted.extend(ids)
        seen_reason.append(reason)
        return {"evicted": list(ids), "hosts": []}

    monkeypatch.setattr(svc, "evict_deployments", _evict)
    res = asyncio.run(svc.sleep_context_stage("shop", "staging"))
    # Only the staging members of context "shop" — never the dev one.
    assert set(res["slept"]) == {"be-shop-staging", "fe-shop-staging"}
    assert "be-shop-dev" not in evicted
    # A manual Sleep must reach eviction tagged "manual" (not the sweep default).
    assert seen_reason == ["manual"]


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


# ── Partially-evicted groups (#281) ──────────────────────────────────────────
# The daemon's memory sweep evicts only the members that were RUNNING and not
# always-on, so any stopped or always-on sibling is left behind. The wake path
# used to read both "is it up?" and "who belongs to it?" off the surviving
# CONTAINERS, so a survivor spoke for the whole group: the wake either declared
# the group already running or redeployed just the survivor, and the member the
# user was waiting on stayed active:false with no container — the gate's loading
# page then refreshed forever. Membership now comes from bitswan.yaml.


def _patch_members(monkeypatch, deployments: dict):
    """Point read_bitswan_yaml at a fixed deployments mapping."""
    import app.services.automation_service as mod

    monkeypatch.setattr(
        mod, "read_bitswan_yaml", lambda path: {"deployments": deployments}
    )


_GROUP = {
    "fe-a": {"context": "copy-a-bp", "stage": "live-dev", "active": False},
    "be-a": {"context": "copy-a-bp", "stage": "live-dev", "active": False},
    "wk-a": {"context": "copy-a-bp", "stage": "live-dev", "active": True},
}


def _wake_spy(svc, monkeypatch):
    activated: list[str] = []
    applied: list[list[str]] = []

    async def _mark_active(dep):
        activated.append(dep)

    async def _apply(ids, deployed_by=None, report=None):
        applied.append(sorted(ids))
        return {}

    monkeypatch.setattr(svc, "mark_as_active", _mark_active)
    monkeypatch.setattr(svc, "apply_compose_for_deployments", _apply)
    return activated, applied


def test_wake_revives_group_with_running_sibling(tmp_path, monkeypatch):
    # THE #281 case: fe + be were evicted (containers gone), the worker survived
    # RUNNING (it was always-on, or its removal failed). The running survivor must
    # not make the group look healthy — every member gets re-activated + redeployed.
    conts = [_Container("copy-a-bp", "wk-a", 100, state="running")]
    svc = _svc(tmp_path, cap=15, containers=conts)
    _patch_members(monkeypatch, _GROUP)
    activated, applied = _wake_spy(svc, monkeypatch)

    res = asyncio.run(svc.wake_live_dev("copy-a-bp", "live-dev"))

    assert res.get("already_running") is not True  # NOT mistaken for healthy
    assert sorted(res["woke"]) == ["be-a", "fe-a"]  # the two with no container
    assert sorted(activated) == ["be-a", "fe-a", "wk-a"]  # all members re-activated
    assert applied == [["be-a", "fe-a", "wk-a"]]  # whole group redeployed


def test_wake_revives_group_with_stopped_sibling(tmp_path, monkeypatch):
    # Same group, but the leftover sibling is EXITED rather than running. The old
    # code took its deployment_ids as the member list and woke only it.
    conts = [_Container("copy-a-bp", "wk-a", 100, state="exited")]
    svc = _svc(tmp_path, cap=15, containers=conts)
    _patch_members(monkeypatch, _GROUP)
    activated, applied = _wake_spy(svc, monkeypatch)

    res = asyncio.run(svc.wake_live_dev("copy-a-bp", "live-dev"))

    assert sorted(res["woke"]) == ["be-a", "fe-a", "wk-a"]  # exited counts as down
    assert sorted(activated) == ["be-a", "fe-a", "wk-a"]
    assert applied == [["be-a", "fe-a", "wk-a"]]


def test_wake_is_scoped_to_the_requested_stage(tmp_path, monkeypatch):
    # A context's dev and live-dev groups are independent. The live-dev group is
    # evicted while the dev group runs; waking live-dev must neither be fooled by
    # the running dev containers nor touch the dev members.
    conts = [_Container("shop", "fe-shop-dev", 100, stage="dev")]
    svc = _svc(tmp_path, cap=15, containers=conts)
    _patch_members(
        monkeypatch,
        {
            "fe-shop-dev": {"context": "shop", "stage": "dev", "active": True},
            "fe-shop-ld": {"context": "shop", "stage": "live-dev", "active": False},
        },
    )
    activated, applied = _wake_spy(svc, monkeypatch)

    res = asyncio.run(svc.wake_live_dev("shop", "live-dev"))

    assert res["stage"] == "live-dev"
    assert activated == ["fe-shop-ld"] and applied == [["fe-shop-ld"]]
    assert "fe-shop-dev" not in activated  # the other stage is left alone


def test_wake_without_stage_covers_every_ephemeral_stage(tmp_path, monkeypatch):
    # The BP-open route identifies a BP+copy, not an endpoint, so it passes no
    # stage and every ephemeral stage of the context is woken.
    svc = _svc(tmp_path, cap=15, containers=[])
    _patch_members(
        monkeypatch,
        {
            "fe-shop-dev": {"context": "shop", "stage": "dev"},
            "fe-shop-ld": {"context": "shop", "stage": "live-dev"},
            "fe-shop-stg": {"context": "shop", "stage": "staging"},  # protected
        },
    )
    activated, applied = _wake_spy(svc, monkeypatch)

    asyncio.run(svc.wake_live_dev("shop"))
    assert sorted(activated) == ["fe-shop-dev", "fe-shop-ld"]
    assert "fe-shop-stg" not in activated


def test_cap_eviction_does_not_cross_stages(tmp_path, monkeypatch):
    # A context running BOTH dev and live-dev is TWO instances against the cap;
    # evicting the oldest must take only that stage's members with it.
    conts = [
        _Container("shop", "fe-shop-ld", 100, stage="live-dev"),  # oldest
        _Container("shop", "fe-shop-dev", 300, stage="dev"),
    ]
    svc = _svc(tmp_path, cap=1, containers=conts)
    evicted_deps: list[str] = []

    async def _evict(dep, reason="memory-pressure"):
        evicted_deps.append(dep)

    monkeypatch.setattr(svc, "_evict_instance_deployment", _evict)
    res = asyncio.run(svc.enforce_live_dev_cap())

    assert res["running"] == 2  # two independent instances, not one merged context
    assert evicted_deps == ["fe-shop-ld"]  # the dev stage of the same BP survives


def test_wake_reports_redeploy_failure(tmp_path, monkeypatch):
    # A wake whose redeploy raises must say so in its result — the gate is
    # fire-and-forget, so a swallowed error read as success (cf. #314).
    svc = _svc(tmp_path, cap=15, containers=[])
    _patch_members(monkeypatch, {"fe-a": {"context": "copy-a-bp", "stage": "live-dev"}})

    async def _mark_active(dep):
        pass

    async def _boom(ids, deployed_by=None, report=None):
        raise RuntimeError("driver push rejected")

    monkeypatch.setattr(svc, "mark_as_active", _mark_active)
    monkeypatch.setattr(svc, "apply_compose_for_deployments", _boom)

    res = asyncio.run(svc.wake_live_dev("copy-a-bp", "live-dev"))
    assert "driver push rejected" in res["redeploy_error"]
    assert res.get("already_running") is not True


def test_unknown_context_says_it_did_nothing(tmp_path, monkeypatch):
    # Nothing to wake → a reason, not a bare empty success.
    svc = _svc(tmp_path, cap=15, containers=[])
    _patch_members(monkeypatch, {})
    res = asyncio.run(svc.wake_live_dev("copy-ghost-bp", "live-dev"))
    assert res["deployment_ids"] == [] and res["reason"]


def test_concurrent_wakes_apply_once(tmp_path, monkeypatch):
    # The loading page refreshes every 3s and the dashboard polls too, so wakes
    # overlap. They serialize per context and the queued one re-reads the group
    # state, finds it up, and does nothing — no stacked compose applies.
    svc = _svc(tmp_path, cap=15, containers=[])
    _patch_members(monkeypatch, {"fe-a": {"context": "copy-a-bp", "stage": "live-dev"}})
    applied: list[list[str]] = []

    async def _mark_active(dep):
        pass

    async def _apply(ids, deployed_by=None, report=None):
        await asyncio.sleep(0)  # yield, so the second waiter is definitely queued
        applied.append(sorted(ids))
        # the apply is what creates the containers
        svc._infra_driver.containers.append(_Container("copy-a-bp", "fe-a", 400))
        return {}

    monkeypatch.setattr(svc, "mark_as_active", _mark_active)
    monkeypatch.setattr(svc, "apply_compose_for_deployments", _apply)

    async def _both():
        return await asyncio.gather(
            svc.wake_live_dev("copy-a-bp", "live-dev"),
            svc.wake_live_dev("copy-a-bp", "live-dev"),
        )

    first, second = asyncio.run(_both())
    assert applied == [["fe-a"]]  # exactly one redeploy
    assert second.get("already_running") is True or first.get("already_running") is True
