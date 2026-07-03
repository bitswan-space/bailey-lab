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


def test_secret_write_materializes_history_and_rollback(tmp_path, monkeypatch):
    svc = _svc(tmp_path)

    async def _noop_apply(deployment_ids, deployed_by=None, report=None):
        # No driver in the unit test — rollback's file restore + commit is what we
        # assert; the redeploy (driver re-derives the env from the restored blob)
        # is exercised separately (Go TestSecretEnvFileScopedToBackendWorker).
        return {"deployment_ids": list(deployment_ids)}

    monkeypatch.setattr(svc, "apply_compose_for_deployments", _noop_apply)

    # 1. Set a secret in the dev stage → materialized into the BP's dev env file
    #    (this is exactly the file the backend container mounts as env_file).
    asyncio.run(
        svc.write_bp_secrets("shop", {"dev": {"API_KEY": "v1"}}, deployed_by="a@x")
    )
    assert "API_KEY=v1" in _envfile(svc, "shop", "dev")
    assert svc.read_bp_secrets("shop")["dev"]["API_KEY"] == "v1"

    # 2. It shows up as a rollback-able event in the deployment history.
    h1 = asyncio.run(svc.bp_history("shop", "dev"))
    secret_events = [e for e in h1["history"] if e["source"] == "secret"]
    assert len(secret_events) == 1, h1["history"]
    first_commit = secret_events[0]["commit"]

    # 3. Change the value → a second history event.
    asyncio.run(
        svc.write_bp_secrets("shop", {"dev": {"API_KEY": "v2"}}, deployed_by="a@x")
    )
    assert svc.read_bp_secrets("shop")["dev"]["API_KEY"] == "v2"
    h2 = asyncio.run(svc.bp_history("shop", "dev"))
    sec2 = [e for e in h2["history"] if e["source"] == "secret"]
    assert len(sec2) == 2

    # Inspect → Secrets snapshot reads the decrypted values straight from the
    # bitswan.yaml blob at a revision — the same source a rollback restores.
    snap1 = asyncio.run(svc.read_bp_secrets_at("shop", first_commit, "dev"))
    assert snap1["values"]["API_KEY"] == "v1"
    latest = sec2[0]["commit"]
    snap2 = asyncio.run(svc.read_bp_secrets_at("shop", latest, "dev"))
    assert snap2["values"]["API_KEY"] == "v2"

    # Production secrets are admin/auditor-only. The snapshot for a production
    # revision must redact values (fail-closed) unless `by` resolves to a
    # privileged role — in the test env the daemon role lookup fails, so an
    # unprivileged/absent `by` sees nothing.
    asyncio.run(
        svc.write_bp_secrets(
            "shop", {"production": {"PROD_KEY": "topsecret"}}, deployed_by="a@x"
        )
    )
    prod_hist = asyncio.run(svc.bp_history("shop", "production"))
    prod_commit = [e for e in prod_hist["history"] if e["source"] == "secret"][0][
        "commit"
    ]
    redacted = asyncio.run(
        svc.read_bp_secrets_at("shop", prod_commit, "production")
    )
    assert redacted["realm"] == "production"
    assert redacted["values"] == {}

    # 4. Roll back to the first commit — ONE flow restores the whole bitswan.yaml
    #    (secrets included), so the secret value reverts. No secret-specific
    #    rollback flow.
    asyncio.run(
        svc.rollback_business_process("shop", "dev", first_commit, deployed_by="a@x")
    )
    assert svc.read_bp_secrets("shop")["dev"]["API_KEY"] == "v1"


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


def test_commit_attributed_to_acting_user(tmp_path):
    """A write with no explicit deployed_by is attributed to the request's
    gate-verified identity (X-Forwarded-Email → current_requester contextvar),
    not the mechanical gitops service identity. This is what makes the
    deployment-history actor the user who triggered the change."""
    from app.task_queue import current_requester

    svc = _svc(tmp_path)
    token = current_requester.set("alice@example.com")
    try:
        # No deployed_by passed — attribution must come from the contextvar.
        asyncio.run(svc.write_bp_secrets("shop", {"dev": {"K": "v"}}))
    finally:
        current_requester.reset(token)

    h = asyncio.run(svc.bp_history("shop", "dev"))
    sec = [e for e in h["history"] if e["source"] == "secret"]
    assert sec, h["history"]
    assert sec[0]["deployed_by"] == "alice@example.com"


def test_secret_change_redeploys_only_changed_realm(tmp_path, monkeypatch):
    """A secret change applies immediately: it redeploys the changed realm's
    currently-deployed members (so the new value reaches the container and the
    change is the current deployment), and leaves other realms' members alone."""
    import app.services.automation_service as mod

    svc = _svc(tmp_path)

    captured: list[list[str]] = []

    async def _capture(ids, deployed_by=None, report=None):
        captured.append(list(ids))
        return {"deployment_ids": list(ids)}

    monkeypatch.setattr(svc, "apply_compose_for_deployments", _capture)

    # Pretend the BP "app" has a deployed dev member and a deployed prod member.
    flat = {
        "backend-app-dev": {"relative_path": "app/backend", "stage": "dev"},
        "backend-app-production": {
            "relative_path": "app/backend",
            "stage": "production",
        },
    }
    orig_read = mod.read_bitswan_yaml

    def _read(path):
        bs = orig_read(path) or {}
        bs.setdefault("deployments", {}).update(flat)
        return bs

    monkeypatch.setattr(mod, "read_bitswan_yaml", _read)

    # Change ONLY the dev realm → only the dev member redeploys.
    asyncio.run(svc.write_bp_secrets("app", {"dev": {"K": "v1"}}, deployed_by="a@x"))
    assert captured == [["backend-app-dev"]], captured

    # Re-saving the SAME dev value (and nothing else) is a no-op: no redeploy.
    captured.clear()
    asyncio.run(svc.write_bp_secrets("app", {"dev": {"K": "v1"}}, deployed_by="a@x"))
    assert captured == [], captured


def test_production_secret_change_is_pending_not_applied(tmp_path, monkeypatch):
    """Production runs blue-green, so a production secret must NOT trigger an
    in-place redeploy (that would recreate the LIVE slot = downtime). It is a
    PENDING change: versioned now, applied zero-downtime on the next promote.
    It also must not claim "current" on the production timeline."""
    import app.services.automation_service as mod

    svc = _svc(tmp_path)
    captured: list[list[str]] = []

    async def _capture(ids, deployed_by=None, report=None):
        captured.append(list(ids))
        return {"deployment_ids": list(ids)}

    monkeypatch.setattr(svc, "apply_compose_for_deployments", _capture)

    flat = {
        "backend-app-production": {
            "relative_path": "app/backend",
            "stage": "production",
        },
    }
    orig_read = mod.read_bitswan_yaml

    def _read(path):
        bs = orig_read(path) or {}
        bs.setdefault("deployments", {}).update(flat)
        return bs

    monkeypatch.setattr(mod, "read_bitswan_yaml", _read)

    asyncio.run(
        svc.write_bp_secrets("app", {"production": {"K": "v1"}}, deployed_by="a@x")
    )
    # No in-place redeploy of production.
    assert captured == [], captured
    # The change is recorded (versioned + rollback-able) but is NOT current: the
    # live production deploy keeps the pointer until a promote applies the secret.
    h = asyncio.run(svc.bp_history("app", "production"))
    sec = [e for e in h["history"] if e["source"] == "secret"]
    assert sec, h["history"]
    assert h["current"] != sec[0]["commit"]
