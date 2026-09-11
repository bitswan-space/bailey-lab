"""The container's start time reaches the dashboard, and its absence stays absent.

bailey-lab #476: an operator presses Restart and nothing outside the Activity
pane says so. The fix ends that "in flight" state on an OBSERVATION of the
container — but an operator's `docker restart` leaves the container id, the
creation time and the restart count exactly as they were, and the state is
`running` on either side of a window too short for the snapshot to sample. The
start time is the only field that moves, so without it a restart is literally
invisible on the wire (the test below pins that premise).

Absence has to survive too: the driver is a separate image and one older than
this field simply omits it, and a container created and never started has no
start time at all. Neither may arrive as 0 or as the epoch.
"""

from datetime import datetime, timezone

from app.models import DeployedAutomation
from app.services.automation_service import AutomationService
from app.services.infra_driver_client import (
    Container,
    InfraDriverClient,
    WorkspaceContext,
)

# 2026-09-10T18:26:13Z — the kind of value the driver sends (unix seconds).
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
    # Three ways it is absent: an older driver that does not send the field at
    # all, an inspect that lost its race, and a container created and never
    # started. None of them is 1970, and none of them is 0.
    c = Container.from_json(
        {"id": "abc", "name": "svc", "state": "created", "health": ""}
    )
    assert c.started_at is None
    assert c.to_docker_dict()["StartedAt"] is None


def test_overlay_stamps_an_aware_utc_datetime():
    # A naive datetime serialises with no offset, and the browser then reads it
    # as LOCAL time — so a UTC+2 operator would see a restart that happened a
    # second ago as two hours in the future, and the pending action would never
    # settle. (created_at beside it has this defect latent; nothing renders it.)
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
    """The premise of #476, pinned.

    A `docker restart` keeps the container id, the creation time and the restart
    count, and the state reads `running` both before and after. Two containers
    identical in every one of those and differing only in when they started must
    produce records that differ ONLY in `started_at` — otherwise the dashboard
    would have had some other field to watch, and this whole hop would be
    unnecessary.
    """
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
    # `deploy.replicas > 1` labels every replica with the SAME deployment id, so
    # the overlay visits one entry several times and the WORST state wins. The
    # record then describes that one container: its id, its creation time, its
    # count and its start time. Pairing the newest replica's start time with the
    # sick replica's id would report a restart of a container the row's own
    # Restart button never touched.
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
    # Blue-green production: the live slot's container is labelled with the bare
    # deployment id, a standby slot's with `<id>@<slot>`. The standby's record is
    # a model_copy of the live entry made DURING this pass, so an inherited start
    # time would read as "this standby has been up since Tuesday" for a
    # container that may not be running at all.
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
    """The driver ships as its own image and can be newer OR older than this
    code, and an unrecognised filter key is ignored rather than rejected. So the
    flag keeps the name it had when it fetched only a count: renaming it would
    make a NEW driver meeting an OLD gitops stop returning counts it reads
    perfectly well."""
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
