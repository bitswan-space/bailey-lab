"""The restart count reaches the dashboard, and its absence stays absent.

bailey-lab #463: a container crashlooping for two months (RestartCount 23,032)
was indistinguishable from a healthy one. The count is the durable evidence a
status dot cannot carry, so it has to survive every hop — and, just as
importantly, an unread count must never arrive as 0, which would read as "this
container has never died".
"""

from app.models import DeployedAutomation
from app.services.automation_service import AutomationService
from app.services.infra_driver_client import Container


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


def test_driver_json_carries_the_count_through_to_the_docker_dict():
    c = Container.from_json(
        {
            "id": "abc",
            "name": "wraptest-backend-7622-production-green",
            "state": "restarting",
            "health": "",
            "image": "internal/backend:sha1",
            "restart_count": 23032,
        }
    )
    assert c.restart_count == 23032
    assert c.to_docker_dict()["RestartCount"] == 23032


def test_a_count_the_driver_did_not_read_stays_none_not_zero():
    # "Absent" is what an unread count looks like — the container vanished
    # under the inspect, or its line was unreadable — and it must not be
    # confused with a container that has never restarted.
    c = Container.from_json(
        {"id": "abc", "name": "svc", "state": "running", "health": "healthy"}
    )
    assert c.restart_count is None
    assert c.to_docker_dict()["RestartCount"] is None


def test_overlay_stamps_the_count_on_the_automation():
    svc = AutomationService()
    svc.workspace_name = "wraptest"
    entries = [_entry("backend-7622-production")]
    containers = [
        Container(
            "abc",
            "wraptest-backend-7622-production",
            "restarting",
            "",
            "internal/backend:sha1",
            labels={"gitops.deployment_id": "backend-7622-production"},
            restart_count=23032,
        ).to_docker_dict()
    ]
    svc._apply_docker_overlay(entries, containers, {}, {})
    assert entries[0].state == "restarting"
    assert entries[0].restart_count == 23032


def test_overlay_leaves_an_unread_count_none():
    svc = AutomationService()
    svc.workspace_name = "wraptest"
    entries = [_entry("backend-7622-staging")]
    containers = [
        Container(
            "def",
            "wraptest-backend-7622-staging",
            "running",
            "",
            "internal/backend:sha1",
            labels={"gitops.deployment_id": "backend-7622-staging"},
        ).to_docker_dict()
    ]
    svc._apply_docker_overlay(entries, containers, {}, {})
    assert entries[0].state == "running"
    assert entries[0].restart_count is None
