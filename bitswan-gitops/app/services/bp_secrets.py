"""Per-business-process secrets.

Replaces the old `automation.toml [secrets]` groups. Each business process has
ONE set of secret KEY names shared across stages, with per-stage VALUES (set
from the dashboard Deployments → Secrets tab). `dev` and `live-dev` share the
`dev` realm.

Storage (under the secrets volume, never in git):
  <secrets>/bp/<slug>.json
      Canonical store: {"keys": [...], "values": {"dev": {KEY: val}, ...}}.
      The explicit `keys` list lets a secret name exist even before any stage
      has a value (the dashboard shows it as "Not set").
  <secrets>/bp/<slug>/<realm>
      Derived env file (KEY=VALUE for non-empty values) that each of the BP's
      containers loads via `env_file`. Keeping values here — not in the
      generated docker-compose.yaml — keeps them out of git.
"""

import json
import os

from app.utils import sanitize_automation_name

REALMS = ("dev", "staging", "production")


def realm_for_stage(stage: str) -> str:
    """Map a deployment stage to its secret realm. `live-dev` shares `dev`;
    an empty stage is treated as production (matches bitswan.yaml normalisation)."""
    if stage in ("live-dev", "dev"):
        return "dev"
    if stage in ("", "production"):
        return "production"
    return stage


def _bp_slug(bp: str) -> str:
    return sanitize_automation_name(bp)


def _bp_dir(secrets_dir: str, bp: str) -> str:
    return os.path.join(secrets_dir, "bp", _bp_slug(bp))


def _store_path(secrets_dir: str, bp: str) -> str:
    return os.path.join(secrets_dir, "bp", f"{_bp_slug(bp)}.json")


def _empty_store() -> dict:
    return {"keys": [], "values": {r: {} for r in REALMS}}


def read_bp_secrets(secrets_dir: str, bp: str) -> dict:
    """The BP's secret store: {"keys": [...], "values": {realm: {KEY: val}}}.
    Returns an empty store when nothing has been saved yet."""
    path = _store_path(secrets_dir, bp)
    if not os.path.exists(path):
        return _empty_store()
    try:
        with open(path) as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return _empty_store()
    return _normalise(raw)


def _normalise(data: dict) -> dict:
    """Validate + canonicalise a store. `keys` is the UNION of the declared key
    names and every key that has a value in any stage — so a secret set in one
    stage is a shared name across all stages, and the dashboard can flag it as
    "Not set" in the stages still missing it (guiding the user to fill it in).
    Keys are upper-cased + de-duplicated; values are strings keyed by realm."""
    keys: list[str] = []
    seen: set[str] = set()

    def _add(raw_key) -> str | None:
        name = str(raw_key).strip().upper()
        if name and name not in seen:
            seen.add(name)
            keys.append(name)
        return name or None

    for k in data.get("keys") or []:
        _add(k)

    values_in = data.get("values") or {}
    # Per-realm values, upper-cased; non-empty only. Every key seen here joins
    # the shared union.
    realm_vals: dict[str, dict[str, str]] = {r: {} for r in REALMS}
    for r in REALMS:
        for raw_key, v in (values_in.get(r) or {}).items():
            if v is None or str(v) == "":
                continue
            name = _add(raw_key)
            if name:
                realm_vals[r][name] = str(v)
    return {"keys": keys, "values": realm_vals}


def write_bp_secrets(secrets_dir: str, bp: str, data: dict) -> dict:
    """Persist the BP's secret store and (re)derive its per-realm env files.
    Returns the normalised store."""
    store = _normalise(data)
    bp_root = os.path.join(secrets_dir, "bp")
    os.makedirs(bp_root, exist_ok=True)

    # Canonical JSON (atomic write).
    store_path = _store_path(secrets_dir, bp)
    tmp = store_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(store, f, indent=2, sort_keys=True)
    os.chmod(tmp, 0o600)
    os.replace(tmp, store_path)

    # Derived per-realm env files (what containers load).
    bp_dir = _bp_dir(secrets_dir, bp)
    os.makedirs(bp_dir, exist_ok=True)
    for realm in REALMS:
        env_path = os.path.join(bp_dir, realm)
        lines = [f"{k}={v}" for k, v in store["values"][realm].items()]
        tmp = env_path + ".tmp"
        with open(tmp, "w") as f:
            f.write("".join(f"{line}\n" for line in lines))
        os.chmod(tmp, 0o600)
        os.replace(tmp, env_path)
    return store


def bp_secret_env_file(secrets_dir: str, bp: str, stage: str) -> str | None:
    """Path to the env file a BP's containers should load for `stage`, or None
    when the BP has no secrets file for that realm yet."""
    path = os.path.join(_bp_dir(secrets_dir, bp), realm_for_stage(stage))
    return path if os.path.exists(path) else None
