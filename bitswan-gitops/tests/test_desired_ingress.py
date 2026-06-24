"""generate_docker_compose is PURE: it never calls the daemon — it COLLECTS the
desired ingress route set (one per exposed automation) and returns it as the 3rd
value. apply then reconciles that set against the daemon. This replaces the old
imperative per-deployment add-route side effect (and the ingress_scope hack):
the desired routes are a deterministic function of bitswan.yaml.
"""

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


def _exposed_frontend(svc, tmp_path, bp: str):
    ws = tmp_path / "ws"
    auto = ws / "copies" / "main" / bp / "frontend"
    auto.mkdir(parents=True, exist_ok=True)
    (auto / "automation.toml").write_text("[deployment]\nexpose = true\nport = 5173\n")
    svc.workspace_repo_dir = str(ws)
    dep_id = f"frontend-{bp}-dev"
    return dep_id, {
        "stage": "dev",
        "checksum": "0" * 40,  # no materialized dir → baked path
        "image": f"internal/ws-test-{bp}-frontend-app:sha0000",
        "image_id": "sha256:deadbeef",
        "relative_path": f"copies/main/{bp}/frontend",
        "automation_name": "frontend",
        "context": bp,
    }


def test_collects_a_route_per_exposed_automation(svc, tmp_path):
    """The desired set has one route per exposed frontend, with a hostname and
    an upstream — and generation makes no daemon call."""
    id_a, dep_a = _exposed_frontend(svc, tmp_path, "bpa")
    id_b, dep_b = _exposed_frontend(svc, tmp_path, "bpb")
    bs = {"deployments": {id_a: dep_a, id_b: dep_b}}

    _dc, _infra, routes = svc.generate_docker_compose(bs)

    assert len(routes) == 2, f"expected one route per frontend, got {routes}"
    assert {r["stage"] for r in routes} == {"dev"}
    assert all(r["kind"] == "frontend" for r in routes)
    # Two distinct frontends → two distinct hosts and two distinct upstreams
    # (hostnames are hashed/truncated, so compare for distinctness, not substrings).
    assert len({r["hostname"] for r in routes}) == 2
    assert len({r["upstream"] for r in routes}) == 2
    assert all(r["upstream"] and r["hostname"] for r in routes)


def test_unexposed_automation_has_no_route(svc, tmp_path):
    """A worker (expose=false) contributes no ingress route."""
    ws = tmp_path / "ws"
    auto = ws / "copies" / "main" / "bpw" / "backend"
    auto.mkdir(parents=True, exist_ok=True)
    (auto / "automation.toml").write_text("[deployment]\nexpose = false\n")
    svc.workspace_repo_dir = str(ws)
    bs = {
        "deployments": {
            "backend-bpw-dev": {
                "stage": "dev",
                "checksum": "0" * 40,
                "image": "internal/ws-test-bpw-backend-app:sha0",
                "image_id": "sha256:dead",
                "relative_path": "copies/main/bpw/backend",
                "automation_name": "backend",
                "context": "bpw",
            }
        }
    }
    _dc, _infra, routes = svc.generate_docker_compose(bs)
    assert routes == []
