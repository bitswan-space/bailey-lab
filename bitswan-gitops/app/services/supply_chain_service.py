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
import os
from datetime import datetime, timezone

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


async def _run(*cmd: str, timeout: int = 600) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return 124, b"", b"timed out"
    return proc.returncode or 0, out, err


async def update_vuln_db() -> bool:
    """Refresh grype's vulnerability DB (best-effort; needs outbound internet).
    Returns False if it couldn't update — scans then use the last cached DB."""
    rc, _, _ = await _run("grype", "db", "update", timeout=300)
    return rc == 0


# Ensure the grype vulnerability DB exists at least once before the first scan.
# A freshly-built gitops image ships WITHOUT the DB (it's downloaded at runtime),
# so the very first scan would otherwise find a missing DB and produce no CVE
# matches (the panel sits in "Scan pending"/empty). We download it once, lazily,
# guarded by a lock so concurrent scans don't race multiple downloads. Cached for
# the process lifetime; the daily refresh job keeps it current after that.
_db_ready = False
_db_lock: asyncio.Lock | None = None


async def ensure_vuln_db() -> bool:
    """Make sure grype has a usable vulnerability DB; download it once if not.
    Best-effort: returns True if the DB is (now) present, False otherwise. Never
    raises — a scan with no DB simply yields no matches rather than crashing."""
    global _db_ready, _db_lock
    if _db_ready:
        return True
    if _db_lock is None:
        _db_lock = asyncio.Lock()
    async with _db_lock:
        if _db_ready:
            return True
        # `grype db status` exits non-zero when the DB is missing/invalid.
        rc, _, _ = await _run("grype", "db", "status", timeout=60)
        if rc == 0:
            _db_ready = True
            return True
        # Missing/invalid — download it (needs outbound internet).
        ok = await update_vuln_db()
        if ok:
            _db_ready = True
        return ok


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
    try:
        if not os.path.exists(sbom_path):
            # syft must read the image from the docker daemon, which gitops no
            # longer has after the cut-over. Run it on the infra-driver (which
            # owns docker) and fetch back only the small SBOM — not the image.
            try:
                sbom = await _driver_sbom(image_ref)
            except Exception as e:  # noqa: BLE001 — record, never crash
                _write_unavailable(cve_path, f"sbom via driver failed: {e}")
                return
            if not sbom:
                _write_unavailable(cve_path, "driver returned an empty SBOM")
                return
            _atomic_write(sbom_path, json.dumps(sbom))

        cve_doc = _read_json(cve_path)
        if not force_cve and cve_doc and cve_doc.get("status") == "ok":
            return  # already have a CVE scan; daily job passes force_cve=True
        # A fresh gitops image has no vuln DB yet — make sure it's downloaded
        # once before the first scan, or grype finds nothing to match against.
        await ensure_vuln_db()
        rc, out, err = await _run("grype", f"sbom:{sbom_path}", "-o", "json")
        if rc != 0 or not out:
            _write_unavailable(
                cve_path, f"grype failed: {err.decode(errors='replace')}"
            )
            return
        matches = parse_grype(json.loads(out))
        _atomic_write(
            cve_path,
            json.dumps({"scanned_at": _now(), "status": "ok", "matches": matches}),
        )
    except Exception as e:  # never break a build/deploy on a scan failure
        _write_unavailable(cve_path, f"scan error: {e}")


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
