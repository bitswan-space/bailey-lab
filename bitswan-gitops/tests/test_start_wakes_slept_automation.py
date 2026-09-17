import pytest
import yaml
from fastapi import HTTPException

from app.services.automation_service import AutomationService


def _svc(tmp_path, monkeypatch, *, active: bool):
    (tmp_path / "bitswan.yaml").write_text(
        yaml.safe_dump(
            {
                "deployments": {
                    "frontend-bp-staging": {
                        "active": active,
                        "automation_name": "frontend",
                        "context": "bp",
                        "stage": "staging",
                        "relative_path": "copies/main/bp/frontend",
                    }
                }
            }
        )
    )
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    svc.secrets_dir = str(tmp_path / "secrets")
    svc.workspace_name = "ws"

    async def _persist(bs_yaml, bps, dep_id, action):
        (tmp_path / "bitswan.yaml").write_text(yaml.safe_dump(bs_yaml))

    monkeypatch.setattr(svc, "_persist_bp_state", _persist)
    return svc


def _yaml(tmp_path):
    return yaml.safe_load((tmp_path / "bitswan.yaml").read_text())


async def test_start_wakes_a_slept_automation(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch, active=False)
    containers: list[dict] = []

    async def _get_container(dep_id):
        return list(containers)

    applied: list[list[str]] = []

    async def _apply(dep_ids, report=None):
        applied.append(list(dep_ids))
        if _yaml(tmp_path)["deployments"]["frontend-bp-staging"]["active"]:
            containers.append({"Id": "c1"})

    async def _deploy_everything():
        raise AssertionError(
            "waking one sleeping container must not redeploy the whole workspace"
        )

    monkeypatch.setattr(svc, "get_container", _get_container)
    monkeypatch.setattr(svc, "apply_compose_for_deployments", _apply)
    monkeypatch.setattr(svc, "deploy_automations", _deploy_everything)

    res = await svc.start_automation("frontend-bp-staging")

    assert _yaml(tmp_path)["deployments"]["frontend-bp-staging"]["active"] is True
    assert res["status"] == "success"
    assert containers, "Start reported success without creating a container"
    assert applied == [["frontend-bp-staging"]]


async def test_a_deploy_that_creates_nothing_is_not_reported_as_success(
    tmp_path, monkeypatch
):
    svc = _svc(tmp_path, monkeypatch, active=True)

    async def _get_container(dep_id):
        return []

    async def _deploy():
        return None

    monkeypatch.setattr(svc, "get_container", _get_container)
    monkeypatch.setattr(svc, "deploy_automations", _deploy)

    with pytest.raises(HTTPException) as e:
        await svc.start_automation("frontend-bp-staging")
    assert e.value.status_code == 500
    assert "no container came up" in e.value.detail


async def test_an_unknown_deployment_is_still_a_404(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch, active=True)

    async def _get_container(dep_id):
        return []

    monkeypatch.setattr(svc, "get_container", _get_container)
    with pytest.raises(HTTPException) as e:
        await svc.start_automation("nope-bp-staging")
    assert e.value.status_code == 404


async def test_a_failed_wake_leaves_the_deployment_asleep(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch, active=False)

    async def _get_container(dep_id):
        return []

    async def _apply(dep_ids, report=None):
        raise RuntimeError(
            "driver apply failed: docker compose up failed: exit status 1"
        )

    monkeypatch.setattr(svc, "get_container", _get_container)
    monkeypatch.setattr(svc, "apply_compose_for_deployments", _apply)

    with pytest.raises(HTTPException) as e:
        await svc.start_automation("frontend-bp-staging")
    assert e.value.status_code == 502
    assert "docker compose up failed" in e.value.detail
    assert _yaml(tmp_path)["deployments"]["frontend-bp-staging"]["active"] is False


async def test_restart_on_a_missing_container_wakes_it_too(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch, active=False)
    containers: list[dict] = []

    async def _get_container(dep_id):
        return list(containers)

    async def _apply(dep_ids, report=None):
        if _yaml(tmp_path)["deployments"]["frontend-bp-staging"]["active"]:
            containers.append({"Id": "c1"})

    async def _deploy_everything():
        raise AssertionError("Restart must not redeploy the whole workspace either")

    monkeypatch.setattr(svc, "get_container", _get_container)
    monkeypatch.setattr(svc, "apply_compose_for_deployments", _apply)
    monkeypatch.setattr(svc, "deploy_automations", _deploy_everything)

    res = await svc.restart_automation("frontend-bp-staging")
    assert res["status"] == "success"
    assert _yaml(tmp_path)["deployments"]["frontend-bp-staging"]["active"] is True
    assert containers
