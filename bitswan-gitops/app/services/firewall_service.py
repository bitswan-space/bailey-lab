"""Egress-firewall helpers: posture, allow-list extraction, and the blocked/
observed-attempt telemetry the gateway emits.

Firewall RULES (decisions) are audited in bitswan.yaml under the top-level
`firewall` key (see AutomationService.read/set/delete/promote_firewall). Attempt
TELEMETRY (hosts a BP tried to reach) is high-churn and non-authoritative, so it
lives in a non-git cache like the supply-chain SBOM cache, folded from the
per-(bp,realm) JSONL the gateway appends to a shared volume.

A BP realm's allow-list is also SEEDED with the platform's own outbound
dependency on its first deploy — see `seed_default_rules_for_members`.
"""

import json
import logging
import os
import re
from datetime import date
from urllib.parse import urlsplit

from app.services.bp_secrets import realm_for_stage
from app.utils import bp_from_relative_path

logger = logging.getLogger(__name__)

# dev/live-dev only observe+log; staging/production default to enforcing.
_ENFORCE_REALMS = ("staging", "production")


def posture_for(realm: str) -> str:
    return "enforce" if realm in _ENFORCE_REALMS else "monitor"


# ── default (seeded) allow-list ──────────────────────────────────────────────
# A business process's allow-list starts EMPTY, so every host it dials lands in
# the needs-review feed. One host is different in kind: the AOC's Keycloak. The
# platform itself injects it into every worker as KEYCLOAK_URL (the driver's
# dockerdriver/entry.go stamps it onto each compose entry) and the automation
# templates call it — so the firewall was flagging, on every new BP, a call the
# platform provisioned (#311). Seed exactly that one host, and only on a BP
# realm's FIRST deploy.
#
# NOT derived from BITSWAN_URL_SUFFIX: Bailey and the AOC can live on different
# hosts, so Bailey's own suffix says nothing about where AOC's Keycloak is. The
# only trustworthy source is the KEYCLOAK_URL the platform is configured with —
# the same value aoc.workerIdentityEnv resolves as the OIDC issuer.

# The dashboard renders an ALLOWED row as "<purpose> · by <by> · <at>", so a
# seeded rule reads as an explicitly revocable platform default, not a mystery.
_DEFAULT_RULE_BY = "bitswan (platform default)"
_KEYCLOAK_PURPOSE = (
    "AOC identity provider (KEYCLOAK_URL): OIDC discovery, JWKS and token calls"
)

# A bare hostname (or IPv4 literal). Deliberately narrow — no "*", no scheme,
# no port, no path, no empty labels: a seeded rule is one exact host, never a
# wildcard and never a whole domain.
_BARE_HOST_RE = re.compile(
    r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$"
)


def bare_host(url: str) -> str:
    """The bare hostname of a URL — scheme, userinfo, port and path stripped —
    or "" when it cannot be determined.

    Mirrors the driver's KEYCLOAK_URL handling (dockerdriver/entry.go): the
    issuer may carry a trailing `/realms/<realm>`, which is cut off first; the
    host is the same either way. Anything that does not reduce to a single valid
    hostname yields "" — never a guess.
    """
    raw = (url or "").strip()
    if not raw:
        return ""
    idx = raw.rfind("/realms/")
    if idx >= 0:
        raw = raw[:idx]
    if "://" not in raw:
        # urlsplit only populates netloc behind a scheme or a leading "//",
        # so a bare "keycloak.example.com:8443/x" would otherwise parse as a path.
        raw = "//" + raw
    try:
        host = urlsplit(raw).hostname or ""
    except ValueError:  # e.g. a non-numeric port
        return ""
    host = host.strip().strip(".").lower()
    return host if _BARE_HOST_RE.match(host) else ""


def default_allowed_hosts() -> list[str]:
    """The hosts seeded into a BP realm's allow-list on its first deploy.

    FAILS CLOSED: an unset, empty or unparseable KEYCLOAK_URL seeds NOTHING, so
    the host simply keeps showing up under needs-review for manual approval —
    exactly the behaviour before this default existed. There is deliberately no
    fallback: a misconfigured value must never silently widen egress.
    """
    host = bare_host(os.environ.get("KEYCLOAK_URL", ""))
    return [host] if host else []


def seed_default_rules_for_members(bs_yaml: dict, members: list[dict]) -> list[tuple]:
    """First-deploy seeding of the default egress allow-list, called while
    bs_yaml is being prepared for a deploy's single write + commit (so the
    seeded rules are versioned in bitswan.yaml and show up in the BP's
    deployment history like any other firewall change).

    For each member's (bp, realm): when that realm has NO firewall node yet,
    create it with the realm's default posture and the default allowed hosts. A
    realm that already HAS a node is left completely untouched — which is what
    makes an operator's decision stick:

      * approve/deny (set_firewall_rule), promote and rollback all create the
        node, and
      * delete_firewall_rule removes only the *rule*, leaving the node (with
        its posture) behind,

    so once a (bp, realm) has been touched at all — including revoking or
    denying a seeded host — no later deploy re-seeds it. Allow-lists an
    operator has already curated are never rewritten, for the same reason.

    Returns the (bp, realm, host) tuples seeded. Best-effort: never raises.
    """
    seeded: list[tuple] = []
    try:
        hosts = default_allowed_hosts()
        if not hosts:
            return seeded  # fail closed: nothing configured, nothing seeded
        at = date.today().strftime("%b %-d, %Y")
        for m in members or []:
            # Same bp derivation the caller uses to decide which per-BP files to
            # write, so a seeded node always lands in a slice that gets persisted.
            # A top-level automation (no bp path segment) has no BP firewall node.
            bp = bp_from_relative_path((m or {}).get("relative_path"))
            if not bp:
                continue
            stage = (m or {}).get("stage") or "production"
            realm = realm_for_stage(stage)
            if not realm:
                continue
            by_bp = bs_yaml.setdefault("firewall", {}).setdefault(bp, {})
            if realm in by_bp:
                continue  # operator territory — never re-seed
            by_bp[realm] = {
                "posture": posture_for(realm),
                "rules": {
                    h: {
                        "status": "allowed",
                        "purpose": _KEYCLOAK_PURPOSE,
                        "by": _DEFAULT_RULE_BY,
                        "at": at,
                    }
                    for h in hosts
                },
            }
            seeded.extend((bp, realm, h) for h in hosts)
            logger.info(
                "firewall: seeded default allow-list for %s/%s: %s",
                bp,
                realm,
                ", ".join(hosts),
            )
    except Exception as e:  # never block a deploy on a default
        logger.warning("firewall default seeding failed (non-fatal): %s", e)
    return seeded


def firewall_dir() -> str:
    bs_home = os.environ.get("BITSWAN_GITOPS_DIR", "/mnt/repo/pipeline")
    return os.path.join(bs_home, "firewall")


def attempts_log_path(bp: str, realm: str) -> str:
    """Per-(bp,realm) JSONL the gateway appends one record per blocked/observed
    connection to (shared into the gateway container)."""
    return os.path.join(firewall_dir(), f"{bp}__{realm}.attempts.jsonl")


def read_attempts(bp: str, realm: str) -> dict:
    """Aggregate the gateway's JSONL into {host: {count, first, last, proto}}.
    Tolerates a missing/partial file (telemetry, best-effort)."""
    path = attempts_log_path(bp, realm)
    agg: dict[str, dict] = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                host = rec.get("host")
                if not host:
                    continue
                at = rec.get("at")
                e = agg.setdefault(
                    host,
                    {"count": 0, "first": at, "last": at, "proto": rec.get("proto")},
                )
                e["count"] += 1
                if at:
                    e["last"] = at
                    if not e["first"]:
                        e["first"] = at
    except FileNotFoundError:
        pass
    except Exception:
        pass
    return agg


def delete_bp_attempt_logs(bp: str) -> int:
    """Unlink every per-(bp, realm) gateway attempts log (BP delete). Returns
    how many files were removed."""
    import glob

    removed = 0
    for path in glob.glob(os.path.join(firewall_dir(), f"{bp}__*.attempts.jsonl")):
        try:
            os.unlink(path)
            removed += 1
        except OSError:
            pass
    return removed
