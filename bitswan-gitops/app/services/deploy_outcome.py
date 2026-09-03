import json
import logging
import os
import re
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_DIRNAME = ".deploy-outcome"

ACTIONABLE_CAUSE_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("disk_full", re.compile(r"no space left on device|disk quota exceeded", re.I)),
]


def classify_failure(error: str | None) -> str | None:
    if not error:
        return None
    for cause, pattern in ACTIONABLE_CAUSE_PATTERNS:
        if pattern.search(error):
            return cause
    return None


def _outcome_dir() -> str:
    gitops_root = os.environ.get("BITSWAN_GITOPS_DIR", "/mnt/repo/pipeline")
    return os.path.join(gitops_root, "gitops", _DIRNAME)


def _marker_name(bp: str, stage: str, copy: str | None) -> str:
    parts = [bp, stage or "production"]
    if copy:
        parts.append("copy-" + copy)
    return re.sub(r"[^A-Za-z0-9_.-]", "_", "__".join(parts))


def record(
    bp: str,
    stage: str,
    copy: str | None,
    status: str,
    error: str | None = None,
    step: str | None = None,
) -> None:
    try:
        directory = _outcome_dir()
        os.makedirs(directory, exist_ok=True)
        payload = {
            "bp": bp,
            "stage": stage,
            "copy": copy,
            "status": status,
            "error": error,
            "cause": classify_failure(error) if status == "failed" else None,
            "step": step,
            "at": datetime.now(timezone.utc).isoformat(),
        }
        path = os.path.join(directory, _marker_name(bp, stage, copy))
        partial = path + ".tmp"
        with open(partial, "w") as f:
            json.dump(payload, f)
        os.replace(partial, path)
    except (OSError, TypeError, ValueError):
        logger.warning(
            "recording deploy outcome failed for %s/%s", bp, stage, exc_info=True
        )


def read(bp: str, stage: str, copy: str | None = None) -> dict | None:
    try:
        with open(os.path.join(_outcome_dir(), _marker_name(bp, stage, copy))) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def clear(bp: str, stage: str, copy: str | None = None) -> None:
    try:
        os.remove(os.path.join(_outcome_dir(), _marker_name(bp, stage, copy)))
    except OSError:
        pass
