"""Out-of-scope CVE markings, stored IN THE SOURCE TREE.

A vulnerability being "out of scope" is a property of the code, not of a
deployment — so it lives with the code: one `cve-waivers.yaml` per business
process at the BP root (`<copies>/<copy>/<bp>/cve-waivers.yaml`), versioned in
git and carried to `main` by the BP-scoped Sync & Deploy.

The file sits BESIDE the automation source directories, never inside one, so it
is outside the content-addressed image build (`dirs_to_merge` are the automation
dirs) — marking a CVE out of scope never rebuilds or rescans the image.

Decisions are made from the Checks tab (which operates on a copy); the Supply
chain tab reads them from `main` read-only, for audit.
"""

import os

import yaml

from app.services.bp_databases import validate_bp_slug
from app.services.template_service import _commit, _copies_dir

WAIVER_FILENAME = "cve-waivers.yaml"


def _waiver_path(bp: str, copy: str | None) -> str:
    return os.path.join(_copies_dir(), copy or "main", bp, WAIVER_FILENAME)


def read_waivers(bp: str, copy: str | None = None) -> dict:
    """The `{ "<package>|<cve>": {package, cve, comment, by, at} }` map for a
    BP in a copy (main when copy is None). Empty when the file is absent."""
    validate_bp_slug(bp)
    path = _waiver_path(bp, copy)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path) as f:
            data = yaml.safe_load(f) or {}
    except Exception:
        return {}
    waivers = data.get("waivers") if isinstance(data, dict) else None
    return waivers if isinstance(waivers, dict) else {}


def waiver_list(bp: str, copy: str | None = None) -> list[dict]:
    """Waivers as a list (the shape the supply-chain report + UI consume)."""
    return list(read_waivers(bp, copy).values())


async def _write(bp: str, copy: str | None, waivers: dict, message: str) -> None:
    path = _waiver_path(bp, copy)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        yaml.safe_dump({"waivers": waivers}, f, sort_keys=True)
    # Commit in the copy's checkout so the marking is versioned and rides the
    # BP-scoped sync to main alongside the code it concerns.
    await _commit(os.path.join(_copies_dir(), copy or "main"), message)


async def set_waiver(
    bp: str,
    copy: str | None,
    package: str,
    cve: str,
    comment: str,
    by: str | None,
    at: str,
) -> list[dict]:
    """Mark a CVE out of scope for a BP (in a copy) and commit. `at` is passed
    in (the service stamps it) so this stays free of wall-clock calls."""
    waivers = read_waivers(bp, copy)
    waivers[f"{package}|{cve}"] = {
        "package": package,
        "cve": cve,
        "comment": comment,
        "by": by or "unknown",
        "at": at,
    }
    await _write(bp, copy, waivers, f"cve out of scope: {cve} ({package}) for {bp}")
    return waiver_list(bp, copy)


async def unset_waiver(bp: str, copy: str | None, package: str, cve: str) -> list[dict]:
    """Restore a CVE to in-scope for a BP (in a copy) and commit."""
    waivers = read_waivers(bp, copy)
    if waivers.pop(f"{package}|{cve}", None) is not None:
        await _write(
            bp, copy, waivers, f"cve back in scope: {cve} ({package}) for {bp}"
        )
    return waiver_list(bp, copy)
