"""Issue #134: tenant-supplied `checksum` / `relative_path` must not escape.

`POST /automations/{id}/deploy` writes `checksum` / `relative_path` verbatim
into bitswan.yaml, bypassing the realpath+containment check on the normal
`prep_deploy_source` path. The infra driver joins those strings onto its
gitops / workspace roots to build read-only bind-mount SOURCES, so a `../..`
value would make the driver (which holds the docker socket) mount an
arbitrary host path into a driver-managed container.

These tests pin the write-time gate: the deploy route / `deploy_automation`
must reject escaping values with a 400 before anything reaches bitswan.yaml.
(The driver independently re-checks the same invariant when compiling the
mount — see the Go tests in
bitswan-automation-server/internal/infradriver/dockerdriver.)
"""

import os

import pytest
from fastapi import HTTPException

from app.services.automation_service import AutomationService


@pytest.fixture
def svc(tmp_path):
    svc = AutomationService()
    gitops = tmp_path / "gitops"
    ws = tmp_path / "workspace-repo"
    outside = tmp_path / "outside"
    gitops.mkdir()
    ws.mkdir()
    outside.mkdir()
    svc.gitops_dir = str(gitops)
    svc.gitops_dir_host = str(gitops)
    svc.workspace_repo_dir = str(ws)
    return svc


def _expect_400(svc, **kwargs):
    with pytest.raises(HTTPException) as ei:
        svc.validate_deploy_source_refs(**kwargs)
    assert ei.value.status_code == 400
    return ei.value


def test_dotdot_checksum_rejected(svc):
    err = _expect_400(svc, checksum="../outside")
    assert "checksum" in err.detail


def test_deep_traversal_checksum_rejected(svc):
    _expect_400(svc, checksum="../../../../../../etc")


def test_absolute_checksum_rejected(svc):
    # os.path.join(root, "/etc") == "/etc" — an absolute checksum replaces
    # the root entirely and must be rejected.
    _expect_400(svc, checksum="/etc")


def test_gitops_root_itself_rejected(svc):
    # "." resolves to the gitops root — which holds every other deployment's
    # tree — never a valid per-deployment source.
    _expect_400(svc, checksum=".")


def test_symlinked_checksum_rejected(svc, tmp_path):
    # Lexically contained, but the realpath escapes via a planted symlink.
    os.symlink(str(tmp_path / "outside"), os.path.join(svc.gitops_dir, "evil"))
    _expect_400(svc, checksum="evil")


def test_dotdot_relative_path_rejected(svc):
    err = _expect_400(svc, relative_path="../outside")
    assert err.detail == "Source escapes workspace"


def test_absolute_relative_path_rejected(svc):
    _expect_400(svc, relative_path="/etc")


def test_legitimate_values_accepted(svc):
    # Normal deploys: a tree-hash checksum, the live-dev sentinel, and a
    # copies/<copy>/<bp> relative path must all pass unchanged.
    svc.validate_deploy_source_refs(checksum="deadbeefcafe")
    svc.validate_deploy_source_refs(checksum="live-dev")
    svc.validate_deploy_source_refs(relative_path="copies/main/acme/frontend")
    svc.validate_deploy_source_refs(
        checksum="deadbeefcafe", relative_path="acme/frontend"
    )
    svc.validate_deploy_source_refs(checksum=None, relative_path=None)


async def test_deploy_automation_rejects_before_writing_yaml(svc, tmp_path):
    """The service-level gate fires before bitswan.yaml is touched — covering
    every caller (deploy route, agent routes), not just the HTTP route."""
    with pytest.raises(HTTPException) as ei:
        await svc.deploy_automation(
            deployment_id="app-dev",
            checksum="../../outside",
            stage="dev",
        )
    assert ei.value.status_code == 400
    assert not os.path.exists(os.path.join(svc.gitops_dir, "bitswan.yaml"))


async def test_deploy_route_rejects_traversal_synchronously(svc):
    """The route 400s before a deploy task is even created."""
    from app.routes import automations as auto_routes

    with pytest.raises(HTTPException) as ei:
        await auto_routes.deploy_automation(
            deployment_id="app-dev",
            checksum="../../../../etc",
            stage="dev",
            relative_path=None,
            services=None,
            replicas=None,
            deployed_by=None,
            automation_name_field=None,
            context_field=None,
            automation_service=svc,
        )
    assert ei.value.status_code == 400
    assert not auto_routes.deploy_manager.is_deploying("app-dev")


async def test_deploy_route_rejects_escaping_relative_path(svc):
    from app.routes import automations as auto_routes

    with pytest.raises(HTTPException) as ei:
        await auto_routes.deploy_automation(
            deployment_id="app-live-dev",
            checksum=None,
            stage="live-dev",
            relative_path="../../etc",
            services=None,
            replicas=None,
            deployed_by=None,
            automation_name_field=None,
            context_field=None,
            automation_service=svc,
        )
    assert ei.value.status_code == 400
    assert not auto_routes.deploy_manager.is_deploying("app-live-dev")
