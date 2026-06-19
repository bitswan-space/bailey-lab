"""A single-BP deploy/promote regenerates the whole docker-compose (one file
per workspace), but it must only (re-)register the ingress routes of the
deployments it is actually applying — NOT every exposed frontend in the
workspace. Each daemon add-route is a ~1s Traefik round-trip done serially, so
re-registering the whole fleet on every promote dominated latency (~22s of a
~34s promote). `generate_docker_compose(ingress_scope=…)` bounds it.
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

    # Record every ingress registration (automation_name, context, stage).
    calls: list[tuple] = []

    def _record(automation_name, context, stage, port, **kwargs):
        calls.append((automation_name, context, stage))
        return True

    monkeypatch.setattr(asvc, "add_workspace_route_to_ingress", _record)
    s = asvc.AutomationService()
    os.makedirs(s.gitops_dir, exist_ok=True)
    s._ingress_calls = calls  # expose for assertions
    return s


def _exposed_frontend(svc, tmp_path, bp: str):
    """Materialize a baked frontend whose config (expose/port) is read from the
    workspace source, and return its deployment dict + id."""
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


def test_ingress_scope_limits_route_registration(svc, tmp_path):
    """With a scope of one deployment, only that deployment's route is
    registered — the other BP's frontend is left untouched."""
    id_a, dep_a = _exposed_frontend(svc, tmp_path, "bpa")
    id_b, dep_b = _exposed_frontend(svc, tmp_path, "bpb")
    bs = {"deployments": {id_a: dep_a, id_b: dep_b}}

    svc.generate_docker_compose(bs, ingress_scope={id_a})

    contexts = {c[1] for c in svc._ingress_calls}
    assert contexts == {"bpa"}, (
        f"scoped deploy re-registered routes outside its scope: {svc._ingress_calls}"
    )


def test_ingress_scope_none_registers_all(svc, tmp_path):
    """No scope (full-rebuild path) keeps the original behavior: every exposed
    frontend's route is registered."""
    id_a, dep_a = _exposed_frontend(svc, tmp_path, "bpa")
    id_b, dep_b = _exposed_frontend(svc, tmp_path, "bpb")
    bs = {"deployments": {id_a: dep_a, id_b: dep_b}}

    svc.generate_docker_compose(bs)  # ingress_scope=None

    contexts = {c[1] for c in svc._ingress_calls}
    assert contexts == {"bpa", "bpb"}
