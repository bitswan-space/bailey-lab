"""Egress-firewall helpers: posture, allow-list extraction, and the blocked/
observed-attempt telemetry the gateway emits.

Firewall RULES (decisions) are audited in bitswan.yaml under the top-level
`firewall` key (see AutomationService.read/set/delete/promote_firewall). Attempt
TELEMETRY (hosts a BP tried to reach) is high-churn and non-authoritative, so it
lives in a non-git cache like the supply-chain SBOM cache, folded from the
per-(bp,realm) JSONL the gateway appends to a shared volume.
"""

import json
import os

# dev/live-dev only observe+log; staging/production default to enforcing.
_ENFORCE_REALMS = ("staging", "production")


def posture_for(realm: str) -> str:
    return "enforce" if realm in _ENFORCE_REALMS else "monitor"


def firewall_dir() -> str:
    bs_home = os.environ.get("BITSWAN_GITOPS_DIR", "/mnt/repo/pipeline")
    return os.path.join(bs_home, "firewall")


def attempts_log_path(bp: str, realm: str) -> str:
    """Per-(bp,realm) JSONL the gateway appends one record per blocked/observed
    connection to (shared into the gateway container)."""
    return os.path.join(firewall_dir(), f"{bp}__{realm}.attempts.jsonl")


def allowed_hosts(bs_yaml: dict, bp: str, realm: str) -> list[str]:
    """The allow-listed hostnames for a BP+realm (status == allowed)."""
    rules = (((bs_yaml.get("firewall") or {}).get(bp) or {}).get(realm) or {}).get(
        "rules"
    ) or {}
    return sorted(h for h, r in rules.items() if (r or {}).get("status") == "allowed")


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
