"""Image-baked deployments carry their source INSIDE the image, so a baked
promoted deployment has no legacy `<gitops_dir>/<checksum>/` tree on disk.
Its config (expose/port) must therefore resolve from the workspace source —
otherwise a frontend silently loses `expose` (no ingress URL → "Not deployed").
(The compose compilation itself now lives in the Go infra-driver.)"""

import os

import pytest


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

    s = asvc.AutomationService()
    os.makedirs(s.gitops_dir, exist_ok=True)
    return s


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
