"""Per-(business-process, stage) secrets — encrypted at rest, versioned in git.

Each stage of each BP has its OWN independent secret set ({KEY: value}). The
values are AES-256-GCM encrypted with a workspace-local key and the ciphertext
is stored in `bitswan.yaml` under a top-level `secrets[<bp>][<realm>]` map, so
secrets are versioned with the deploy history and roll back per stage — but
only ciphertext is ever in git. dev and live-dev share the `dev` realm.

The plaintext key never leaves the secrets volume:
  <secrets>/.aes-key          32-byte AES key (0600), auto-generated, NOT in git.
  <secrets>/bp/<slug>/<realm> derived plaintext env file (KEY=VALUE, non-empty
                              only) that the BP's containers load via env_file —
                              re-materialised from the encrypted blob at deploy.
"""

import base64
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.utils import sanitize_automation_name

REALMS = ("dev", "staging", "production")
_KEY_BYTES = 32
_NONCE_BYTES = 12


def realm_for_stage(stage: str) -> str:
    """Map a deployment stage to its secret realm. live-dev shares dev; an
    empty stage is production (matches bitswan.yaml normalisation)."""
    if stage in ("live-dev", "dev"):
        return "dev"
    if stage in ("", "production"):
        return "production"
    return stage


def _slug(bp: str) -> str:
    return sanitize_automation_name(bp)


# ── AES key + envelope ──────────────────────────────────────────────────────
def _load_key(secrets_dir: str) -> bytes:
    """The workspace-local AES key, generated (0600) on first use. Lives on the
    secrets volume only — never committed to git."""
    path = os.path.join(secrets_dir, ".aes-key")
    if os.path.exists(path):
        with open(path, "rb") as f:
            key = f.read()
        if len(key) == _KEY_BYTES:
            return key
    os.makedirs(secrets_dir, exist_ok=True)
    key = os.urandom(_KEY_BYTES)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(key)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return key


def encrypt_secrets(secrets_dir: str, values: dict) -> str:
    """Encrypt a stage's {KEY: value} map to a base64(nonce + GCM ciphertext)
    string for storage in bitswan.yaml."""
    aes = AESGCM(_load_key(secrets_dir))
    nonce = os.urandom(_NONCE_BYTES)
    ct = aes.encrypt(nonce, json.dumps(values).encode("utf-8"), None)
    return base64.b64encode(nonce + ct).decode("ascii")


def decrypt_secrets(secrets_dir: str, blob: str) -> dict:
    """Decrypt a base64(nonce + ciphertext) blob back to {KEY: value}. Returns
    {} if the blob is unreadable (e.g. the key was rotated/lost)."""
    try:
        raw = base64.b64decode(blob)
        aes = AESGCM(_load_key(secrets_dir))
        pt = aes.decrypt(raw[:_NONCE_BYTES], raw[_NONCE_BYTES:], None)
        data = json.loads(pt.decode("utf-8"))
        return (
            {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}
        )
    except Exception:
        return {}


def normalise_values(values: dict) -> dict:
    """Upper-case keys, stringify values, drop blank key names. Empty string
    values are kept (a declared-but-unset secret); env derivation skips them."""
    out: dict[str, str] = {}
    for k, v in (values or {}).items():
        name = str(k).strip().upper()
        if name:
            out[name] = "" if v is None else str(v)
    return out


# ── derived plaintext env file (what containers load) ───────────────────────
def env_file_path(secrets_dir: str, bp: str, stage: str) -> str:
    return os.path.join(secrets_dir, "bp", _slug(bp), realm_for_stage(stage))


def materialize_env(secrets_dir: str, bp: str, stage: str, values: dict) -> str:
    """(Re)write the stage's plaintext env file from decrypted values
    (non-empty only) and return its path."""
    path = env_file_path(secrets_dir, bp, stage)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lines = [f"{k}={v}" for k, v in values.items() if str(v).strip() != ""]
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write("".join(f"{line}\n" for line in lines))
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return path
