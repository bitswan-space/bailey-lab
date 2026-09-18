import os

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

import app.routes.workspace_git as routes
from app.dependencies import get_automation_service, verify_token
from app.main import _RequesterMiddleware
from app.services import git_server
from app.services import workspace_git_remote as remote_cfg
from app.services import workspace_mirror as mirror
from app.task_queue import task_queue

ADMIN = "admin@example.com"
MEMBER = "member@example.com"
TOKEN = "test-gitops-secret"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_GITOPS_SECRET", TOKEN)
    monkeypatch.setattr(git_server, "GIT_REPOS_DIR", str(tmp_path / "git"))
    monkeypatch.setattr(
        git_server, "HOOKS_SRC_DIR", str(tmp_path / "nonexistent-hooks")
    )
    monkeypatch.setattr(remote_cfg, "ALLOW_LOCAL_REMOTES", True)
    svc = get_automation_service()
    monkeypatch.setattr(svc, "gitops_dir", str(tmp_path / "gitops"))
    monkeypatch.setattr(svc, "gitops_dir_host", str(tmp_path / "gitops"))
    monkeypatch.setattr(svc, "secrets_dir", str(tmp_path / "secrets"))
    roles = {ADMIN: "admin", MEMBER: "member"}
    monkeypatch.setattr(routes, "daemon_user_role", lambda email: roles[email])

    async def fake_run(trigger, requester):
        return {"result": "ok"}

    monkeypatch.setattr(mirror, "run_mirror_push", fake_run)
    mirror.reset_for_tests()
    api = FastAPI()
    api.add_middleware(_RequesterMiddleware)
    api.include_router(routes.router, dependencies=[Depends(verify_token)])
    with TestClient(api) as c:
        yield c
    mirror.reset_for_tests()


def _headers(email=None):
    h = {"Authorization": f"Bearer {TOKEN}"}
    if email:
        h["X-Forwarded-Email"] = email
    return h


def test_get_is_admin_only_and_fails_closed(client, monkeypatch):
    assert client.get("/workspace/git-remote", headers=_headers()).status_code == 403
    assert (
        client.get("/workspace/git-remote", headers=_headers(MEMBER)).status_code == 403
    )

    def broken(email):
        raise RuntimeError("daemon down")

    monkeypatch.setattr(routes, "daemon_user_role", broken)
    assert (
        client.get("/workspace/git-remote", headers=_headers(ADMIN)).status_code == 403
    )


def test_get_generates_the_deploy_key_for_admins(client):
    r = client.get("/workspace/git-remote", headers=_headers(ADMIN))
    assert r.status_code == 200
    body = r.json()
    assert body["url"] is None
    assert body["public_key"].startswith("ssh-ed25519 ")
    assert body["fingerprint"].startswith("SHA256:")
    assert body["status"]["result"] == "unconfigured"
    assert body["status"]["in_progress"] is False


def test_identity_comes_from_the_gate_header_not_the_query(client):
    r = client.get(f"/workspace/git-remote?by={ADMIN}", headers=_headers(MEMBER))
    assert r.status_code == 403


def test_put_rejects_https_and_keeps_the_previous_remote(client):
    r = client.put(
        "/workspace/git-remote",
        json={"url": "https://github.com/acme/ws.git"},
        headers=_headers(ADMIN),
    )
    assert r.status_code == 400
    assert "Only SSH remotes" in r.json()["detail"]
    assert (
        client.get("/workspace/git-remote", headers=_headers(ADMIN)).json()["url"]
        is None
    )


def test_put_saves_the_remote_and_queues_the_first_push(client, tmp_path):
    remote = tmp_path / "remote.git"
    os.system(f"git init -q --bare {remote}")
    r = client.put(
        "/workspace/git-remote",
        json={"url": f"file://{remote}"},
        headers=_headers(ADMIN),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["url"] == f"file://{remote}"
    assert body["updated_by"] == ADMIN
    assert body["task_id"]
    kinds = [(t["kind"], t["requester_email"]) for t in task_queue.snapshot()]
    assert (mirror.TASK_KIND, ADMIN) in kinds


def test_put_is_admin_only(client):
    r = client.put(
        "/workspace/git-remote",
        json={"url": "git@github.com:acme/ws.git"},
        headers=_headers(MEMBER),
    )
    assert r.status_code == 403


def test_delete_clears_the_url_but_keeps_the_key(client):
    before = client.get("/workspace/git-remote", headers=_headers(ADMIN)).json()[
        "public_key"
    ]
    client.put(
        "/workspace/git-remote",
        json={"url": "git@github.com:acme/ws.git"},
        headers=_headers(ADMIN),
    )
    r = client.delete("/workspace/git-remote", headers=_headers(ADMIN))
    assert r.status_code == 200
    assert r.json()["url"] is None
    assert r.json()["public_key"] == before


def test_push_requires_a_remote_then_returns_a_task(client):
    r = client.post("/workspace/git-remote/push", headers=_headers(ADMIN))
    assert r.status_code == 400
    client.put(
        "/workspace/git-remote",
        json={"url": "git@github.com:acme/ws.git"},
        headers=_headers(ADMIN),
    )
    r = client.post("/workspace/git-remote/push", headers=_headers(ADMIN))
    assert r.status_code == 200
    assert r.json()["task_id"]
    assert (
        client.post("/workspace/git-remote/push", headers=_headers(MEMBER)).status_code
        == 403
    )


def test_pull_is_open_to_any_verified_user_and_reports_unconfigured(client):
    r = client.post("/workspace/git-remote/pull", headers=_headers(MEMBER))
    assert r.status_code == 200
    assert r.json()["configured"] is False
    assert r.json()["result"] == "unconfigured"
    assert (
        client.post("/workspace/git-remote/pull", headers=_headers()).status_code == 401
    )


def test_pull_runs_the_mirror_inline_when_configured(client, tmp_path, monkeypatch):
    calls = []

    async def fake_inline(trigger, requester, *, force=False):
        calls.append((trigger, requester, force))
        return {
            "result": "inbound",
            "inbound": ["bpa"],
            "conflicts": [],
            "error": None,
            "branches": {},
        }

    monkeypatch.setattr(mirror, "run_inline", fake_inline)
    client.put(
        "/workspace/git-remote",
        json={"url": "git@github.com:acme/ws.git"},
        headers=_headers(ADMIN),
    )
    r = client.post("/workspace/git-remote/pull", headers=_headers(MEMBER))
    assert r.status_code == 200
    assert r.json()["inbound"] == ["bpa"]
    assert calls == [("deploy-check", MEMBER, False)]


def test_pause_stops_pulls_and_pushes_until_resumed(client, monkeypatch):
    calls = []

    async def fake_inline(trigger, requester, *, force=False):
        calls.append(trigger)
        return {
            "result": "ok",
            "inbound": [],
            "conflicts": [],
            "error": None,
            "branches": {},
        }

    monkeypatch.setattr(mirror, "run_inline", fake_inline)
    client.put(
        "/workspace/git-remote",
        json={"url": "git@github.com:acme/ws.git"},
        headers=_headers(ADMIN),
    )
    assert (
        client.post("/workspace/git-remote/pause", headers=_headers(MEMBER)).status_code
        == 403
    )
    r = client.post("/workspace/git-remote/pause", headers=_headers(ADMIN))
    assert r.status_code == 200 and r.json()["paused"] is True
    assert (
        client.post("/workspace/git-remote/pull", headers=_headers(MEMBER)).json()[
            "result"
        ]
        == "paused"
    )
    assert (
        client.post("/workspace/git-remote/push", headers=_headers(ADMIN)).status_code
        == 409
    )
    assert calls == []
    r = client.post("/workspace/git-remote/resume", headers=_headers(ADMIN))
    assert r.status_code == 200 and r.json()["paused"] is False and r.json()["task_id"]


def test_force_push_is_admin_only_and_runs_inline_with_force(client, monkeypatch):
    calls = []

    async def fake_inline(trigger, requester, *, force=False):
        calls.append((trigger, force))
        return {
            "result": "ok",
            "inbound": [],
            "conflicts": [],
            "error": None,
            "branches": {},
        }

    monkeypatch.setattr(mirror, "run_inline", fake_inline)
    assert (
        client.post(
            "/workspace/git-remote/force-push", headers=_headers(ADMIN)
        ).status_code
        == 400
    )
    client.put(
        "/workspace/git-remote",
        json={"url": "git@github.com:acme/ws.git"},
        headers=_headers(ADMIN),
    )
    assert (
        client.post(
            "/workspace/git-remote/force-push", headers=_headers(MEMBER)
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/workspace/git-remote/force-push", headers=_headers(ADMIN)
        ).status_code
        == 200
    )
    assert calls == [("repair", True)]


def test_rotate_key_is_admin_only_and_returns_the_new_public_key(client):
    before = client.get("/workspace/git-remote", headers=_headers(ADMIN)).json()[
        "public_key"
    ]
    assert (
        client.post(
            "/workspace/git-remote/rotate-key", headers=_headers(MEMBER)
        ).status_code
        == 403
    )
    r = client.post("/workspace/git-remote/rotate-key", headers=_headers(ADMIN))
    assert r.status_code == 200
    assert r.json()["public_key"] != before
    assert r.json()["public_key"].startswith("ssh-ed25519 ")
    assert r.json()["status"]["key_rotated_by"] == ADMIN
    assert (
        client.get("/workspace/git-remote", headers=_headers(ADMIN)).json()[
            "public_key"
        ]
        == r.json()["public_key"]
    )
