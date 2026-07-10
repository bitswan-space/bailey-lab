"""Off-site tier for per-BP snapshots, layered on the restic system.

Manual snapshots (see `snapshot_service.py`) are pushed into the same
restic repository the whole-server disaster-recovery backups use
(`backup_service.py`, restic through the AOC proxy), tagged so they can
be listed, fetched and pruned per business process:

    --tag bp-snapshot --tag bp:{bp} --tag stage:{stage} --tag id:{snapshot_id}

Push state lives in a per-BP index file `{snapshots}/{bp}/.offsite-index.json`
(dot-prefixed → invisible to the local snapshot lister). The index also
carries each pushed snapshot's manifest, so snapshots whose local files
are gone can still be listed and fetched. It is a cache: it can always be
rebuilt from the restic repo (`rebuild_index`).

Everything here degrades silently when the workspace has no AOC
connection — pushes no-op, local snapshot flows are unaffected.

Off-site copies outlive local deletion: they are pruned only by the BP's
retention policy (bitswan.yaml `backups.{bp}.retention`), applied nightly
by `apply_offsite_retention`.
"""

import asyncio
import json
import logging
import os
import shutil
import tempfile
from datetime import datetime, timezone

from app.services import backup_service
from app.services.snapshot_service import (
    get_snapshot_service,
    validate_bp_slug,
    validate_snapshot_id,
    validate_stage_name,
)

logger = logging.getLogger(__name__)

INDEX_FILE = ".offsite-index.json"
OFFSITE_TAG = "bp-snapshot"

# Strong references to in-flight push tasks (mirrors snapshot_runner._bg_tasks).
_push_tasks: set[asyncio.Task] = set()

# Serializes read-modify-write cycles on index files.
_index_lock = asyncio.Lock()


def offsite_enabled() -> bool:
    return backup_service.is_configured()


def _index_path(bp_slug: str) -> str:
    validate_bp_slug(bp_slug)
    return os.path.join(get_snapshot_service().snapshots_root, bp_slug, INDEX_FILE)


def load_index(bp_slug: str) -> dict:
    """The BP's off-site index; empty structure when missing or corrupt."""
    path = _index_path(bp_slug)
    try:
        with open(path) as f:
            index = json.load(f)
        if not isinstance(index.get("entries"), dict):
            raise ValueError("malformed index")
        return index
    except FileNotFoundError:
        return {"version": 1, "entries": {}}
    except (json.JSONDecodeError, ValueError, OSError) as e:
        logger.warning(
            "Corrupt off-site index for %s (%s) — treating as empty", bp_slug, e
        )
        return {"version": 1, "entries": {}}


def _write_index(bp_slug: str, index: dict) -> None:
    path = _index_path(bp_slug)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(index, f, indent=2)
    os.replace(tmp, path)


async def _update_entry(bp_slug: str, snapshot_id: str, entry: dict | None) -> None:
    """Atomically upsert (or delete, entry=None) one index entry."""
    async with _index_lock:
        index = load_index(bp_slug)
        if entry is None:
            index["entries"].pop(snapshot_id, None)
        else:
            index["entries"][snapshot_id] = entry
        _write_index(bp_slug, index)


def offsite_status_for(bp_slug: str) -> dict[str, dict]:
    """snapshot_id -> index entry. Filesystem only — safe in request paths."""
    return load_index(bp_slug)["entries"]


# -- push ---------------------------------------------------------------------


def _snapshot_tags(bp_slug: str, stage: str, snapshot_id: str) -> list[str]:
    return [
        "--tag",
        OFFSITE_TAG,
        "--tag",
        f"bp:{bp_slug}",
        "--tag",
        f"stage:{stage}",
        "--tag",
        f"id:{snapshot_id}",
    ]


def spawn_push(bp_slug: str, stage: str, snapshot_id: str, manifest: dict) -> None:
    """Fire-and-forget off-site push. Never raises; no-op without AOC."""
    if not offsite_enabled():
        return
    task = asyncio.create_task(push_snapshot(bp_slug, stage, snapshot_id, manifest))
    _push_tasks.add(task)
    task.add_done_callback(_push_tasks.discard)


async def push_snapshot(
    bp_slug: str, stage: str, snapshot_id: str, manifest: dict
) -> None:
    """Push one snapshot dir into the restic repo. A failure marks the index
    entry `failed` (retried by the nightly reconcile) — it must never
    propagate into snapshot creation."""
    try:
        if not offsite_enabled():
            return
        validate_stage_name(stage)
        validate_snapshot_id(snapshot_id)
        snap_dir = get_snapshot_service()._snapshot_dir(bp_slug, stage, snapshot_id)
        if not os.path.isdir(snap_dir):
            logger.warning("Off-site push: %s vanished before upload", snap_dir)
            return

        base_entry = {
            "stage": stage,
            "pushed_at": None,
            "restic_id": None,
            "error": None,
            "manifest": manifest,
        }
        await _update_entry(bp_slug, snapshot_id, {**base_entry, "status": "pending"})

        config = backup_service.get_backup_config()
        stdout, stderr, rc = await backup_service._run_restic(
            [
                "backup",
                snap_dir,
                *_snapshot_tags(bp_slug, stage, snapshot_id),
                "--json",
            ],
            config,
        )
        if rc != 0:
            logger.warning(
                "Off-site push of %s/%s/%s failed: %s",
                bp_slug,
                stage,
                snapshot_id,
                stderr.strip()[-500:],
            )
            await _update_entry(
                bp_slug,
                snapshot_id,
                {**base_entry, "status": "failed", "error": stderr.strip()[-500:]},
            )
            return

        restic_id = None
        for line in reversed(stdout.strip().splitlines()):
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("message_type") == "summary":
                restic_id = (msg.get("snapshot_id") or "")[:8] or None
                break

        await _update_entry(
            bp_slug,
            snapshot_id,
            {
                **base_entry,
                "status": "synced",
                "restic_id": restic_id,
                "pushed_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        logger.info(
            "Snapshot %s/%s/%s mirrored off-site (%s)",
            bp_slug,
            stage,
            snapshot_id,
            restic_id,
        )
    except Exception:
        logger.exception(
            "Off-site push of %s/%s/%s crashed", bp_slug, stage, snapshot_id
        )


# -- fetch --------------------------------------------------------------------


async def fetch_snapshot(
    bp_slug: str, stage: str, snapshot_id: str, progress=None
) -> dict:
    """Materialize an off-site snapshot back into the local store.

    Idempotent when the snapshot is already local. Raises LookupError for
    ids unknown both locally and off-site, RuntimeError on restic failure.
    Returns the snapshot's manifest.
    """
    validate_stage_name(stage)
    validate_snapshot_id(snapshot_id)
    service = get_snapshot_service()

    try:
        return service.get_snapshot(bp_slug, stage, snapshot_id)  # already local
    except LookupError:
        pass

    if not offsite_enabled():
        raise LookupError(
            f"Snapshot {snapshot_id} not found locally and off-site backups "
            "are not configured"
        )

    entry = offsite_status_for(bp_slug).get(snapshot_id)
    if entry is None or entry.get("status") != "synced":
        await rebuild_index(bp_slug)
        entry = offsite_status_for(bp_slug).get(snapshot_id)
    if entry is None or entry.get("status") != "synced":
        raise LookupError(f"Snapshot {snapshot_id} not found off-site")

    if progress:
        await progress("fetch_offsite", "Fetching snapshot from off-site storage...")

    stage_dir = service._stage_dir(bp_slug, stage)
    os.makedirs(stage_dir, exist_ok=True)
    # Dot-prefixed scratch inside the stage dir: invisible to the local
    # lister, and on the same filesystem so the final rename is atomic.
    scratch = tempfile.mkdtemp(prefix=f".fetch-{snapshot_id}-", dir=stage_dir)
    try:
        config = backup_service.get_backup_config()
        stdout, stderr, rc = await backup_service._run_restic(
            [
                "restore",
                "latest",
                "--tag",
                f"{OFFSITE_TAG},id:{snapshot_id}",
                "--target",
                scratch,
            ],
            config,
        )
        if rc != 0:
            raise RuntimeError(f"restic restore failed: {stderr.strip()[-500:]}")

        # restic recreates the snapshot's original absolute path inside the
        # target; the recorded BITSWAN_GITOPS_DIR may differ from ours, so
        # locate the snapshot dir by its manifest instead of by path math.
        manifest = None
        snap_src = None
        for root, _dirs, files in os.walk(scratch):
            if "manifest.json" in files:
                with open(os.path.join(root, "manifest.json")) as f:
                    candidate = json.load(f)
                if candidate.get("id") == snapshot_id:
                    manifest = candidate
                    snap_src = root
                    break
        if manifest is None or snap_src is None:
            raise RuntimeError(
                f"Off-site restore of {snapshot_id} produced no matching manifest"
            )

        final_dir = service._snapshot_dir(bp_slug, stage, snapshot_id)
        os.rename(snap_src, final_dir)
        logger.info(
            "Fetched snapshot %s/%s/%s from off-site", bp_slug, stage, snapshot_id
        )
        return manifest
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


# -- index rebuild / reconcile --------------------------------------------------


def _tag_value(tags: list[str], prefix: str) -> str | None:
    for tag in tags or []:
        if tag.startswith(prefix):
            return tag[len(prefix) :]
    return None


async def _remote_snapshots(bp_slug: str) -> list[dict] | None:
    """Raw restic snapshot objects for this BP, or None on restic failure."""
    config = backup_service.get_backup_config()
    stdout, _stderr, rc = await backup_service._run_restic(
        ["snapshots", "--json", "--tag", f"{OFFSITE_TAG},bp:{bp_slug}"], config
    )
    if rc != 0:
        return None
    try:
        return json.loads(stdout) or []
    except json.JSONDecodeError:
        return None


async def rebuild_index(bp_slug: str) -> dict:
    """Reconstruct the index from the restic repo (fresh/rebuilt server)."""
    if not offsite_enabled():
        return load_index(bp_slug)
    remote = await _remote_snapshots(bp_slug)
    if remote is None:
        logger.warning("Off-site index rebuild for %s: restic listing failed", bp_slug)
        return load_index(bp_slug)

    config = backup_service.get_backup_config()
    entries: dict[str, dict] = {}
    for snap in remote:
        tags = snap.get("tags") or []
        snapshot_id = _tag_value(tags, "id:")
        stage = _tag_value(tags, "stage:")
        paths = snap.get("paths") or []
        if not snapshot_id or not stage or not paths:
            continue
        short_id = snap.get("short_id") or (snap.get("id") or "")[:8]
        manifest = None
        stdout, _stderr, rc = await backup_service._run_restic(
            ["dump", short_id, f"{paths[0]}/manifest.json"], config
        )
        if rc == 0:
            try:
                manifest = json.loads(stdout)
            except json.JSONDecodeError:
                manifest = None
        if manifest is None:
            logger.warning(
                "Off-site rebuild: no readable manifest for %s (%s)",
                snapshot_id,
                short_id,
            )
            continue
        # Newest restic snapshot wins for duplicate ids (re-push after failure).
        entries[snapshot_id] = {
            "status": "synced",
            "stage": stage,
            "restic_id": short_id,
            "pushed_at": snap.get("time"),
            "error": None,
            "manifest": manifest,
        }

    async with _index_lock:
        index = load_index(bp_slug)
        index["entries"] = entries
        _write_index(bp_slug, index)
    logger.info("Rebuilt off-site index for %s: %d entries", bp_slug, len(entries))
    return {"version": 1, "entries": entries}


async def _reconcile_index(bp_slug: str) -> None:
    """Post-retention cleanup: drop entries restic no longer has, and retry
    failed pushes whose local snapshot dir still exists."""
    remote = await _remote_snapshots(bp_slug)
    if remote is None:
        return
    remote_ids = {_tag_value(s.get("tags") or [], "id:") for s in remote} - {None}

    service = get_snapshot_service()
    async with _index_lock:
        index = load_index(bp_slug)
        to_retry: list[tuple[str, str, dict]] = []
        for snapshot_id, entry in list(index["entries"].items()):
            if entry.get("status") == "synced" and snapshot_id not in remote_ids:
                del index["entries"][snapshot_id]  # pruned by retention
            elif entry.get("status") in ("failed", "pending"):
                stage = entry.get("stage")
                manifest = entry.get("manifest") or {}
                if stage and os.path.isdir(
                    service._snapshot_dir(bp_slug, stage, snapshot_id)
                ):
                    to_retry.append((stage, snapshot_id, manifest))
                else:
                    del index["entries"][snapshot_id]  # nothing left to push
        _write_index(bp_slug, index)

    for stage, snapshot_id, manifest in to_retry:
        await push_snapshot(bp_slug, stage, snapshot_id, manifest)


# -- retention ------------------------------------------------------------------


def _bps_with_index() -> list[str]:
    root = get_snapshot_service().snapshots_root
    if not os.path.isdir(root):
        return []
    return sorted(
        name
        for name in os.listdir(root)
        if os.path.isfile(os.path.join(root, name, INDEX_FILE))
    )


async def apply_offsite_retention() -> None:
    """Nightly: prune off-site snapshot copies per BP retention policy
    (bitswan.yaml backups.{bp}.retention), then reconcile indexes and run a
    single repo prune."""
    if not offsite_enabled():
        return
    from app.dependencies import get_automation_service

    config = backup_service.get_backup_config()
    svc = get_automation_service()
    forgot_any = False
    for bp_slug in _bps_with_index():
        try:
            retention = svc.read_backups(bp_slug).get("retention") or {}
        except Exception as e:
            logger.warning(
                "Off-site retention: read_backups(%s) failed: %s", bp_slug, e
            )
            continue
        keep_flags: list[str] = []
        for key, flag in (
            ("daily", "--keep-daily"),
            ("weekly", "--keep-weekly"),
            ("monthly", "--keep-monthly"),
        ):
            value = int(retention.get(key) or 0)
            if value > 0:
                keep_flags += [flag, str(value)]
        if not keep_flags:
            # restic rejects an empty policy — and an all-zero policy must
            # never be read as "forget everything".
            continue
        # --group-by host: the default host,paths grouping makes every
        # snapshot (unique path) a singleton that always survives --keep-*.
        _stdout, stderr, rc = await backup_service._run_restic(
            [
                "forget",
                "--tag",
                f"{OFFSITE_TAG},bp:{bp_slug}",
                "--group-by",
                "host",
                *keep_flags,
            ],
            config,
        )
        if rc != 0:
            logger.warning(
                "Off-site retention forget for %s failed: %s",
                bp_slug,
                stderr.strip()[-300:],
            )
            continue
        forgot_any = True
        await _reconcile_index(bp_slug)

    if forgot_any:
        _stdout, stderr, rc = await backup_service._run_restic(
            ["prune"], config, timeout=7200
        )
        if rc != 0:
            logger.warning("Off-site retention prune failed: %s", stderr.strip()[-300:])
