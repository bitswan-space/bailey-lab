"""Deploy-lock lifecycle: a BP deploy must release its per-member locks however
it ends — success, error, OR cancellation — or every subsequent deploy of that
BP 409s ("already in progress") for the life of the process.

Regression for the Sync & Deploy 409: a deploy task whose body was cancelled
(asyncio.CancelledError is BaseException, not Exception, so the runner's
`except Exception` missed it) leaked its member locks, permanently blocking
re-deploys of the same business process.
"""

import asyncio

import pytest

from app.routes import automations as auto_routes
from app.deploy_manager import DeployManager


@pytest.fixture
def fresh_dm(monkeypatch):
    """Isolated deploy manager + no-op broadcaster wired into the runner."""
    dm = DeployManager()
    monkeypatch.setattr(auto_routes, "deploy_manager", dm)

    async def _noop_broadcast(*a, **k):
        return None

    monkeypatch.setattr(auto_routes.event_broadcaster, "broadcast", _noop_broadcast)
    return dm


class _CancelledDeploy:
    """Stands in for the automation service when the deploy is cancelled."""

    async def deploy_business_process(self, **kwargs):
        raise asyncio.CancelledError()


class _FailingDeploy:
    async def deploy_business_process(self, **kwargs):
        raise RuntimeError("boom")


_IDS = ["wraptest-jklj-frontend-dev", "wraptest-jklj-backend-dev"]


async def test_cancelled_bp_deploy_releases_member_locks(fresh_dm):
    """A cancelled BP deploy must free its member locks so the next deploy is
    not falsely rejected with a 409."""
    task, conflict = await fresh_dm.create_bp_task("jklj", _IDS)
    assert task is not None and conflict is None
    assert all(fresh_dm.is_deploying(i) for i in _IDS)

    # Cancellation propagates (cooperative), but the locks MUST be released.
    with pytest.raises(asyncio.CancelledError):
        await auto_routes._run_bp_deploy_with_progress(
            task.task_id,
            "jklj",
            _IDS,
            _CancelledDeploy(),
            stage="dev",
            copy=None,
            members=[],
        )

    assert not any(
        fresh_dm.is_deploying(i) for i in _IDS
    ), "cancelled deploy leaked its member locks → future deploys 409 forever"

    # The leak's real symptom: a fresh deploy of the same BP must succeed.
    task2, conflict2 = await fresh_dm.create_bp_task("jklj", _IDS)
    assert task2 is not None and conflict2 is None


async def test_failed_bp_deploy_releases_member_locks(fresh_dm):
    """A BP deploy that raises a normal error also frees its locks (regression
    guard alongside the cancellation case)."""
    task, _ = await fresh_dm.create_bp_task("jklj", _IDS)
    assert task is not None

    await auto_routes._run_bp_deploy_with_progress(
        task.task_id,
        "jklj",
        _IDS,
        _FailingDeploy(),
        stage="dev",
        copy=None,
        members=[],
    )

    assert not any(fresh_dm.is_deploying(i) for i in _IDS)
    task2, conflict2 = await fresh_dm.create_bp_task("jklj", _IDS)
    assert task2 is not None and conflict2 is None
