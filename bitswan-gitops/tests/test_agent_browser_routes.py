"""The coding agent's browser relay (#210).

gitops holds no authority here — the daemon decides who the test identities are
and whether an endpoint may be browsed. What gitops owns, and what these tests
pin, is the part only it knows: which deployment the agent means, the hostname
that deployment is published at, that a sleeping instance is woken before a
browser arrives, and that a refusal from the daemon reaches the agent as the
refusal it was rather than a generic gateway error.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.routes.agent as agent_routes
from app.dependencies import get_automation_service
from app.utils import DaemonAgentBrowserError

TOKEN = "test-agent-secret"
DOMAIN = "tp-sandbox.bswn.io"
WORKSPACE = "demo"
LIVE_DEV_ID = "frontend-copy-alice-invoices-live-dev"


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("BITSWAN_GITOPS_AGENT_SECRET", TOKEN)
    monkeypatch.setenv("BITSWAN_GITOPS_DOMAIN", DOMAIN)
    monkeypatch.setenv("BITSWAN_WORKSPACE_NAME", WORKSPACE)
    monkeypatch.setattr(agent_routes, "_cached_agent_secret", TOKEN, raising=False)
    monkeypatch.setattr(agent_routes, "_resolve_agent_secret", lambda: TOKEN)
    monkeypatch.setattr(
        agent_routes,
        "_scan_automations",
        lambda copy=None: [
            {
                "deployment_id": LIVE_DEV_ID,
                "automation_name": "frontend",
                "context": "copy-alice-invoices",
                "stage": "live-dev",
                "relative_path": "copies/alice/invoices/frontend",
                "copy": "alice",
            }
        ],
    )
    api = FastAPI()
    api.include_router(agent_routes.router)
    with TestClient(api) as c:
        c.app = api
        yield c


def auth():
    return {"Authorization": f"Bearer {TOKEN}"}


class _Waker:
    """Stands in for the automation service, recording what got woken."""

    def __init__(self):
        self.woke = []

    async def wake_live_dev(self, context, stage=None):
        self.woke.append((context, stage))
        return {"context": context}


@pytest.fixture()
def waker(client):
    w = _Waker()
    # The route takes the service through Depends, so the override has to go on
    # the app; patching the module attribute is resolved too late to matter.
    client.app.dependency_overrides[get_automation_service] = lambda: w
    return w


def stub_daemon(monkeypatch, handler):
    monkeypatch.setattr(agent_routes, "daemon_agent_browser", handler)


def test_session_resolves_the_deployment_to_its_public_hostname(
    client, waker, monkeypatch
):
    seen = {}

    def handler(method, path, *, params=None, json_body=None):
        seen["method"], seen["path"], seen["body"] = method, path, json_body
        return {
            "cookie_name": "_bailey_agent",
            "cookie_value": "abc",
            "url": "https://x/",
        }

    stub_daemon(monkeypatch, handler)
    r = client.post(
        "/agent/browser/session",
        json={"label": "reviewer", "deployment_id": LIVE_DEV_ID},
        headers=auth(),
    )
    assert r.status_code == 200, r.text
    # The hostname the daemon is asked about must be the one a person visits;
    # anything else and the session would be minted for an endpoint the browser
    # never reaches.
    assert seen["body"]["endpoint_host"].endswith("." + DOMAIN)
    assert seen["body"]["endpoint_host"].startswith(WORKSPACE + "-frontend-")
    assert seen["body"]["endpoint_host"].endswith("-live-dev." + DOMAIN)
    assert seen["body"]["label"] == "reviewer"
    assert r.json()["deployment_id"] == LIVE_DEV_ID


def test_session_wakes_a_sleeping_instance_first(client, waker, monkeypatch):
    stub_daemon(monkeypatch, lambda *a, **k: {"cookie_value": "abc"})
    client.post(
        "/agent/browser/session",
        json={"label": "reviewer", "deployment_id": LIVE_DEV_ID},
        headers=auth(),
    )
    # A browser arriving at a sleeping live-dev instance sees the platform's
    # loading page, which the agent would report as a bug in the app.
    assert waker.woke == [("copy-alice-invoices", "live-dev")]


def test_only_live_dev_deployments_can_be_browsed(client, waker, monkeypatch):
    called = []
    stub_daemon(monkeypatch, lambda *a, **k: called.append(a) or {})
    r = client.post(
        "/agent/browser/session",
        json={"label": "reviewer", "deployment_id": "frontend-invoices-production"},
        headers=auth(),
    )
    assert r.status_code == 400
    assert "live-dev" in r.json()["detail"]
    # Refused at the edge, before the daemon is troubled at all.
    assert called == []


def test_an_unknown_deployment_is_a_404(client, waker, monkeypatch):
    stub_daemon(monkeypatch, lambda *a, **k: {})
    r = client.post(
        "/agent/browser/session",
        json={"label": "reviewer", "deployment_id": "ghost-copy-alice-x-live-dev"},
        headers=auth(),
    )
    assert r.status_code == 404


def test_the_daemons_refusal_reaches_the_agent_verbatim(client, waker, monkeypatch):
    def handler(*a, **k):
        raise DaemonAgentBrowserError(
            403, "the coding agent may only browse live-dev deployments"
        )

    stub_daemon(monkeypatch, handler)
    r = client.post(
        "/agent/browser/session",
        json={"label": "reviewer", "deployment_id": LIVE_DEV_ID},
        headers=auth(),
    )
    # The agent acts on the reason, so flattening every refusal into a 502 would
    # leave it guessing.
    assert r.status_code == 403
    assert "live-dev" in r.json()["detail"]


def test_an_unreachable_daemon_is_a_502(client, waker, monkeypatch):
    def handler(*a, **k):
        raise OSError("socket is gone")

    stub_daemon(monkeypatch, handler)
    r = client.post(
        "/agent/browser/session",
        json={"label": "reviewer", "deployment_id": LIVE_DEV_ID},
        headers=auth(),
    )
    assert r.status_code == 502


def test_identities_are_scoped_to_this_workspace(client, monkeypatch):
    seen = {}

    def handler(method, path, *, params=None, json_body=None):
        seen["params"], seen["body"] = params, json_body
        return {"identities": []}

    stub_daemon(monkeypatch, handler)
    assert client.get("/agent/browser/identities", headers=auth()).status_code == 200
    assert seen["params"] == {"workspace": WORKSPACE}

    client.post(
        "/agent/browser/identities",
        json={"label": "reviewer", "groups": ["/Acme", "/Acme/admin"]},
        headers=auth(),
    )
    assert seen["body"]["workspace"] == WORKSPACE
    assert seen["body"]["groups"] == ["/Acme", "/Acme/admin"]


def test_the_browser_api_needs_the_agent_token(client):
    assert client.get("/agent/browser/identities").status_code in (401, 403)
