"""Per-BP secrets store: shared key names, per-stage values, derived env
files, and the dev/live-dev realm sharing that replaces automation.toml
[secrets] groups."""

import os

from app.services import bp_secrets as S


def test_realm_for_stage_shares_dev_and_live_dev():
    assert S.realm_for_stage("dev") == "dev"
    assert S.realm_for_stage("live-dev") == "dev"
    assert S.realm_for_stage("staging") == "staging"
    assert S.realm_for_stage("production") == "production"
    assert S.realm_for_stage("") == "production"


def test_write_then_read_round_trips(tmp_path):
    sd = str(tmp_path)
    data = {
        "keys": ["API_KEY", "DB_URL"],
        "values": {
            "dev": {"API_KEY": "dev-key", "DB_URL": "dev-db"},
            "staging": {"API_KEY": "stg-key"},
            "production": {},
        },
    }
    S.write_bp_secrets(sd, "shop", data)
    out = S.read_bp_secrets(sd, "shop")
    assert out["keys"] == ["API_KEY", "DB_URL"]
    assert out["values"]["dev"] == {"API_KEY": "dev-key", "DB_URL": "dev-db"}
    # Empty values are not persisted (a stage with no value = "Not set").
    assert out["values"]["staging"] == {"API_KEY": "stg-key"}
    assert out["values"]["production"] == {}


def test_keys_uppercased_deduped_and_unioned(tmp_path):
    sd = str(tmp_path)
    S.write_bp_secrets(
        sd,
        "shop",
        {
            "keys": ["api_key", "API_KEY"],  # dup after upper-casing
            "values": {
                # A value set only in staging makes that key part of the shared
                # union (so dev/production show it as "Not set").
                "dev": {"api_key": "v1"},
                "staging": {"only_staging": "s"},
                "production": {},
            },
        },
    )
    out = S.read_bp_secrets(sd, "shop")
    assert out["keys"] == ["API_KEY", "ONLY_STAGING"]  # union, deduped, upper-cased
    assert out["values"]["dev"] == {"API_KEY": "v1"}
    assert out["values"]["staging"] == {"ONLY_STAGING": "s"}
    assert out["values"]["production"] == {}


def test_keys_are_union_across_stages(tmp_path):
    sd = str(tmp_path)
    # No explicit keys; each stage contributes a distinct key. The shared set is
    # their union so every stage is guided to fill in the others.
    S.write_bp_secrets(
        sd,
        "shop",
        {"keys": [], "values": {"dev": {"A": "1"}, "staging": {"B": "2"}}},
    )
    out = S.read_bp_secrets(sd, "shop")
    assert set(out["keys"]) == {"A", "B"}
    assert out["values"]["dev"] == {"A": "1"}
    assert out["values"]["staging"] == {"B": "2"}
    assert out["values"]["production"] == {}


def test_derived_env_file_and_dev_live_dev_share(tmp_path):
    sd = str(tmp_path)
    S.write_bp_secrets(
        sd,
        "shop",
        {"keys": ["API_KEY"], "values": {"dev": {"API_KEY": "dev-key"}}},
    )
    # dev and live-dev resolve to the SAME env file.
    dev_file = S.bp_secret_env_file(sd, "shop", "dev")
    live_file = S.bp_secret_env_file(sd, "shop", "live-dev")
    assert dev_file is not None and dev_file == live_file
    with open(dev_file) as f:
        assert f.read() == "API_KEY=dev-key\n"
    # production has no values → its env file is empty, but exists.
    prod_file = S.bp_secret_env_file(sd, "shop", "production")
    assert prod_file is not None
    with open(prod_file) as f:
        assert f.read() == ""


def test_read_missing_returns_empty_store(tmp_path):
    out = S.read_bp_secrets(str(tmp_path), "never-saved")
    assert out == {"keys": [], "values": {"dev": {}, "staging": {}, "production": {}}}


def test_env_files_live_under_bp_slug_dir(tmp_path):
    sd = str(tmp_path)
    S.write_bp_secrets(sd, "My Shop", {"keys": ["K"], "values": {"dev": {"K": "v"}}})
    # Slug is sanitised; the canonical JSON + per-realm files live under bp/.
    assert os.path.exists(os.path.join(sd, "bp", "my-shop.json"))
    assert os.path.exists(os.path.join(sd, "bp", "my-shop", "dev"))
