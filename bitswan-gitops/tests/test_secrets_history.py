"""Per-BP secrets: versioned in the BP's deploy repo, surfaced in the
deployment history, and rollback-able. Companion to the Go
TestSecretEnvFileScopedToBackendWorker (which proves the value reaches the
backend container's env and no other): here we prove the value is materialized
into the BP's env file, that each change is a history event, and that a rollback
restores the prior value.
"""

import asyncio
import os

from app.services import bp_secrets
from app.services.automation_service import AutomationService


def _svc(tmp_path):
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    svc.secrets_dir = str(tmp_path / "secrets")
    return svc


def _envfile(svc, bp, stage):
    p = bp_secrets.env_file_path(svc.secrets_dir, bp, stage)
    return open(p).read() if os.path.exists(p) else ""


def test_secret_write_materializes_history_and_rollback(tmp_path):
    svc = _svc(tmp_path)

    # 1. Set a secret in the dev stage → materialized into the BP's dev env file
    #    (this is exactly the file the backend container mounts as env_file).
    asyncio.run(
        svc.write_bp_secrets("shop", {"dev": {"API_KEY": "v1"}}, deployed_by="a@x")
    )
    assert "API_KEY=v1" in _envfile(svc, "shop", "dev")

    # 2. It shows up as a rollback-able event in the deployment history.
    h1 = asyncio.run(svc.bp_history("shop", "dev"))
    secret_events = [e for e in h1["history"] if e["source"] == "secret"]
    assert len(secret_events) == 1, h1["history"]
    first_commit = secret_events[0]["commit"]

    # 3. Change the value → new env file + a second history event.
    asyncio.run(
        svc.write_bp_secrets("shop", {"dev": {"API_KEY": "v2"}}, deployed_by="a@x")
    )
    assert "API_KEY=v2" in _envfile(svc, "shop", "dev")
    h2 = asyncio.run(svc.bp_history("shop", "dev"))
    assert len([e for e in h2["history"] if e["source"] == "secret"]) == 2

    # 4. Roll back to the first commit → the value is restored.
    asyncio.run(svc.rollback_secrets("shop", "dev", first_commit, by="a@x"))
    env = _envfile(svc, "shop", "dev")
    assert "API_KEY=v1" in env
    assert "API_KEY=v2" not in env


def test_secret_isolated_per_bp(tmp_path):
    """A secret set on one BP never lands in another BP's env file."""
    svc = _svc(tmp_path)
    asyncio.run(
        svc.write_bp_secrets("shop", {"dev": {"SHOP_KEY": "s"}}, deployed_by="a@x")
    )
    asyncio.run(
        svc.write_bp_secrets("blog", {"dev": {"BLOG_KEY": "b"}}, deployed_by="a@x")
    )
    assert "SHOP_KEY=s" in _envfile(svc, "shop", "dev")
    assert "SHOP_KEY" not in _envfile(svc, "blog", "dev")
    assert "BLOG_KEY=b" in _envfile(svc, "blog", "dev")
