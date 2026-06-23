"""Stage 1.5: BITSWAN_WORKER_HOSTS injection + the expose path no longer
wires a per-automation oauth2-proxy (expose_to is gone)."""

import os

import pytest
import yaml


@pytest.fixture
def gitops_home(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))
    monkeypatch.setenv("BITSWAN_WORKSPACE_NAME", "ws-test")
    monkeypatch.setenv("BITSWAN_GITOPS_DOMAIN", "example.com")
    return tmp_path


@pytest.fixture
def svc(gitops_home, monkeypatch):
    for var in (
        "KEYCLOAK_URL",
        "BITSWAN_WORKSPACE_ID",
        "BITSWAN_AOC_URL",
        "BITSWAN_AOC_TOKEN",
        "BITSWAN_CERTS_DIR",
    ):
        monkeypatch.delenv(var, raising=False)
    import app.services.automation_service as asvc

    # generate_docker_compose is pure now (it only COLLECTS desired routes; the
    # daemon is touched by the separate reconcile step), so no ingress stub is
    # needed for it to stay hermetic.
    s = asvc.AutomationService()
    os.makedirs(s.gitops_dir, exist_ok=True)
    return s


def _write_automation(svc, checksum: str, expose: bool, port: int = 8080):
    d = os.path.join(svc.gitops_dir, checksum)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "automation.toml"), "w") as f:
        f.write(f"[deployment]\nexpose = {str(expose).lower()}\nport = {port}\n")


def _services(svc, bs_yaml):
    dc = yaml.safe_load(svc.generate_docker_compose(bs_yaml)[0])
    return dc["services"]


def _bp(frontend_checksum, backend_checksum):
    return {
        "deployments": {
            "frontend-bp-dev": {
                "stage": "dev",
                "checksum": frontend_checksum,
                "relative_path": "BP/frontend",
                "automation_name": "frontend",
                "context": "bp",
            },
            "backend-bp-dev": {
                "stage": "dev",
                "checksum": backend_checksum,
                "relative_path": "BP/backend",
                "automation_name": "backend",
                "context": "bp",
            },
        }
    }


def test_worker_hosts_injected_into_all_containers(svc):
    _write_automation(svc, "fe", expose=True)
    _write_automation(svc, "be", expose=False, port=9000)
    services = _services(svc, _bp("fe", "be"))

    # Both the frontend and the worker learn the worker hosts; only the
    # worker (backend) is listed, at its own host:port.
    for name, entry in services.items():
        # The egress firewall gateway owns the worker's network namespace but is
        # NOT itself a worker — it carries no app and no BITSWAN_WORKER_HOSTS
        # (only its BITSWAN_FW_* config). Skip it.
        if (entry.get("labels") or {}).get("gitops.firewall_gateway") == "true":
            continue
        env = entry.get("environment", {})
        assert "BITSWAN_WORKER_HOSTS" in env, name
        hosts = env["BITSWAN_WORKER_HOSTS"]
        assert hosts.startswith("backend="), hosts
        assert hosts.endswith(":9000"), hosts
        # The exposed frontend is not itself a worker host.
        assert "frontend=" not in hosts


def test_expose_does_not_wire_oauth2_proxy(svc):
    _write_automation(svc, "fe", expose=True)
    _write_automation(svc, "be", expose=False)
    services = _services(svc, _bp("fe", "be"))

    for name, entry in services.items():
        env = entry.get("environment", {})
        oauth2 = [k for k in env if k.startswith("OAUTH2_PROXY")]
        assert not oauth2, f"{name} still wires oauth2-proxy: {oauth2}"


def test_workers_isolated_per_bp(svc):
    # A worker in another BP context must not leak into this BP's list.
    _write_automation(svc, "fe", expose=True)
    _write_automation(svc, "be", expose=False)
    _write_automation(svc, "other", expose=False)
    bs_yaml = _bp("fe", "be")
    bs_yaml["deployments"]["backend-otherbp-dev"] = {
        "stage": "dev",
        "checksum": "other",
        "relative_path": "OtherBP/backend",
        "automation_name": "backend",
        "context": "other-bp",
    }
    services = _services(svc, bs_yaml)
    # The frontend in "bp" sees only bp's backend (one entry).
    fe = next(e for n, e in services.items() if "frontend" in n)
    hosts = fe["environment"]["BITSWAN_WORKER_HOSTS"].split(",")
    assert len(hosts) == 1, hosts
