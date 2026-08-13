"""write_deployment_entries must resolve automation.toml from THIS deploy's
pinned source, not the previous one.

The entry's `source_commit` is the only handle on "what shipped" for an
image-baked deployment (its <gitops_dir>/<checksum> blob tree is gone — the
source lives inside the image). It used to be assigned AFTER the
resolve_automation_config calls that persist `memory_reservation`,
`memory_reservation_policy` and `services`, so those were resolved against the
commit of the deploy BEFORE this one. Every automation.toml change to them
landed one deploy late: raising memory-reservation from 128 to 256 and
redeploying persisted 128, and a second no-op deploy was needed to pick it up.
"""

import asyncio

from app.services.automation_service import AutomationService
from app.utils import AutomationConfig


def _svc(tmp_path):
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    svc.secrets_dir = str(tmp_path / "secrets")
    svc.workspace_name = "ws"
    return svc


# automation.toml as of each commit of the automation's source.
_AT_COMMIT = {
    "commit-old": AutomationConfig(memory_reservation=128, memory_reservation_policy="on-demand"),
    "commit-new": AutomationConfig(memory_reservation=256, memory_reservation_policy="always-on"),
}


def _wire(svc, monkeypatch, resolved: list[str]):
    """Stub resolve_automation_config to answer from dep['source_commit'], the
    way the real one does for an image-baked deployment, and record which commit
    each call was answered against."""

    async def _resolve(dep):
        commit = (dep or {}).get("source_commit") or "commit-old"
        resolved.append(commit)
        return _AT_COMMIT.get(commit, AutomationConfig())

    monkeypatch.setattr(svc, "resolve_automation_config", _resolve)

    # Neutralize the write/commit + infra side effects; we only assert on the
    # entry this method builds.
    async def _noop(*a, **kw):
        return None

    monkeypatch.setattr(svc, "auto_enable_services_for_members", _noop, raising=False)
    for name in ("write_bitswan_yaml_and_commit", "_write_and_commit_bitswan"):
        if hasattr(svc, name):
            monkeypatch.setattr(svc, name, _noop)


def _member(commit: str) -> dict:
    """An image-baked dev member — no explicit memory_reservation, so the value
    must come from automation.toml at `commit`."""
    return {
        "deployment_id": "backend-bp-dev",
        "automation_name": "backend",
        "context": "bp",
        "stage": "dev",
        "relative_path": "copies/main/bp/backend",
        "checksum": "sha-new",
        "image": "internal/bp-backend:sha-new",
        "image_id": "sha256:abc",
        "source_commit": commit,
    }


def test_reservation_comes_from_this_deploys_commit(tmp_path, monkeypatch):
    svc = _svc(tmp_path)
    resolved: list[str] = []
    _wire(svc, monkeypatch, resolved)

    # The entry already exists from an earlier deploy pinned to commit-old —
    # exactly the state a redeploy-after-editing-automation.toml starts from.
    existing = {
        "deployments": {
            "backend-bp-dev": {
                "source_commit": "commit-old",
                "memory_reservation": 128,
                "memory_reservation_policy": "on-demand",
            }
        }
    }
    monkeypatch.setattr(
        "app.services.automation_service.read_bitswan_yaml", lambda p: existing
    )

    asyncio.run(svc.write_deployment_entries([_member("commit-new")]))

    dep = existing["deployments"]["backend-bp-dev"]
    assert resolved and resolved[0] == "commit-new", (
        f"config resolved against {resolved[0]!r} — the entry's source_commit must "
        "be updated BEFORE automation.toml is read"
    )
    assert dep["memory_reservation"] == 256  # the edited value, not 128
    assert dep["memory_reservation_policy"] == "always-on"
    assert dep["source_commit"] == "commit-new"


def test_explicit_member_value_still_wins(tmp_path, monkeypatch):
    # An explicit member reservation short-circuits automation.toml entirely
    # (promote passes one through); the reorder must not change that.
    svc = _svc(tmp_path)
    resolved: list[str] = []
    _wire(svc, monkeypatch, resolved)
    existing = {"deployments": {}}
    monkeypatch.setattr(
        "app.services.automation_service.read_bitswan_yaml", lambda p: existing
    )

    m = _member("commit-new") | {
        "memory_reservation": 1024,
        "memory_reservation_policy": "always-on",
        "services": {},
    }
    asyncio.run(svc.write_deployment_entries([m]))

    dep = existing["deployments"]["backend-bp-dev"]
    assert dep["memory_reservation"] == 1024  # the explicit value, untouched
    assert dep["memory_reservation_policy"] == "always-on"
    # Whatever else in this method resolves the automation config (the trailing
    # service auto-enable does), it must never be answered against a stale commit.
    assert set(resolved) <= {"commit-new"}
