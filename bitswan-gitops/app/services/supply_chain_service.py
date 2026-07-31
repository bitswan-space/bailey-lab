"""Supply-chain scanning — syft SBOM + grype CVEs per image, cached on disk.

On first build of an image we run **syft** to produce an SBOM (the package list)
and **grype** to find CVEs against it; a daily job re-runs grype (new CVEs land
against unchanged images over time). An image's content is immutable, so results
are cached by the docker **image id** under a non-git cache dir:

  <bs_home>/supply-chain/<image_id>.sbom.json   syft SBOM (immutable; built once)
  <bs_home>/supply-chain/<image_id>.cve.json    grype matches + scanned_at (refreshed daily)

Everything degrades honestly: a missing binary / vuln-DB / unparseable output is
recorded as an "unavailable" marker rather than crashing a build or a request.
"""

import asyncio
import json
import logging
import os
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


async def _broadcast_scanned(image_id: str, status: str) -> None:
    """Tell SSE subscribers a supply-chain scan just finished, so the open
    Checks / Supply chain panel refreshes itself the moment results exist — the
    user never has to come back and re-open the tab. Best-effort: a notify
    failure must never surface as a scan error."""
    try:
        from app.event_broadcaster import event_broadcaster

        await event_broadcaster.broadcast(
            "supply_chain", {"image_id": image_id, "status": status}
        )
    except Exception as e:  # noqa: BLE001
        logger.debug("supply_chain broadcast failed: %s", e)


_SEVERITIES = ("critical", "high", "medium", "low")


def _norm_sev(s: str | None) -> str:
    """Map grype severities to the four buckets the UI renders (negligible /
    unknown / blank fold into 'low')."""
    s = (s or "").strip().lower()
    return s if s in _SEVERITIES else "low"


def supply_chain_dir() -> str:
    bs_home = os.environ.get("BITSWAN_GITOPS_DIR", "/mnt/repo/pipeline")
    return os.path.join(bs_home, "supply-chain")


def _key(image_id: str) -> str:
    """Filesystem-safe cache key from a docker image id (or tag fallback)."""
    return (image_id or "unknown").replace("sha256:", "").replace("/", "_").replace(
        ":", "_"
    )[:80] or "unknown"


def _sbom_path(d: str, k: str) -> str:
    return os.path.join(d, f"{k}.sbom.json")


def _cve_path(d: str, k: str) -> str:
    return os.path.join(d, f"{k}.cve.json")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_write(path: str, text: str) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def _write_unavailable(path: str, reason: str) -> None:
    _atomic_write(
        path,
        json.dumps(
            {"scanned_at": _now(), "status": "unavailable", "reason": reason[:300]}
        ),
    )


async def _run(
    *cmd: str, timeout: int = 600, env: dict | None = None
) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return 124, b"", b"timed out"
    return proc.returncode or 0, out, err


# The vulnerability DB has a SINGLE owner: the automation-server daemon. It
# downloads and refreshes it once per host per day into a shared volume that
# every workspace's gitops mounts READ-ONLY (GRYPE_DB_CACHE_DIR). A workspace
# therefore never updates the DB itself — that would fight the read-only mount
# and duplicate the daemon's work.
#
# Two grype knobs enforce that here. grype's built-in auto-update is ON by
# default and, the moment the DB looks stale, tries to write the mount — which
# on a read-only mount fails with a confusing "permission denied" and takes the
# whole scan down. We turn it OFF, and turn OFF grype's DB age validation too:
# freshness is the daemon's responsibility, so a scan must trust the mounted DB
# as-is (and keep working through a brief lag in the daemon's daily refresh)
# rather than reject it and go dark. Every grype invocation runs with this env.
def _grype_env() -> dict:
    return {
        **os.environ,
        "GRYPE_DB_AUTO_UPDATE": "false",
        "GRYPE_DB_VALIDATE_AGE": "false",
    }


# Confirm the daemon-owned DB is present before the first scan. A freshly-built
# gitops image ships WITHOUT the DB and the daemon downloads it at runtime, so an
# early scan could otherwise find a missing DB and produce no CVE matches (the
# panel sits in "Scan pending"/empty). We just wait for the daemon's copy to
# appear — we never fetch it ourselves. Cached for the process lifetime once
# ready; guarded by a lock so concurrent scans don't each shell out to check.
_db_ready = False
_db_lock: asyncio.Lock | None = None


async def ensure_vuln_db() -> bool:
    """Report whether grype's (daemon-owned, read-only) vulnerability DB is ready
    to scan against. Never downloads or updates it — the automation-server daemon
    is the sole writer. Best-effort: True once the DB is present, False while the
    daemon's first refresh is still in flight. Never raises."""
    global _db_ready, _db_lock
    if _db_ready:
        return True
    if _db_lock is None:
        _db_lock = asyncio.Lock()
    async with _db_lock:
        if _db_ready:
            return True
        # `grype db status` exits non-zero when the DB is missing. With age
        # validation off it accepts a present-but-slightly-stale daemon DB.
        rc, _, _ = await _run("grype", "db", "status", timeout=60, env=_grype_env())
        if rc == 0:
            _db_ready = True
        # If not ready, the daemon's refresh is still in flight — don't cache the
        # negative, so a later scan rechecks once the daemon has populated it.
        return _db_ready


# ── parsing ──────────────────────────────────────────────────────────────────
def parse_sbom(raw: dict) -> list[dict]:
    """syft-json `artifacts[]` → [{name, version, type}] (named packages only)."""
    out: list[dict] = []
    for a in raw.get("artifacts") or []:
        name = a.get("name")
        if name:
            out.append(
                {
                    "name": name,
                    "version": a.get("version") or "",
                    "type": a.get("type") or "",
                }
            )
    return out


def parse_grype(raw: dict) -> list[dict]:
    """grype-json `matches[]` → [{id, severity, package, version}]."""
    out: list[dict] = []
    for m in raw.get("matches") or []:
        vuln = m.get("vulnerability") or {}
        art = m.get("artifact") or {}
        cid = vuln.get("id")
        if not cid:
            continue
        out.append(
            {
                "id": cid,
                "severity": _norm_sev(vuln.get("severity")),
                "package": art.get("name") or "",
                "version": art.get("version") or "",
            }
        )
    return out


# ── scanning ─────────────────────────────────────────────────────────────────
async def _driver_sbom(image_ref: str) -> dict:
    """Fetch the syft-json SBOM for an image from the infra-driver (which owns
    docker). Constructed per-call — these scans are fire-and-forget and rare."""
    from app.services.infra_driver_client import InfraDriverClient, WorkspaceContext

    client = InfraDriverClient()
    ctx = WorkspaceContext(
        workspace_name=os.environ.get("BITSWAN_WORKSPACE_NAME", ""),
        domain="",
        gitops_dir="",
        secrets_dir="",
    )
    return await client.image_sbom(ctx, image_ref)


async def scan_image(image_ref: str, image_id: str, *, force_cve: bool = False) -> None:
    """Ensure an SBOM (built once) and a CVE scan exist for an image. `image_ref`
    is what syft/grype scan (a tag or id resolvable via the docker daemon);
    `image_id` is the stable cache key. Safe to call on every deploy — the SBOM
    step is skipped when already cached. Never raises."""
    if not image_ref:
        return
    d = supply_chain_dir()
    os.makedirs(d, exist_ok=True)
    k = _key(image_id or image_ref)
    sbom_path, cve_path = _sbom_path(d, k), _cve_path(d, k)
    # Whether this call produced a terminal result (ok/unavailable) to announce.
    # An early "already scanned" return leaves it False — nothing new to notify.
    outcome: str | None = None
    try:
        if not os.path.exists(sbom_path):
            # syft must read the image from the docker daemon, which gitops no
            # longer has after the cut-over. Run it on the infra-driver (which
            # owns docker) and fetch back only the small SBOM — not the image.
            try:
                sbom = await _driver_sbom(image_ref)
            except Exception as e:  # noqa: BLE001 — record, never crash
                _write_unavailable(cve_path, f"sbom via driver failed: {e}")
                outcome = "unavailable"
                return
            if not sbom:
                _write_unavailable(cve_path, "driver returned an empty SBOM")
                outcome = "unavailable"
                return
            _atomic_write(sbom_path, json.dumps(sbom))

        cve_doc = _read_json(cve_path)
        if not force_cve and cve_doc and cve_doc.get("status") == "ok":
            return  # already have a CVE scan; daily job passes force_cve=True
        # A fresh gitops image has no vuln DB yet — make sure it's downloaded
        # once before the first scan, or grype finds nothing to match against.
        await ensure_vuln_db()
        rc, out, err = await _run(
            "grype", f"sbom:{sbom_path}", "-o", "json", env=_grype_env()
        )
        if rc != 0 or not out:
            _write_unavailable(
                cve_path, f"grype failed: {err.decode(errors='replace')}"
            )
            outcome = "unavailable"
            return
        matches = parse_grype(json.loads(out))
        _atomic_write(
            cve_path,
            json.dumps({"scanned_at": _now(), "status": "ok", "matches": matches}),
        )
        outcome = "ok"
    except Exception as e:  # never break a build/deploy on a scan failure
        _write_unavailable(cve_path, f"scan error: {e}")
        outcome = "unavailable"
    finally:
        if outcome is not None:
            await _broadcast_scanned(image_id or image_ref, outcome)


# Strong refs to fire-and-forget scan tasks so they aren't GC'd mid-run.
_bg_tasks: set = set()


def spawn_scan(image_ref: str, image_id: str, *, force_cve: bool = False) -> None:
    """Fire-and-forget background scan (called from the deploy path so it never
    blocks the deploy). No-op outside a running event loop."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    t = loop.create_task(scan_image(image_ref, image_id, force_cve=force_cve))
    _bg_tasks.add(t)
    t.add_done_callback(_bg_tasks.discard)


def _read_json(path: str) -> dict | None:
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def read_image_scan(image_id: str) -> dict:
    """Merge a cached SBOM + CVE scan for one image into
    {status, scanned_at, packages:[{name, version, type, cves:[{id, severity}]}]}.
    status: ok | pending (no SBOM yet) | unavailable (scan failed)."""
    d = supply_chain_dir()
    k = _key(image_id)
    sbom = _read_json(_sbom_path(d, k))
    if not sbom:
        return {"status": "pending", "packages": []}
    packages = parse_sbom(sbom)
    cve_doc = _read_json(_cve_path(d, k)) or {}
    status = cve_doc.get("status")
    if status == "unavailable":
        return {
            "status": "unavailable",
            "reason": cve_doc.get("reason"),
            "scanned_at": cve_doc.get("scanned_at"),
            "packages": [{**p, "cves": []} for p in packages],
        }
    by_pkg: dict[tuple, list] = {}
    for m in cve_doc.get("matches") or []:
        by_pkg.setdefault((m["package"], m["version"]), []).append(
            {"id": m["id"], "severity": m["severity"]}
        )
    out_packages = []
    for p in packages:
        seen: set = set()
        cves = []
        for c in by_pkg.get((p["name"], p["version"]), []):
            if c["id"] not in seen:
                seen.add(c["id"])
                cves.append(c)
        out_packages.append({**p, "cves": cves})
    return {
        "status": "ok" if cve_doc else "pending",
        "scanned_at": cve_doc.get("scanned_at"),
        "packages": out_packages,
    }
