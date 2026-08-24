"""Supply-chain scanning — syft SBOM + grype CVEs per image, cached on disk.

On first build of an image we run **syft** to produce an SBOM (the package list)
and **grype** to find CVEs against it; a daily job re-runs grype (new CVEs land
against unchanged images over time). An image's content is immutable, so results
are cached by the docker **image id** under a non-git cache dir:

  <bs_home>/supply-chain/<image_id>.sbom.json   syft SBOM (immutable; built once)
  <bs_home>/supply-chain/<image_id>.cve.json    grype matches + scanned_at (refreshed daily)

Everything degrades honestly: a missing binary / vuln-DB / unparseable output is
recorded as an "unavailable" marker rather than crashing a build or a request.
A failure marker also records WHICH of the four moving parts broke (`code`) and
the underlying error (`reason`), so the panel can name the state instead of
collapsing every failure into one sentence — and whether it is worth retrying,
so a host that failed once (e.g. before the daemon's first DB download landed)
heals by itself instead of serving a stale failure forever.
"""

import asyncio
import json
import logging
import os
from datetime import datetime, timedelta, timezone

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


# Which of the four moving parts broke. The panel renders a different, actionable
# state per code — a vuln DB the daemon hasn't downloaded yet is a completely
# different problem from a gitops image with no grype in it, and neither is
# "grype ran and exploded". Kept as plain strings so the marker files stay
# readable and old cached markers (no `code`) still parse.
FAIL_SBOM = "sbom-failed"  # syft, on the infra-driver, couldn't read the image
FAIL_DB_MISSING = "db-missing"  # the daemon-owned vulnerability DB isn't here yet
FAIL_DB_UNREADABLE = "db-unreadable"  # it IS here, but this process can't read it
FAIL_SCANNER_MISSING = "scanner-missing"  # no grype binary in this gitops image
FAIL_SCAN = "scan-failed"  # grype ran and failed / returned something unusable

# How long a recorded failure is believed before a panel view retries it.
# Practically every failure here is TRANSIENT — the daemon's first DB download is
# still in flight, the infra-driver is restarting, the host was briefly offline.
# Before this, a cached "unavailable" was treated as a final answer and the image
# was never rescanned, so a host that failed once stayed broken until the daily
# job ran (up to 24h) or somebody deleted the cache file by hand. That is the
# gap #323 left behind: it fixed the DB refresh, not the failures already cached.
FAILED_SCAN_RETRY_AFTER = timedelta(minutes=10)


def _write_failure(
    path: str, code: str, reason: str, *, retryable: bool = True
) -> None:
    """Record a terminal-for-now scan failure: WHAT broke (`code`), the
    underlying error (`reason`, surfaced verbatim in the UI) and whether a later
    view should try again."""
    _atomic_write(
        path,
        json.dumps(
            {
                "scanned_at": _now(),
                "status": "unavailable",
                "code": code,
                "reason": (reason or "").strip()[:600],
                "retryable": bool(retryable),
            }
        ),
    )


def _parse_ts(value: str | None) -> datetime | None:
    try:
        at = datetime.fromisoformat(value or "")
    except ValueError:
        return None
    return at if at.tzinfo else at.replace(tzinfo=timezone.utc)


def should_rescan(scan: dict) -> bool:
    """Whether a cached scan is worth (re)running. `ok` is final — image content
    is immutable, and the daily job refreshes CVEs. Anything else is retried:
    immediately when nothing has been scanned yet, and after
    FAILED_SCAN_RETRY_AFTER for a recorded failure, so a host whose DB/driver has
    since recovered heals on its own."""
    status = scan.get("status")
    if status == "ok":
        return False
    if status != "unavailable":
        return True  # pending — no result on record yet
    if not scan.get("retryable", True):
        return False
    at = _parse_ts(scan.get("scanned_at"))
    return at is None or datetime.now(timezone.utc) - at >= FAILED_SCAN_RETRY_AFTER


def clear_failure(image_id: str) -> bool:
    """Drop a recorded FAILURE for an image so the next read reports `pending`
    and a freshly-started scan is unmistakably in flight.

    This backs the panel's explicit Retry. The cooldown in should_rescan exists
    to stop *automatic* refetches hammering a broken host — but a human pressing
    Retry has almost always just fixed the thing that was broken, and serving
    them the identical cached error for up to FAILED_SCAN_RETRY_AFTER makes the
    button a lie. Never removes a successful scan: this only discards a result
    that is already an error."""
    path = _cve_path(supply_chain_dir(), _key(image_id))
    doc = _read_json(path)
    if not doc or doc.get("status") != "unavailable":
        return False
    try:
        os.remove(path)
    except OSError:
        return False
    return True


# `command not found`, the shell convention. A missing scanner binary is its own
# diagnosis ("this gitops image has no grype"), so it must not arrive as a
# generic exception indistinguishable from grype crashing.
RC_NOT_FOUND = 127


async def _run(
    *cmd: str, timeout: int = 600, env: dict | None = None
) -> tuple[int, bytes, bytes]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
    except (FileNotFoundError, NotADirectoryError):
        return RC_NOT_FOUND, b"", f"{cmd[0]}: not found".encode()
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


async def ensure_vuln_db() -> tuple[bool, str]:
    """Report whether grype's (daemon-owned, read-only) vulnerability DB is ready
    to scan against, plus what `grype db status` actually said. Never downloads or
    updates it — the automation-server daemon is the sole writer. Best-effort:
    True once the DB is present, False while the daemon's first refresh is still
    in flight. Never raises.

    The detail string is not decoration: when the DB is the problem it is the one
    piece of evidence an operator needs (missing vs. wrong schema vs. how stale),
    and it rides all the way into the panel as the failure reason."""
    global _db_ready, _db_lock
    if _db_ready:
        return True, ""
    if _db_lock is None:
        _db_lock = asyncio.Lock()
    async with _db_lock:
        if _db_ready:
            return True, ""
        # `grype db status` exits non-zero when the DB is missing. With age
        # validation off it accepts a present-but-slightly-stale daemon DB.
        rc, out, err = await _run("grype", "db", "status", timeout=60, env=_grype_env())
        if rc == 0:
            _db_ready = True
        detail = (err or out or b"").decode(errors="replace").strip()
        if rc == RC_NOT_FOUND:
            detail = "grype is not installed in this gitops image"
        # If not ready, the daemon's refresh is still in flight — don't cache the
        # negative, so a later scan rechecks once the daemon has populated it.
        return _db_ready, detail


def _classify_db_failure(detail: str) -> tuple[str, str]:
    """Turn `grype db status`'s complaint into a code + a plain-language cause.

    "Present but unreadable" is a genuinely different problem from "not
    downloaded yet" and needs a different fix, so it must not be reported as the
    latter: the daemon writes the shared DB as root and workspaces scan as
    user1000, so a permissions slip on the shared volume looks exactly like a DB
    that never arrived while actually never resolving on its own."""
    low = (detail or "").lower()
    if "not installed" in low:
        return FAIL_SCANNER_MISSING, "grype is not installed in this gitops image."
    if "permission denied" in low or "operation not permitted" in low:
        return (
            FAIL_DB_UNREADABLE,
            "the shared vulnerability database is on this host but this workspace "
            "is not allowed to read it — the automation-server daemon owns that "
            "volume and must leave it readable.",
        )
    return (
        FAIL_DB_MISSING,
        "the shared grype vulnerability database is not available on this host "
        "yet — the automation-server daemon downloads and refreshes it.",
    )


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
    step is skipped when already cached. Never raises.

    Every failure exit records a `code` naming the broken stage, so the four ways
    this can go wrong stay distinguishable all the way to the panel."""
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
                _write_failure(
                    cve_path,
                    FAIL_SBOM,
                    f"syft (on the infra-driver) could not read {image_ref}: {e}",
                )
                outcome = "unavailable"
                return
            if not sbom:
                _write_failure(
                    cve_path,
                    FAIL_SBOM,
                    f"the infra-driver returned an empty SBOM for {image_ref}",
                )
                outcome = "unavailable"
                return
            _atomic_write(sbom_path, json.dumps(sbom))

        cve_doc = _read_json(cve_path)
        if not force_cve and cve_doc and cve_doc.get("status") == "ok":
            return  # already have a CVE scan; daily job passes force_cve=True
        # The vuln DB belongs to the automation-server daemon; a fresh or briefly
        # offline host may not have it yet. Running grype anyway (auto-update is
        # off, by design) just fails — and used to cache that as the image's
        # permanent answer. Record the real state instead and let it be retried.
        ready, db_detail = await ensure_vuln_db()
        if not ready:
            code, why = _classify_db_failure(db_detail)
            _write_failure(
                cve_path,
                code,
                f"{why} `grype db status`: {db_detail or 'no output'}",
            )
            outcome = "unavailable"
            return
        rc, out, err = await _run(
            "grype", f"sbom:{sbom_path}", "-o", "json", env=_grype_env()
        )
        if rc != 0 or not out:
            _write_failure(
                cve_path,
                FAIL_SCANNER_MISSING if rc == RC_NOT_FOUND else FAIL_SCAN,
                f"grype exited {rc}: "
                f"{err.decode(errors='replace').strip() or 'no error output'}",
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
        _write_failure(cve_path, FAIL_SCAN, f"scan error: {e}")
        outcome = "unavailable"
    finally:
        _inflight.discard(k)
        if outcome is not None:
            await _broadcast_scanned(image_id or image_ref, outcome)


# Strong refs to fire-and-forget scan tasks so they aren't GC'd mid-run.
_bg_tasks: set = set()
# Cache keys with a scan currently running. Now that a recorded failure is
# retried (see should_rescan), repeated panel views of a broken image would
# otherwise pile up concurrent syft/grype runs for the same image.
_inflight: set[str] = set()


def spawn_scan(image_ref: str, image_id: str, *, force_cve: bool = False) -> None:
    """Fire-and-forget background scan (called from the deploy path so it never
    blocks the deploy). No-op outside a running event loop, or while a scan of
    the same image is already running."""
    if not image_ref:
        return  # scan_image no-ops on this; don't leave a key stuck in _inflight
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    k = _key(image_id or image_ref)
    if k in _inflight:
        return
    _inflight.add(k)
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
    {status, code, reason, scanned_at, packages:[{name, version, type, cves:[…]}]}.
    status: ok | pending (no scan on record yet) | unavailable (scan failed)."""
    d = supply_chain_dir()
    k = _key(image_id)
    sbom = _read_json(_sbom_path(d, k))
    cve_doc = _read_json(_cve_path(d, k)) or {}
    status = cve_doc.get("status")
    # Check the failure marker BEFORE the SBOM. A failure in the syft/driver step
    # leaves no SBOM at all, and returning "pending" for it hid a real, recorded
    # error behind a spinner that never resolved.
    if status == "unavailable":
        return {
            "status": "unavailable",
            "code": cve_doc.get("code") or FAIL_SCAN,
            "reason": cve_doc.get("reason"),
            "retryable": bool(cve_doc.get("retryable", True)),
            "scanned_at": cve_doc.get("scanned_at"),
            "packages": [{**p, "cves": []} for p in parse_sbom(sbom or {})],
        }
    if not sbom:
        return {"status": "pending", "packages": []}
    packages = parse_sbom(sbom)
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
