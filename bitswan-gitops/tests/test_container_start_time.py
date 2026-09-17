from datetime import datetime, timezone

from app.models import DeployedAutomation
from app.services.automation_service import AutomationService
from app.services.infra_driver_client import (
    Container,
    InfraDriverClient,
    WorkspaceContext,
)

STARTED = 1789064773
LATER = 1789145412


def _entry(deployment_id: str) -> DeployedAutomation:
    return DeployedAutomation(
        container_id=None,
        endpoint_name=None,
        created_at=None,
        name=deployment_id,
        state=None,
        status=None,
        deployment_id=deployment_id,
        active=True,
        automation_url=None,
        relative_path=f"copies/alice/bp/{deployment_id}",
        stage="production",
    )


def _container(cid: str, dep: str, state: str = "running", **kw) -> dict:
    return Container(
        cid,
        f"wraptest-{dep}",
        state,
        "",
        "internal/backend:sha1",
        labels={"gitops.deployment_id": dep},
        **kw,
    ).to_docker_dict()


def test_driver_json_carries_the_start_time_through_to_the_docker_dict():
    c = Container.from_json(
        {
            "id": "abc",
            "name": "wraptest-backend-7622-production",
            "state": "running",
            "health": "",
            "image": "internal/backend:sha1",
            "started_at": STARTED,
        }
    )
    assert c.started_at == STARTED
    assert c.to_docker_dict()["StartedAt"] == STARTED


def test_a_start_time_the_driver_did_not_read_stays_none():
    c = Container.from_json(
        {"id": "abc", "name": "svc", "state": "created", "health": ""}
    )
    assert c.started_at is None
    assert c.to_docker_dict()["StartedAt"] is None


def test_overlay_stamps_an_aware_utc_datetime():
    svc = AutomationService()
    svc.workspace_name = "wraptest"
    entries = [_entry("backend-7622-production")]
    svc._apply_docker_overlay(
        entries,
        [_container("abc", "backend-7622-production", started_at=STARTED)],
        {},
        {},
    )
    got = entries[0].started_at
    assert got == datetime.fromtimestamp(STARTED, tz=timezone.utc)
    assert got.tzinfo is not None, "a naive start time is read as browser-local"
    assert entries[0].model_dump(mode="json")["started_at"].endswith("Z")


def test_overlay_leaves_an_unread_start_time_none():
    svc = AutomationService()
    svc.workspace_name = "wraptest"
    entries = [_entry("backend-7622-staging")]
    svc._apply_docker_overlay(
        entries, [_container("def", "backend-7622-staging")], {}, {}
    )
    assert entries[0].state == "running"
    assert entries[0].started_at is None


def test_a_restart_is_invisible_in_the_snapshot_without_it():
    svc = AutomationService()
    svc.workspace_name = "wraptest"
    dep = "backend-7622-production"

    before = [_entry(dep)]
    svc._apply_docker_overlay(
        before,
        [
            _container(
                "abc", dep, restart_count=0, created=1789000000, started_at=STARTED
            )
        ],
        {},
        {},
    )
    after = [_entry(dep)]
    svc._apply_docker_overlay(
        after,
        [_container("abc", dep, restart_count=0, created=1789000000, started_at=LATER)],
        {},
        {},
    )

    a = before[0].model_dump()
    b = after[0].model_dump()
    assert {k for k in a if a[k] != b[k]} == {"started_at"}
    assert b["started_at"] > a["started_at"]


def test_the_winning_replica_owns_its_own_start_time():
    svc = AutomationService()
    svc.workspace_name = "wraptest"
    dep = "backend-7622-production"
    entries = [_entry(dep)]
    svc._apply_docker_overlay(
        entries,
        [
            _container("healthy", dep, "running", started_at=LATER),
            _container("sick", dep, "restarting", started_at=STARTED),
        ],
        {},
        {},
    )
    assert entries[0].state == "restarting"
    assert entries[0].container_id == "sick"
    assert entries[0].started_at == datetime.fromtimestamp(STARTED, tz=timezone.utc)


def test_a_standby_slot_does_not_inherit_the_live_slot_start_time():
    svc = AutomationService()
    svc.workspace_name = "wraptest"
    dep = "backend-7622-production"
    entries = [_entry(dep)]
    svc._apply_docker_overlay(
        entries,
        [
            _container("live", dep, "running", started_at=STARTED),
            Container(
                "standby",
                f"wraptest-{dep}-green",
                "exited",
                "",
                "internal/backend:sha1",
                labels={"gitops.deployment_id": f"{dep}@green"},
            ).to_docker_dict(),
        ],
        {},
        {},
    )
    live = next(e for e in entries if e.deployment_id == dep)
    standby = next(e for e in entries if e.deployment_id == f"{dep}@green")
    assert live.started_at == datetime.fromtimestamp(STARTED, tz=timezone.utc)
    assert standby.started_at is None


async def test_the_wire_key_for_the_inspect_is_frozen():
    sent: list[dict] = []

    client = InfraDriverClient(
        base_url="http://driver:9090", token="t", deploy_remote_base="/tmp/deploy-repos"
    )

    async def _fake_post(path: str, body: dict) -> dict:
        sent.append(body)
        return {"containers": []}

    client._post_json = _fake_post
    ctx = WorkspaceContext(
        workspace_name="ws", domain="", gitops_dir="", secrets_dir=""
    )
    await client.container_list(
        ctx, labels={"gitops.workspace": "ws"}, with_restart_counts=True
    )

    assert sent[0]["filter"]["with_restart_counts"] is True
