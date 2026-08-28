"""#378 — an automation deleted from a BP must be retired from its stage.

Reproduction from the issue: a BP was created with two frontends and deployed to
dev, then the second frontend was deleted from the source and the BP redeployed
to dev. `new-frontend` was still running on dev afterwards, and it took the BP's
backend down with it — the backend crash-looped on

    2026/08/17 12:07:19 listening on :8080
    2026/08/17 12:07:19 listen tcp :8080: bind: address already in use

Mechanism: `write_deployment_entries` is an UPSERT, and that map is the desired
state the infra driver compiles. A redeploy wrote the surviving members and left
the deleted one untouched, so the ghost stayed in the generated compose — never
an orphan for `retireOrphanedContainers` to reap — and kept running.

It then broke the survivors. With its source gone the driver cannot read the
ghost's automation.toml and falls back to the DEFAULT config (expose=false,
port 8080), so the deleted FRONTEND recompiled as a non-exposed worker: it
joined its firewall gateway's network namespace and bound the :8080 its image
hard-codes (the shim's port cannot be reassigned). The real backend then lost
the race for :8080 inside that shared netns.

The fix is `prune_scope`: a caller that enumerated a whole (context, stage)
scope declares it, and entries in that scope absent from `members` are retired.
These tests pin that it prunes exactly that scope — and that a partial deploy,
which must leave its siblings running, never prunes at all.
"""

import asyncio

import pytest

from app.services.automation_service import AutomationService
from app.utils import AutomationConfig


def _svc(tmp_path):
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    svc.secrets_dir = str(tmp_path / "secrets")
    svc.workspace_name = "ws"
    return svc


def _wire(svc, monkeypatch, state: dict):
    """Run write_deployment_entries against `state` in memory: no automation.toml
    to resolve, no git write, no infra side effects."""

    async def _resolve(dep):
        return AutomationConfig()

    monkeypatch.setattr(svc, "resolve_automation_config", _resolve)

    async def _noop(*a, **kw):
        return None

    monkeypatch.setattr(svc, "_persist_bp_state", _noop)
    monkeypatch.setattr(svc, "enable_services", _noop)
    monkeypatch.setattr(
        "app.services.automation_service.read_bitswan_yaml", lambda p: state
    )


def _entry(name, bp="shop", stage="dev", context=None):
    """A deployed entry as it sits in bitswan.yaml."""
    return {
        "automation_name": name,
        "context": bp if context is None else context,
        "stage": stage,
        "relative_path": f"copies/main/{bp}/{name}",
        "checksum": f"sha-{name}",
        "active": True,
    }


def _member(name, bp="shop", stage="dev", context=None):
    """The same automation as a freshly-prepped deploy member."""
    ctx = bp if context is None else context
    suffix = "" if stage == "production" else f"-{stage}"
    return {
        "deployment_id": f"{name}-{ctx}{suffix}",
        "automation_name": name,
        "context": ctx,
        "stage": stage,
        "relative_path": f"copies/main/{bp}/{name}",
        "checksum": f"sha-{name}",
    }


def _dep_ids(state):
    return set(state["deployments"])


def test_deleted_automation_is_retired_from_the_stage(tmp_path, monkeypatch):
    # The reported state: dev holds backend + frontend + the since-deleted
    # new-frontend, and the redeploy scans only the two survivors.
    state = {
        "deployments": {
            "backend-shop-dev": _entry("backend"),
            "frontend-shop-dev": _entry("frontend"),
            "new-frontend-shop-dev": _entry("new-frontend"),
        }
    }
    svc = _svc(tmp_path)
    _wire(svc, monkeypatch, state)

    asyncio.run(
        svc.write_deployment_entries(
            [_member("backend"), _member("frontend")], prune_scope=True
        )
    )

    assert _dep_ids(state) == {"backend-shop-dev", "frontend-shop-dev"}, (
        "the deleted automation's entry survived the redeploy — the driver will "
        "compile it into the desired compose and its container keeps running"
    )


def test_partial_deploy_never_prunes_its_siblings(tmp_path, monkeypatch):
    # Scaffolding one automation into a running BP deploys ONLY the new member
    # (routes/templates.py) — the rest of the BP is already running and must not
    # be disturbed. Pruning here would tear down the whole BP.
    state = {
        "deployments": {
            "backend-shop-dev": _entry("backend"),
            "frontend-shop-dev": _entry("frontend"),
        }
    }
    svc = _svc(tmp_path)
    _wire(svc, monkeypatch, state)

    # Default: no prune_scope.
    asyncio.run(svc.write_deployment_entries([_member("reporter")]))

    assert _dep_ids(state) == {
        "backend-shop-dev",
        "frontend-shop-dev",
        "reporter-shop-dev",
    }, "a partial deploy retired the siblings it was supposed to leave running"


def test_pruning_is_scoped_to_the_deployed_stage_bp_and_copy(tmp_path, monkeypatch):
    # Everything a dev deploy of `shop` must NOT touch: the same BP's other
    # stages, a copy's live-dev context, and another BP entirely.
    state = {
        "deployments": {
            "backend-shop-dev": _entry("backend"),
            "gone-shop-dev": _entry("gone"),
            "backend-shop-staging": _entry("backend", stage="staging"),
            "backend-shop": _entry("backend", stage=""),
            "backend-copy-alice-shop-live-dev": _entry(
                "backend", stage="live-dev", context="copy-alice-shop"
            ),
            "backend-warehouse-dev": _entry("backend", bp="warehouse"),
        }
    }
    svc = _svc(tmp_path)
    _wire(svc, monkeypatch, state)

    asyncio.run(svc.write_deployment_entries([_member("backend")], prune_scope=True))

    assert _dep_ids(state) == {
        "backend-shop-dev",
        "backend-shop-staging",
        "backend-shop",
        "backend-copy-alice-shop-live-dev",
        "backend-warehouse-dev",
    }, "pruning escaped the (context, stage) scope the members covered"


def test_production_entries_prune_within_their_own_stage(tmp_path, monkeypatch):
    # Production persists as stage "" — the scope key must normalize, or a
    # production-scoped write would either prune nothing or match "dev".
    state = {
        "deployments": {
            "backend-shop": _entry("backend", stage=""),
            "gone-shop": _entry("gone", stage=""),
            "backend-shop-dev": _entry("backend"),
        }
    }
    svc = _svc(tmp_path)
    _wire(svc, monkeypatch, state)

    asyncio.run(
        svc.write_deployment_entries(
            [_member("backend", stage="production")], prune_scope=True
        )
    )

    assert _dep_ids(state) == {"backend-shop", "backend-shop-dev"}


def test_context_less_member_prunes_nothing(tmp_path, monkeypatch):
    # A top-level automation (no bp path segment) has an empty context, so it
    # carries no BP scope — pruning on it would span every context-less
    # deployment in the workspace.
    state = {
        "deployments": {
            "loose-dev": {"automation_name": "loose", "context": "", "stage": "dev"},
            "other-dev": {"automation_name": "other", "context": "", "stage": "dev"},
        }
    }
    svc = _svc(tmp_path)
    _wire(svc, monkeypatch, state)

    m = _member("loose")
    m["context"] = ""
    m["deployment_id"] = "loose-dev"
    asyncio.run(svc.write_deployment_entries([m], prune_scope=True))

    assert _dep_ids(state) == {"loose-dev", "other-dev"}


def test_bp_deploy_asks_for_pruning(tmp_path, monkeypatch):
    """deploy_business_process must declare its member set complete — that is
    what makes the delete actually take effect in the reported flow."""
    svc = _svc(tmp_path)
    seen = {}

    async def _fake_deploy_source_set(**kw):
        seen.update(kw)
        return {"deployment_ids": [], "prepped": [], "result": {}}

    monkeypatch.setattr(svc, "deploy_source_set", _fake_deploy_source_set)

    async def _noop(*a, **kw):
        return None

    monkeypatch.setattr(svc, "write_bp_deploy", _noop)

    asyncio.run(
        svc.deploy_business_process(
            bp="shop", stage="dev", members=[_member("backend")]
        )
    )

    assert seen.get("prune_scope") is True


@pytest.mark.parametrize("skipped_member", [True, False])
def test_a_filtered_batch_does_not_prune(tmp_path, monkeypatch, skipped_member):
    """spawn_set_deploy drops members that are already deploying. Those are still
    wanted, so a filtered batch is no longer the complete scope and must not
    prune — otherwise a concurrent deploy has its deployment retired under it."""
    from app import deploy_runner

    svc = _svc(tmp_path)
    members = [_member("backend"), _member("frontend")]

    monkeypatch.setattr(
        svc, "deployment_id_for", lambda m, stage: m["deployment_id"], raising=False
    )
    monkeypatch.setattr(
        deploy_runner.deploy_manager,
        "is_deploying",
        lambda did: skipped_member and did == "frontend-shop-dev",
    )

    class _Task:
        task_id = "t1"

    async def _create(label, ids):
        return _Task(), None

    monkeypatch.setattr(deploy_runner.deploy_manager, "create_bp_task", _create)

    spawned = {}
    monkeypatch.setattr(
        deploy_runner,
        "_run_set_deploy_with_progress",
        lambda *a, **kw: spawned.update(kw) or _done(),
    )

    async def _done():
        return None

    res = asyncio.run(
        deploy_runner.spawn_set_deploy(
            label="shop",
            members=members,
            stage="dev",
            service=svc,
            prune_scope=True,
        )
    )

    assert res.get("deploy"), res
    assert spawned.get("prune_scope") is (
        not skipped_member
    ), "a batch with a member filtered out for being mid-deploy must not prune"
