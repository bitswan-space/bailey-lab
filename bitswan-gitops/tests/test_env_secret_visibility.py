"""Tests for the container-inspect env RBAC (#84).

Secret env values are masked SERVER-SIDE: production secrets are visible only
to admin/auditor, non-production secrets to any known Bailey role, and a
missing identity or a failed role lookup fails CLOSED (everything masked).
Names are always shown.
"""

import types

from app.services import automation_service as asvc
from app.services import bp_secrets
from app.services.automation_service import _mask_env, SECRET_MASK


# --- _mask_env: the pure masking transform --------------------------------


def test_mask_env_masks_secret_values_when_not_revealed():
    rows = _mask_env(["API_KEY=supersecret", "PUBLIC=hi"], {"API_KEY"}, reveal=False)
    by_name = {r["name"]: r for r in rows}
    assert by_name["API_KEY"]["value"] == SECRET_MASK
    assert by_name["API_KEY"]["secret"] is True
    assert by_name["API_KEY"]["masked"] is True
    # non-secret values are always shown
    assert by_name["PUBLIC"]["value"] == "hi"
    assert by_name["PUBLIC"]["secret"] is False
    assert by_name["PUBLIC"]["masked"] is False


def test_mask_env_reveals_secret_values_when_permitted():
    rows = _mask_env(["API_KEY=supersecret"], {"API_KEY"}, reveal=True)
    assert rows[0]["value"] == "supersecret"
    assert rows[0]["secret"] is True
    assert rows[0]["masked"] is False


def test_mask_env_keeps_names_and_splits_only_first_equals():
    rows = _mask_env(["CONN=a=b=c"], set(), reveal=False)
    assert rows[0]["name"] == "CONN"
    assert rows[0]["value"] == "a=b=c"  # value may contain '='


# --- _env_secret_visibility: the RBAC decision ----------------------------


def _stub_self():
    return types.SimpleNamespace(
        gitops_dir="/g",
        secrets_dir="/s",
        _FW_ROLES=asvc.AutomationService._FW_ROLES,
        _ENV_REVEAL_ROLES=asvc.AutomationService._ENV_REVEAL_ROLES,
    )


def _patch(
    monkeypatch,
    *,
    stage,
    role=None,
    raise_role=False,
    secret_keys=frozenset({"API_KEY"})
):
    realm = bp_secrets.realm_for_stage(stage)
    bs = {
        "deployments": {"dep1": {"context": "orders", "stage": stage}},
        "secrets": {"orders": {realm: "BLOB"}},
    }
    monkeypatch.setattr(asvc, "read_bitswan_yaml", lambda d: bs)
    monkeypatch.setattr(asvc, "deployment_bp", lambda conf, ctx="": "orders")
    monkeypatch.setattr(
        asvc.bp_secrets,
        "decrypt_secrets",
        lambda sd, blob: {k: "v" for k in secret_keys},
    )

    def fake_role(email):
        if raise_role:
            raise RuntimeError("daemon socket down")
        return role or ""

    monkeypatch.setattr(asvc, "daemon_user_role", fake_role)


def _visibility(deployment_id="dep1", by="alice@acme.com"):
    return asvc.AutomationService._env_secret_visibility(
        _stub_self(), deployment_id, by
    )


def test_production_secret_visible_to_admin_and_auditor(monkeypatch):
    for role in ("admin", "auditor"):
        _patch(monkeypatch, stage="production", role=role)
        keys, reveal = _visibility()
        assert keys == {"API_KEY"}
        assert reveal is True, role


def test_production_secret_masked_for_member(monkeypatch):
    _patch(monkeypatch, stage="production", role="member")
    keys, reveal = _visibility()
    assert keys == {"API_KEY"}
    assert reveal is False


def test_nonproduction_secret_visible_to_any_known_role(monkeypatch):
    for role in ("admin", "auditor", "member", "user"):
        _patch(monkeypatch, stage="dev", role=role)
        _, reveal = _visibility()
        assert reveal is True, role


def test_nonproduction_secret_masked_for_unknown_role(monkeypatch):
    _patch(monkeypatch, stage="dev", role="")  # email the store doesn't know
    _, reveal = _visibility()
    assert reveal is False


def test_no_identity_fails_closed(monkeypatch):
    _patch(monkeypatch, stage="dev", role="admin")
    _, reveal = _visibility(by=None)  # no `by` → never consult the role store
    assert reveal is False


def test_role_lookup_failure_fails_closed(monkeypatch):
    _patch(monkeypatch, stage="production", role="admin", raise_role=True)
    _, reveal = _visibility()
    assert reveal is False


def test_no_secret_keys_reveals_nothing(monkeypatch):
    _patch(monkeypatch, stage="production", role="admin", secret_keys=frozenset())
    keys, reveal = _visibility()
    assert keys == set()
    assert reveal is False
