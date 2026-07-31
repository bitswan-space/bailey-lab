"""Egress-firewall rule model: allow/deny rules stored + versioned in
bitswan.yaml (the audit log), per-realm posture (dev=monitor, staging/prod=
enforce), production RBAC (admin/auditor only), and pull-rules-forward. Git
writes are stubbed; the attempts telemetry is read from the firewall cache dir.
"""

import asyncio
import subprocess

import pytest
from fastapi import HTTPException

from app.utils import (
    call_git_command_with_output,
    read_bitswan_yaml,
    dump_bitswan_yaml,
)
from app.services import automation_service as asvc
from app.services import firewall_service as fws
from app.services.automation_service import AutomationService
from app.task_queue import current_requester


def _svc(tmp_path, monkeypatch):
    async def _noop_update_git(*a, **k):
        return None

    monkeypatch.setattr(asvc, "update_bp_git", _noop_update_git)
    monkeypatch.setattr(fws, "firewall_dir", lambda: str(tmp_path / "fw"))
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    with open(tmp_path / "bitswan.yaml", "w") as f:
        dump_bitswan_yaml({"deployments": {}, "secrets": {"keep": "me"}}, f)
    return svc


def test_posture_defaults_by_realm(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    assert svc.read_firewall("shop", "dev")["posture"] == "monitor"
    assert svc.read_firewall("shop", "staging")["posture"] == "enforce"
    assert svc.read_firewall("shop", "production")["posture"] == "enforce"
    assert svc.read_firewall("shop", "dev")["rules"] == []


def test_set_rule_persists_and_audits(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    fw = asyncio.run(
        svc.set_firewall_rule(
            "shop", "dev", "Sentry.io", "allowed", "errors", by="tim@x"
        )
    )
    assert fw["allowed"] == ["sentry.io"]  # normalized
    r = fw["rules"][0]
    assert r["host"] == "sentry.io" and r["status"] == "allowed"
    assert r["by"] == "tim@x" and r["purpose"] == "errors"
    raw = read_bitswan_yaml(str(tmp_path))
    assert raw["firewall"]["shop"]["dev"]["rules"]["sentry.io"]["by"] == "tim@x"


def test_production_requires_admin_or_auditor(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    # #186/#187: the role is resolved from the daemon store keyed on the
    # header-derived requester identity — never a caller-supplied role.
    monkeypatch.setattr(
        asvc,
        "daemon_user_role",
        lambda e: {"admin@x": "admin", "auditor@x": "auditor"}.get(e, "member"),
    )
    # A member on production → 403.
    current_requester.set("member@x")
    with pytest.raises(HTTPException) as e:
        asyncio.run(
            svc.set_firewall_rule(
                "shop", "production", "api.x.com", "allowed", by="member@x"
            )
        )
    assert e.value.status_code == 403
    # dev is fine for anyone (not gated).
    asyncio.run(
        svc.set_firewall_rule("shop", "dev", "api.x.com", "allowed", by="member@x")
    )
    # No identity at all also fails closed on production.
    current_requester.set(None)
    with pytest.raises(HTTPException) as e0:
        asyncio.run(
            svc.set_firewall_rule(
                "shop", "production", "api.x.com", "allowed", by="member@x"
            )
        )
    assert e0.value.status_code == 403
    # admin/auditor allowed on production.
    for who in ("admin@x", "auditor@x"):
        current_requester.set(who)
        fw = asyncio.run(
            svc.set_firewall_rule("shop", "production", "api.x.com", "allowed", by=who)
        )
        assert "api.x.com" in fw["allowed"]


def test_delete_rule(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    asyncio.run(svc.set_firewall_rule("shop", "dev", "a.com", "allowed", by="x"))
    fw = asyncio.run(svc.delete_firewall_rule("shop", "dev", "a.com", by="x"))
    assert fw["rules"] == []


def test_promote_pulls_rules_forward(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    asyncio.run(svc.set_firewall_rule("shop", "dev", "a.com", "allowed", by="x"))
    asyncio.run(svc.set_firewall_rule("shop", "dev", "bad.com", "denied", by="x"))
    # pull dev → staging
    fw = asyncio.run(svc.promote_firewall("shop", "dev", "staging", by="x"))
    hosts = {r["host"]: r["status"] for r in fw["rules"]}
    assert hosts == {"a.com": "allowed", "bad.com": "denied"}
    assert fw["allowed"] == ["a.com"]


def test_attempts_feed_from_gateway_jsonl(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    import os
    import json

    d = str(tmp_path / "fw")
    os.makedirs(d, exist_ok=True)
    with open(fws.attempts_log_path("shop", "production"), "w") as f:
        for h in ["evil.com", "evil.com", "pypi.org"]:
            f.write(
                json.dumps({"host": h, "proto": "tls", "at": "2026-06-18T00:00:00Z"})
                + "\n"
            )
    fw = svc.read_firewall("shop", "production")
    review = {a["host"]: a["count"] for a in fw["attempts"]}
    assert review == {"evil.com": 2, "pypi.org": 1}  # needs-review feed (no rules yet)
    # once a rule exists for a host, it drops out of needs-review
    monkeypatch.setattr(asvc, "daemon_user_role", lambda e: "admin")
    current_requester.set("a@x")
    asyncio.run(
        svc.set_firewall_rule("shop", "production", "pypi.org", "denied", by="a@x")
    )
    fw2 = svc.read_firewall("shop", "production")
    assert {a["host"] for a in fw2["attempts"]} == {"evil.com"}


# ── default (seeded) allow-list: AOC Keycloak (#311) ─────────────────────────
# The platform injects the AOC Keycloak into every worker as KEYCLOAK_URL, then
# the egress firewall flagged the worker for calling it — noise for a call the
# platform provisioned. That exact host (never a wildcard, never a suffix guess)
# is seeded into a BP realm's allow-list on its FIRST deploy.


@pytest.mark.parametrize(
    "url,expect",
    [
        ("https://keycloak.tp-sandbox.bswn.io", "keycloak.tp-sandbox.bswn.io"),
        # scheme + port + path all stripped
        ("https://keycloak.example.com:8443/auth/", "keycloak.example.com"),
        # the driver's /realms/<realm> issuer form (dockerdriver/entry.go)
        ("https://kc.example.com/realms/bitswan", "kc.example.com"),
        ("http://kc.example.com:8080/realms/x/", "kc.example.com"),
        # no scheme at all, plus case + trailing dot normalisation
        ("KC.Example.COM.:8080", "kc.example.com"),
        ("kc.example.com/realms/r", "kc.example.com"),
        # a malformed port still leaves an unambiguous host; only the host matters
        ("https://kc.example.com:notaport/", "kc.example.com"),
    ],
)
def test_bare_host_extracts_exact_host(url, expect):
    assert fws.bare_host(url) == expect


@pytest.mark.parametrize(
    "url",
    [
        "",
        "   ",
        None,
        "https://",
        "/realms/bitswan",  # nothing but the realm suffix
        "https://*.bswn.io",  # a wildcard must never survive
        "*.bswn.io",
        "https://user@:8443/",
        "https://[::1]/",  # IPv6 literal: conservatively unsupported
        "https://[::1/",  # urlsplit raises on this one
        "https://kc..example.com/",  # empty label
    ],
)
def test_bare_host_fails_closed(url):
    assert fws.bare_host(url) == ""


def test_default_allowed_hosts_is_keycloak_host(monkeypatch):
    monkeypatch.setenv("KEYCLOAK_URL", "https://keycloak.tp-sandbox.bswn.io/realms/bs")
    assert fws.default_allowed_hosts() == ["keycloak.tp-sandbox.bswn.io"]


@pytest.mark.parametrize("val", [None, "", "   ", "https://", "not a url at all"])
def test_default_allowed_hosts_fails_closed(monkeypatch, val):
    """THE important case: a missing or unparseable KEYCLOAK_URL seeds NOTHING.
    The host then stays in the needs-review feed — an unparseable config must
    never silently widen egress, and there is no wildcard/suffix fallback."""
    if val is None:
        monkeypatch.delenv("KEYCLOAK_URL", raising=False)
    else:
        monkeypatch.setenv("KEYCLOAK_URL", val)
    assert fws.default_allowed_hosts() == []

    bs = {"deployments": {}}
    assert fws.seed_default_rules_for_members(bs, [_member("dev")]) == []
    assert "firewall" not in bs


def _member(stage: str, bp: str = "shop") -> dict:
    return {
        "deployment_id": f"backend-acme-{stage}",
        "relative_path": f"copies/main/{bp}/backend",
        "stage": stage,
    }


def test_seeds_keycloak_on_first_deploy(monkeypatch):
    monkeypatch.setenv("KEYCLOAK_URL", "https://keycloak.example.com:8443/realms/bs")
    bs = {"deployments": {}}
    seeded = fws.seed_default_rules_for_members(
        bs, [_member("dev"), _member("staging")]
    )
    assert {(bp, realm, h) for bp, realm, h in seeded} == {
        ("shop", "dev", "keycloak.example.com"),
        ("shop", "staging", "keycloak.example.com"),
    }
    dev = bs["firewall"]["shop"]["dev"]
    assert dev["posture"] == "monitor"  # realm default, unchanged
    assert bs["firewall"]["shop"]["staging"]["posture"] == "enforce"
    rule = dev["rules"]["keycloak.example.com"]
    assert rule["status"] == "allowed"
    # Visible provenance: the dashboard renders purpose · by · at on the row.
    assert rule["by"] and rule["at"] and "KEYCLOAK_URL" in rule["purpose"]
    # Exactly one host, and never a wildcard or a bare domain.
    assert list(dev["rules"]) == ["keycloak.example.com"]
    assert not any("*" in h for h in dev["rules"])


def test_seed_shows_under_allowed_and_not_needs_review(tmp_path, monkeypatch):
    """End-to-end through read_firewall: the seeded host is an ALLOWED rule, so
    it drops out of the needs-review feed even though the gateway logged it."""
    import json
    import os

    monkeypatch.setenv("KEYCLOAK_URL", "https://keycloak.tp-sandbox.bswn.io")
    svc = _svc(tmp_path, monkeypatch)
    os.makedirs(str(tmp_path / "fw"), exist_ok=True)
    with open(fws.attempts_log_path("shop", "dev"), "w") as f:
        f.write(
            json.dumps(
                {
                    "host": "keycloak.tp-sandbox.bswn.io",
                    "proto": "tls",
                    "at": "2026-07-31T08:39:55Z",
                }
            )
            + "\n"
        )

    bs = read_bitswan_yaml(str(tmp_path)) or {"deployments": {}}
    fws.seed_default_rules_for_members(bs, [_member("dev")])
    with open(tmp_path / "bitswan.yaml", "w") as f:
        dump_bitswan_yaml(bs, f)

    fw = svc.read_firewall("shop", "dev")
    assert fw["allowed"] == ["keycloak.tp-sandbox.bswn.io"]
    assert fw["attempts"] == []  # no longer "needs review"


def test_seed_skips_realm_that_already_has_a_node(monkeypatch):
    """Requirement: never rewrite an allow-list an operator curated."""
    monkeypatch.setenv("KEYCLOAK_URL", "https://keycloak.example.com")
    curated = {"posture": "enforce", "rules": {"api.x.com": {"status": "allowed"}}}
    bs = {"deployments": {}, "firewall": {"shop": {"dev": curated}}}
    assert fws.seed_default_rules_for_members(bs, [_member("dev")]) == []
    assert bs["firewall"]["shop"]["dev"] == curated


def test_operator_denial_and_removal_are_never_re_seeded(tmp_path, monkeypatch):
    """The subtle one: an operator who denies OR removes the seeded host must
    keep that decision across later deploys. delete_firewall_rule leaves the
    node behind, so the (bp, realm) is no longer a first deploy."""
    monkeypatch.setenv("KEYCLOAK_URL", "https://keycloak.example.com")
    svc = _svc(tmp_path, monkeypatch)

    def _redeploy():
        bs = read_bitswan_yaml(str(tmp_path)) or {"deployments": {}}
        fws.seed_default_rules_for_members(bs, [_member("dev")])
        with open(tmp_path / "bitswan.yaml", "w") as f:
            dump_bitswan_yaml(bs, f)

    _redeploy()
    assert svc.read_firewall("shop", "dev")["allowed"] == ["keycloak.example.com"]

    # Deny it → a later deploy must not flip it back to allowed.
    asyncio.run(
        svc.set_firewall_rule("shop", "dev", "keycloak.example.com", "denied", by="t")
    )
    _redeploy()
    fw = svc.read_firewall("shop", "dev")
    assert fw["allowed"] == []
    assert [r["status"] for r in fw["rules"]] == ["denied"]

    # Remove the rule entirely → a later deploy must not bring it back.
    asyncio.run(svc.delete_firewall_rule("shop", "dev", "keycloak.example.com", by="t"))
    _redeploy()
    assert svc.read_firewall("shop", "dev")["rules"] == []


def test_seed_skips_deployments_without_a_business_process(monkeypatch):
    monkeypatch.setenv("KEYCLOAK_URL", "https://keycloak.example.com")
    bs = {"deployments": {}}
    members = [{"deployment_id": "top-level", "relative_path": "solo", "stage": "dev"}]
    assert fws.seed_default_rules_for_members(bs, members) == []
    assert "firewall" not in bs


def test_write_deployment_entries_seeds_and_persists(tmp_path, monkeypatch):
    """The real deploy path: write_deployment_entries must carry the seeded node
    into the bitswan.yaml it commits, so the driver compiles it into the
    gateway's allow-list and the UI reads it back under ALLOWED."""
    monkeypatch.setenv("KEYCLOAK_URL", "https://keycloak.example.com/realms/bs")
    svc = _svc(tmp_path, monkeypatch)

    async def _persist(self, bs_yaml, bps, deployment_id, action, **kw):
        with open(tmp_path / "bitswan.yaml", "w") as f:
            dump_bitswan_yaml(bs_yaml, f)

    monkeypatch.setattr(AutomationService, "_persist_bp_state", _persist)

    member = {
        **_member("dev"),
        "checksum": "a" * 40,
        "automation_name": "backend",
        "context": "acme",
        "services": {},
        "memory_reservation": 256,
        "memory_reservation_policy": "on-demand",
    }
    bs = asyncio.run(svc.write_deployment_entries([member], deployed_by="t@x"))

    assert (
        bs["firewall"]["shop"]["dev"]["rules"]["keycloak.example.com"]["status"]
        == "allowed"
    )
    assert svc.read_firewall("shop", "dev")["allowed"] == ["keycloak.example.com"]


def test_live_dev_seeds_the_dev_realm(monkeypatch):
    monkeypatch.setenv("KEYCLOAK_URL", "https://keycloak.example.com")
    bs = {"deployments": {}}
    fws.seed_default_rules_for_members(bs, [_member("live-dev")])
    assert list(bs["firewall"]["shop"]) == ["dev"]


def test_empty_stage_seeds_production(monkeypatch):
    monkeypatch.setenv("KEYCLOAK_URL", "https://keycloak.example.com")
    bs = {"deployments": {}}
    fws.seed_default_rules_for_members(bs, [_member("")])
    assert list(bs["firewall"]["shop"]) == ["production"]
    assert bs["firewall"]["shop"]["production"]["posture"] == "enforce"


# ── deployment-history audit log + rollback (real git repo) ──────────────────
# bp_history is derived from the git LOG of bitswan.yaml, so these use the real
# update_git against a throwaway repo (no remote → it just adds + commits).


def _git_svc(tmp_path, monkeypatch):
    monkeypatch.setattr(fws, "firewall_dir", lambda: str(tmp_path / "fw"))
    monkeypatch.delenv("HOST_PATH", raising=False)
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.email", "ci@x"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.name", "ci"], cwd=tmp_path, check=True)
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    with open(tmp_path / "bitswan.yaml", "w") as f:
        dump_bitswan_yaml({"deployments": {}}, f)
    subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-qm", "init"], cwd=tmp_path, check=True)
    return svc


def _fw_history(svc, bp, stage):
    h = asyncio.run(svc.bp_history(bp, stage))
    return h, [e for e in h["history"] if e["source"] == "firewall"]


def test_firewall_changes_appear_in_deployment_history(tmp_path, monkeypatch):
    svc = _git_svc(tmp_path, monkeypatch)
    asyncio.run(svc.set_firewall_rule("shop", "dev", "a.com", "allowed", by="tim@x"))
    asyncio.run(svc.set_firewall_rule("shop", "dev", "bad.com", "denied", by="tim@x"))

    h, fw_entries = _fw_history(svc, "shop", "dev")
    # Two distinct rule-set states → two audit-log entries (newest-first).
    assert len(fw_entries) == 2
    assert fw_entries[0]["firewall"]["allowed"] == 1
    assert fw_entries[0]["firewall"]["denied"] == 1
    assert fw_entries[0]["deployed_by"] == "tim@x"
    assert "bad.com" in fw_entries[0]["firewall"]["summary"]
    # Firewall events never become the live "current" version.
    assert h["current"] is None


def test_firewall_rollback_restores_prior_ruleset(tmp_path, monkeypatch):
    svc = _git_svc(tmp_path, monkeypatch)
    asyncio.run(svc.set_firewall_rule("shop", "dev", "a.com", "allowed", by="x"))
    _, fw_entries = _fw_history(svc, "shop", "dev")
    commit_one = fw_entries[0]["commit"]  # state: only a.com allowed

    asyncio.run(svc.set_firewall_rule("shop", "dev", "b.com", "allowed", by="x"))
    assert {r["host"] for r in svc.read_firewall("shop", "dev")["rules"]} == {
        "a.com",
        "b.com",
    }

    fw_rb = asyncio.run(svc.rollback_firewall("shop", "dev", commit_one, by="x"))
    assert {r["host"] for r in fw_rb["rules"]} == {"a.com"}
    # The restore is itself versioned (a fresh audit-log entry on top).
    _, after = _fw_history(svc, "shop", "dev")
    assert after[0]["firewall"]["allowed"] == 1
    assert after[0]["firewall"]["denied"] == 0


def test_firewall_rollback_production_requires_role(tmp_path, monkeypatch):
    svc = _git_svc(tmp_path, monkeypatch)
    monkeypatch.setattr(
        asvc, "daemon_user_role", lambda e: "admin" if e == "admin@x" else "member"
    )
    current_requester.set("admin@x")
    asyncio.run(
        svc.set_firewall_rule("shop", "production", "a.com", "allowed", by="admin@x")
    )
    _, fw_entries = _fw_history(svc, "shop", "production")
    commit = fw_entries[0]["commit"]
    # A member cannot roll back a production firewall change.
    current_requester.set("member@x")
    with pytest.raises(HTTPException) as e:
        asyncio.run(svc.rollback_firewall("shop", "production", commit, by="member@x"))
    assert e.value.status_code == 403


def test_firewall_rollback_unknown_revision_fails_loudly(tmp_path, monkeypatch):
    svc = _git_svc(tmp_path, monkeypatch)
    asyncio.run(svc.set_firewall_rule("shop", "dev", "a.com", "allowed", by="x"))
    with pytest.raises(HTTPException) as e:
        asyncio.run(svc.rollback_firewall("shop", "dev", "deadbeef" * 5, by="x"))
    assert e.value.status_code == 404


# ── GDPR data-processing record + DPA PDF storage ────────────────────────────


def test_gdpr_record_persists_on_rule(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    gdpr = {
        "noUserData": False,
        "dataSent": "employee email, stack traces",
        "purpose": "crash diagnostics",
        "stored": "yes",
        "jurisdiction": "USA (DPF)",
        "dpaFile": "sentry-dpa.pdf",
    }
    fw = asyncio.run(
        svc.set_firewall_rule(
            "shop",
            "dev",
            "sentry.io",
            "allowed",
            "crash diagnostics",
            gdpr=gdpr,
            by="t",
        )
    )
    rule = next(r for r in fw["rules"] if r["host"] == "sentry.io")
    assert rule["gdpr"] == gdpr
    # round-trips through bitswan.yaml
    raw = read_bitswan_yaml(str(tmp_path))
    assert raw["firewall"]["shop"]["dev"]["rules"]["sentry.io"]["gdpr"] == gdpr


def test_dpa_pdf_stored_in_repo_per_host(tmp_path, monkeypatch):
    svc = _git_svc(tmp_path, monkeypatch)
    res = asyncio.run(
        svc.store_firewall_dpa(
            "shop",
            "dev",
            "Sentry.io",
            b"%PDF-1.4 fake",
            filename="sentry-dpa.pdf",
            by="t",
        )
    )
    # stored under firewall-dpa/<bp>/<host>.pdf (host-keyed, shared across stages)
    assert res["stored"] == "firewall-dpa/shop/sentry.io.pdf"
    p = svc.firewall_dpa_path("shop", "sentry.io")
    assert p and p.endswith("firewall-dpa/shop/sentry.io.pdf")
    with open(p, "rb") as f:
        assert f.read() == b"%PDF-1.4 fake"
    # committed into the BP's OWN deploy repo (gitops/bp/<bp>) — its git history
    # is the per-BP audit/rollback engine.
    out, _, _ = asyncio.run(
        call_git_command_with_output(
            "git",
            "log",
            "--name-only",
            "--format=%s",
            "-1",
            cwd=str(tmp_path / "bp" / "shop"),
        )
    )
    assert "firewall-dpa/shop/sentry.io.pdf" in out
    # the same host in another stage resolves to the same document
    assert svc.firewall_dpa_path("shop", "sentry.io") == p


def test_dpa_upload_production_requires_role(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    monkeypatch.setattr(asvc, "daemon_user_role", lambda e: "member")
    current_requester.set("member@x")
    with pytest.raises(HTTPException) as e:
        asyncio.run(
            svc.store_firewall_dpa(
                "shop", "production", "x.com", b"%PDF", by="member@x"
            )
        )
    assert e.value.status_code == 403
