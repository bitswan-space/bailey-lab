"""Per-(BP, stage) secrets crypto + helpers: AES-256-GCM envelope with a
workspace-local key, value normalisation, and the derived plaintext env file.
The encrypt→bitswan.yaml→commit→decrypt round-trip is exercised live."""

import os

from app.services import bp_secrets as S


def test_realm_for_stage_shares_dev_and_live_dev():
    assert S.realm_for_stage("dev") == "dev"
    assert S.realm_for_stage("live-dev") == "dev"
    assert S.realm_for_stage("staging") == "staging"
    assert S.realm_for_stage("production") == "production"
    assert S.realm_for_stage("") == "production"


def test_encrypt_decrypt_round_trip_and_key_file(tmp_path):
    sd = str(tmp_path)
    values = {"API_KEY": "s3cr3t", "DB_URL": "postgres://x"}
    blob = S.encrypt_secrets(sd, values)
    # Ciphertext is opaque base64 — the plaintext never appears in it.
    assert "s3cr3t" not in blob
    assert S.decrypt_secrets(sd, blob) == values
    # The key is written 0600 on the volume and reused.
    key_path = os.path.join(sd, ".aes-key")
    assert os.path.exists(key_path)
    assert oct(os.stat(key_path).st_mode & 0o777) == "0o600"


def test_each_encrypt_uses_a_fresh_nonce(tmp_path):
    sd = str(tmp_path)
    v = {"A": "1"}
    assert S.encrypt_secrets(sd, v) != S.encrypt_secrets(sd, v)  # random nonce


def test_decrypt_garbage_returns_empty(tmp_path):
    assert S.decrypt_secrets(str(tmp_path), "not-valid-base64-blob!!") == {}


def test_decrypt_with_wrong_key_returns_empty(tmp_path):
    sd1 = str(tmp_path / "a")
    sd2 = str(tmp_path / "b")
    os.makedirs(sd1)
    os.makedirs(sd2)
    blob = S.encrypt_secrets(sd1, {"A": "1"})
    # Different secrets dir = different key → can't decrypt (GCM auth fails).
    assert S.decrypt_secrets(sd2, blob) == {}


def test_normalise_values_uppercases_and_keeps_empty():
    out = S.normalise_values({"api_key": "v", "  ": "x", "EMPTY": "", "n": None})
    assert out == {"API_KEY": "v", "EMPTY": "", "N": ""}  # blank key dropped


def test_materialize_env_skips_empty_values(tmp_path):
    sd = str(tmp_path)
    path = S.materialize_env(
        sd, "shop", "dev", {"API_KEY": "v", "UNSET": "", "DB": "x"}
    )
    assert path == os.path.join(sd, "bp", "shop", "dev")
    with open(path) as f:
        body = f.read()
    assert "API_KEY=v\n" in body and "DB=x\n" in body
    assert "UNSET" not in body  # empty (declared-but-unset) not injected
    assert oct(os.stat(path).st_mode & 0o777) == "0o600"


def test_env_file_path_uses_realm_and_slug(tmp_path):
    sd = str(tmp_path)
    # live-dev resolves to the dev realm; BP name is slugified.
    assert S.env_file_path(sd, "My Shop", "live-dev") == os.path.join(
        sd, "bp", "my-shop", "dev"
    )
