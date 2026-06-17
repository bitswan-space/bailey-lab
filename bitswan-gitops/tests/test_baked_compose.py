"""Image-baked deployments carry their source INSIDE the image, so
`generate_docker_compose` must NOT require the legacy materialized
`<gitops_dir>/<checksum>/` tree on disk for them. (Regression: a fresh
baked dev deploy used to 500 with "Deployment directory ... does not
exist", which also broke the auto-redeploy-on-sync path.)"""

import os

import pytest
import yaml


@pytest.fixture
def svc(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))
    monkeypatch.setenv("BITSWAN_WORKSPACE_NAME", "ws-test")
    monkeypatch.setenv("BITSWAN_GITOPS_DOMAIN", "example.com")
    for var in (
        "KEYCLOAK_URL",
        "BITSWAN_WORKSPACE_ID",
        "BITSWAN_AOC_URL",
        "BITSWAN_AOC_TOKEN",
        "BITSWAN_CERTS_DIR",
    ):
        monkeypatch.delenv(var, raising=False)
    import app.services.automation_service as asvc

    monkeypatch.setattr(asvc, "add_workspace_route_to_ingress", lambda *a, **k: True)
    s = asvc.AutomationService()
    os.makedirs(s.gitops_dir, exist_ok=True)
    return s


def _baked_bp(image_tag):
    return {
        "deployments": {
            "backend-bp-dev": {
                "stage": "dev",
                # A checksum whose <gitops_dir>/<checksum>/ dir is deliberately
                # absent — exactly the state a fresh image-baked deploy leaves.
                "checksum": "0" * 40,
                "image": image_tag,
                "image_id": "sha256:deadbeef",
                "relative_path": "BP/backend",
                "automation_name": "backend",
                "context": "bp",
            },
        }
    }


def test_baked_deploy_does_not_require_materialized_dir(svc):
    image_tag = "internal/ws-test-bp-backend-app:sha0000"
    # Previously raised HTTPException 500 ("Deployment directory ... does not
    # exist"); now it composes fine and uses the baked image.
    dc_yaml, _ = svc.generate_docker_compose(_baked_bp(image_tag))
    services = yaml.safe_load(dc_yaml)["services"]
    assert any(e.get("image") == image_tag for e in services.values())


def test_unbaked_deploy_still_requires_materialized_dir(svc):
    """The relaxation is scoped to baked images — a legacy (image-less) dev
    deployment whose tree is missing must still fail loudly, not silently run
    the wrong thing."""
    import fastapi

    bs = {
        "deployments": {
            "backend-bp-dev": {
                "stage": "dev",
                "checksum": "f" * 40,  # no dir, and no baked image
                "relative_path": "BP/backend",
                "automation_name": "backend",
                "context": "bp",
            },
        }
    }
    with pytest.raises(fastapi.HTTPException):
        svc.generate_docker_compose(bs)


def test_resolve_config_falls_back_to_workspace_for_baked(svc, tmp_path):
    """A baked promoted deployment has no <gitops_dir>/<checksum>/ tree, so its
    config (expose/port) must come from the workspace source — otherwise a
    frontend silently loses `expose` (no ingress URL → "Not deployed")."""
    ws = tmp_path / "ws"
    auto = ws / "copies" / "main" / "bp" / "frontend"
    auto.mkdir(parents=True)
    (auto / "automation.toml").write_text("[deployment]\nexpose = true\nport = 5173\n")
    svc.workspace_repo_dir = str(ws)

    conf = {
        "stage": "dev",
        "checksum": "0" * 40,  # no blob dir on disk
        "relative_path": "copies/main/bp/frontend",
    }
    cfg = svc.resolve_automation_config(conf)
    assert cfg.expose is True
