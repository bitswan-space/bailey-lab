"""Supply-chain: syft/grype JSON parsing, the SBOM+CVE merge, and the
source-tree out-of-scope markings (cve-waivers.yaml, committed in the copy).
Real binaries are not invoked — parsing is exercised against fixture JSON.
"""

import asyncio
import json
import os
import subprocess
from datetime import datetime, timedelta, timezone

from app.utils import dump_bitswan_yaml
from app.services import automation_service as asvc
from app.services import supply_chain_service as scs
from app.services.automation_service import AutomationService


# ── parsing ──────────────────────────────────────────────────────────────────
def test_parse_sbom_keeps_named_packages():
    raw = {
        "artifacts": [
            {"name": "openssl", "version": "3.0.11", "type": "deb"},
            {"name": "express", "version": "4.18.2", "type": "npm"},
            {"version": "x"},  # no name → dropped
        ]
    }
    pkgs = scs.parse_sbom(raw)
    assert pkgs == [
        {"name": "openssl", "version": "3.0.11", "type": "deb"},
        {"name": "express", "version": "4.18.2", "type": "npm"},
    ]


def test_parse_grype_normalises_severity():
    raw = {
        "matches": [
            {
                "vulnerability": {"id": "CVE-1", "severity": "Critical"},
                "artifact": {"name": "libxml2", "version": "2.9.14"},
            },
            {
                "vulnerability": {"id": "CVE-2", "severity": "Negligible"},  # → low
                "artifact": {"name": "openssl", "version": "3.0.11"},
            },
            {
                "vulnerability": {"severity": "High"},
                "artifact": {"name": "x"},
            },  # no id → dropped
        ]
    }
    out = scs.parse_grype(raw)
    assert out == [
        {
            "id": "CVE-1",
            "severity": "critical",
            "package": "libxml2",
            "version": "2.9.14",
        },
        {"id": "CVE-2", "severity": "low", "package": "openssl", "version": "3.0.11"},
    ]


def _write_scan(d, image_id, artifacts, matches):
    """Write cache files in the SAME shape scan_image produces: a syft SBOM and a
    cve.json whose `matches` are already parse_grype'd ({id,severity,package,version})."""
    os.makedirs(d, exist_ok=True)
    k = scs._key(image_id)
    with open(scs._sbom_path(d, k), "w") as f:
        json.dump({"artifacts": artifacts}, f)
    with open(scs._cve_path(d, k), "w") as f:
        json.dump(
            {
                "scanned_at": "2026-06-18T00:00:00+00:00",
                "status": "ok",
                "matches": [
                    {
                        "id": m[0],
                        "severity": scs._norm_sev(m[1]),
                        "package": m[2],
                        "version": m[3],
                    }
                    for m in matches
                ],
            },
            f,
        )


def test_read_image_scan_joins_cves_and_marks_clean(tmp_path, monkeypatch):
    d = str(tmp_path / "sc")
    monkeypatch.setattr(scs, "supply_chain_dir", lambda: d)
    _write_scan(
        d,
        "sha256:abc",
        artifacts=[
            {"name": "openssl", "version": "3.0.11", "type": "deb"},
            {"name": "lodash", "version": "4.17.21", "type": "npm"},
        ],
        matches=[("CVE-2023-5678", "High", "openssl", "3.0.11")],
    )
    scan = scs.read_image_scan("sha256:abc")
    assert scan["status"] == "ok"
    pkgs = {p["name"]: p for p in scan["packages"]}
    assert pkgs["openssl"]["cves"] == [{"id": "CVE-2023-5678", "severity": "high"}]
    assert pkgs["lodash"]["cves"] == []  # clean


def test_read_image_scan_pending_when_no_sbom(tmp_path, monkeypatch):
    monkeypatch.setattr(scs, "supply_chain_dir", lambda: str(tmp_path / "sc"))
    assert scs.read_image_scan("sha256:missing")["status"] == "pending"


# ── service: merge across member images + waivers ───────────────────────────
def _svc(tmp_path, monkeypatch):
    async def _noop_update_git(*a, **k):
        return None

    monkeypatch.setattr(asvc, "update_bp_git", _noop_update_git)
    d = str(tmp_path / "sc")
    monkeypatch.setattr(scs, "supply_chain_dir", lambda: d)
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    # dump_bitswan_yaml rebuilds the business_processes tree from the FLAT
    # `deployments` map, so seed that (context=bp, stage) — _bp_stage_node reads
    # it back as the stage's deployments (with image_id).
    bs = {
        "deployments": {
            "backend-shop-dev": {
                "context": "shop",
                "stage": "dev",
                "image": "internal/be:shaX",
                "image_id": "sha256:be",
            },
            "frontend-shop-dev": {
                "context": "shop",
                "stage": "dev",
                "image": "internal/fe:shaY",
                "image_id": "sha256:fe",
            },
        },
        "secrets": {"keep": "me"},
    }
    with open(tmp_path / "bitswan.yaml", "w") as f:
        dump_bitswan_yaml(bs, f)
    # backend has a CVE, frontend is clean; they share 'openssl'
    _write_scan(
        d,
        "sha256:be",
        artifacts=[{"name": "openssl", "version": "3.0.11", "type": "deb"}],
        matches=[("CVE-2023-5678", "High", "openssl", "3.0.11")],
    )
    _write_scan(
        d,
        "sha256:fe",
        artifacts=[{"name": "react", "version": "18.2.0", "type": "npm"}],
        matches=[],
    )
    return svc, d


def test_read_supply_chain_merges_member_images(tmp_path, monkeypatch):
    svc, _ = _svc(tmp_path, monkeypatch)
    sc = svc.read_supply_chain("shop", "dev")
    assert sc["status"] == "ok"
    assert sc["image_count"] == 2
    names = {p["name"]: p for p in sc["packages"]}
    assert set(names) == {"openssl", "react"}
    assert names["openssl"]["cves"] == [{"id": "CVE-2023-5678", "severity": "high"}]
    assert sc["waivers"] == []


def test_supply_chain_not_deployed_when_no_images(tmp_path, monkeypatch):
    svc, _ = _svc(tmp_path, monkeypatch)
    assert svc.read_supply_chain("shop", "production")["status"] == "not-deployed"


def test_waivers_live_in_the_source_tree_and_commit(tmp_path, monkeypatch):
    """Out-of-scope markings are stored in the BP's source tree
    (`<copy>/<bp>/cve-waivers.yaml`), committed in the BP's own clone (and,
    for the main scope, published to its repo's main) — not in bitswan.yaml."""
    from app.services import bp_git, cve_waivers, git_server

    monkeypatch.setattr(git_server, "GIT_REPOS_DIR", str(tmp_path / "git"))
    monkeypatch.setattr(
        git_server, "HOOKS_SRC_DIR", str(tmp_path / "nonexistent-hooks")
    )
    copies = tmp_path / "copies"
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(copies))
    monkeypatch.delenv("BITSWAN_GIT_REMOTE", raising=False)
    monkeypatch.setenv("GIT_COMMITTER_NAME", "ci")
    monkeypatch.setenv("GIT_COMMITTER_EMAIL", "ci@x")
    (copies / "main").mkdir(parents=True)
    asyncio.run(git_server.ensure_bp_bare_repo("shop"))
    asyncio.run(
        bp_git.clone_bp_into_copy(
            str(copies / "main"), "main", "shop", allow_empty=True
        )
    )
    main = copies / "main"

    out = asyncio.run(
        cve_waivers.set_waiver(
            "shop",
            None,
            "openssl",
            "CVE-2023-5678",
            "not reachable",
            "tim@x",
            "Jun 1, 2026",
        )
    )
    assert len(out) == 1
    w = out[0]
    assert w["package"] == "openssl" and w["cve"] == "CVE-2023-5678"
    assert w["by"] == "tim@x" and w["comment"] == "not reachable"

    # Stored in the source tree, committed in the copy — not in bitswan.yaml.
    waiver_file = main / "shop" / "cve-waivers.yaml"
    assert waiver_file.is_file()
    log = subprocess.run(
        ["git", "log", "--oneline"],
        cwd=main / "shop",
        capture_output=True,
        text=True,
    ).stdout
    assert "CVE-2023-5678" in log
    # Main-scope marking also reached the BP repo's deploy-only main.
    bare_names = subprocess.run(
        [
            "git",
            "-C",
            str(tmp_path / "git" / "shop.git"),
            "ls-tree",
            "--name-only",
            "main",
        ],
        capture_output=True,
        text=True,
    ).stdout
    assert "cve-waivers.yaml" in bare_names
    assert cve_waivers.read_waivers("shop", None) == {
        "openssl|CVE-2023-5678": {
            "package": "openssl",
            "cve": "CVE-2023-5678",
            "comment": "not reachable",
            "by": "tim@x",
            "at": "Jun 1, 2026",
        }
    }

    assert (
        asyncio.run(cve_waivers.unset_waiver("shop", None, "openssl", "CVE-2023-5678"))
        == []
    )
    assert cve_waivers.read_waivers("shop", None) == {}


# ── the daemon is the sole DB owner ──────────────────────────────────────────
def test_grype_env_forbids_workspace_db_writes():
    """Every grype call from a workspace runs with auto-update and age-validation
    OFF, so grype never tries to write the read-only, daemon-owned DB mount."""
    env = scs._grype_env()
    assert env["GRYPE_DB_AUTO_UPDATE"] == "false"
    assert env["GRYPE_DB_VALIDATE_AGE"] == "false"
    # It still inherits the process env (GRYPE_DB_CACHE_DIR, PATH, …).
    assert env.get("PATH") == os.environ.get("PATH")


def test_workspace_has_no_db_updater():
    """The workspace-side `grype db update` is gone — the automation-server
    daemon is the single writer of the shared DB."""
    assert not hasattr(scs, "update_vuln_db")


async def test_ensure_vuln_db_reads_only_never_updates(monkeypatch):
    """ensure_vuln_db only checks `grype db status` (with the no-write env); it
    never runs `grype db update`."""
    calls = []

    async def fake_run(*cmd, timeout=600, env=None):
        calls.append((cmd, env))
        return (0, b"", b"")  # db status → present

    monkeypatch.setattr(scs, "_run", fake_run)
    monkeypatch.setattr(scs, "_db_ready", False)
    monkeypatch.setattr(scs, "_db_lock", None)

    ready, detail = await scs.ensure_vuln_db()
    assert ready is True and detail == ""
    assert calls, "grype db status was not invoked"
    cmd, env = calls[0]
    assert cmd == ("grype", "db", "status")
    assert env["GRYPE_DB_AUTO_UPDATE"] == "false"
    assert not any("update" in part for (c, _e) in calls for part in c)
    monkeypatch.setattr(scs, "_db_ready", False)  # don't leak readiness to other tests


# ── failures are named, retried, and never mistaken for a clean image ────────
def test_grype_db_missing_is_its_own_diagnosis(tmp_path, monkeypatch):
    """When the daemon's DB isn't on the host yet we must NOT run grype (it is
    configured never to fetch a DB itself); we record `db-missing` with what
    `grype db status` said, so the panel can name the state instead of showing
    one catch-all sentence."""
    d = str(tmp_path / "sc")
    monkeypatch.setattr(scs, "supply_chain_dir", lambda: d)
    os.makedirs(d)
    k = scs._key("sha256:abc")
    with open(scs._sbom_path(d, k), "w") as f:
        json.dump({"artifacts": [{"name": "openssl", "version": "3.0.11"}]}, f)

    ran = []

    async def fake_ensure():
        return False, "no database found in /grype-db"

    async def fake_run(*cmd, timeout=600, env=None):
        ran.append(cmd)
        return (0, b"{}", b"")

    monkeypatch.setattr(scs, "ensure_vuln_db", fake_ensure)
    monkeypatch.setattr(scs, "_run", fake_run)
    asyncio.run(scs.scan_image("internal/ws-x:sha1", "sha256:abc"))

    assert ran == [], "grype was run against a database that isn't there"
    scan = scs.read_image_scan("sha256:abc")
    assert scan["status"] == "unavailable"
    assert scan["code"] == scs.FAIL_DB_MISSING
    assert "no database found in /grype-db" in scan["reason"]
    # The SBOM survives the failure, so the panel can still show the packages.
    assert [p["name"] for p in scan["packages"]] == ["openssl"]


def test_unreadable_db_is_not_reported_as_a_missing_one(tmp_path, monkeypatch):
    """The real #370/#271 failure: the daemon downloads the shared DB as root and
    grype makes its schema dir 0700, but gitops scans as user1000 — so the DB is
    present and unreadable. Reporting that as "not downloaded yet" points the
    operator at a download that already succeeded and never resolves."""
    d = str(tmp_path / "sc")
    monkeypatch.setattr(scs, "supply_chain_dir", lambda: d)
    os.makedirs(d)
    k = scs._key("sha256:abc")
    with open(scs._sbom_path(d, k), "w") as f:
        json.dump({"artifacts": [{"name": "openssl", "version": "3.0.11"}]}, f)

    denied = (
        "[0000] ERROR failed to access database file: "
        "stat /grype-db/6/vulnerability.db: permission denied"
    )

    async def fake_ensure():
        return False, denied

    monkeypatch.setattr(scs, "ensure_vuln_db", fake_ensure)
    asyncio.run(scs.scan_image("internal/ws-x:sha1", "sha256:abc"))

    scan = scs.read_image_scan("sha256:abc")
    assert scan["code"] == scs.FAIL_DB_UNREADABLE
    assert scan["code"] != scs.FAIL_DB_MISSING
    assert "not allowed to read it" in scan["reason"]
    assert denied in scan["reason"]  # the operator gets grype's own words


def test_missing_grype_binary_reports_scanner_missing(tmp_path, monkeypatch):
    """A gitops image without grype is a different problem from a missing DB —
    `_run` turns the spawn failure into rc 127 and the code says so."""
    d = str(tmp_path / "sc")
    monkeypatch.setattr(scs, "supply_chain_dir", lambda: d)
    os.makedirs(d)
    k = scs._key("sha256:abc")
    with open(scs._sbom_path(d, k), "w") as f:
        json.dump({"artifacts": []}, f)

    async def fake_ensure():
        return True, ""

    async def fake_run(*cmd, timeout=600, env=None):
        return (scs.RC_NOT_FOUND, b"", b"grype: not found")

    monkeypatch.setattr(scs, "ensure_vuln_db", fake_ensure)
    monkeypatch.setattr(scs, "_run", fake_run)
    asyncio.run(scs.scan_image("internal/ws-x:sha1", "sha256:abc"))

    assert scs.read_image_scan("sha256:abc")["code"] == scs.FAIL_SCANNER_MISSING


def test_sbom_failure_is_surfaced_not_left_pending(tmp_path, monkeypatch):
    """A syft/driver failure leaves no SBOM at all. It used to read back as
    `pending`, so the recorded reason sat behind a spinner that never resolved."""
    d = str(tmp_path / "sc")
    monkeypatch.setattr(scs, "supply_chain_dir", lambda: d)

    async def boom(image_ref):
        raise RuntimeError("HTTP 500: docker: no such image")

    monkeypatch.setattr(scs, "_driver_sbom", boom)
    asyncio.run(scs.scan_image("internal/ws-x:sha1", "sha256:abc"))

    scan = scs.read_image_scan("sha256:abc")
    assert scan["status"] == "unavailable"
    assert scan["code"] == scs.FAIL_SBOM
    assert "no such image" in scan["reason"]


def test_recorded_failures_are_retried_after_the_cooldown():
    """A cached failure is not a final answer. Before this, one bad scan (e.g.
    during the daemon's first DB download) pinned an image to 'unavailable' until
    the daily job ran or somebody deleted the cache file."""
    assert scs.should_rescan({"status": "pending"}) is True
    assert scs.should_rescan({"status": "ok"}) is False

    fresh = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    stale = (
        datetime.now(timezone.utc) - scs.FAILED_SCAN_RETRY_AFTER - timedelta(minutes=1)
    ).isoformat()
    assert scs.should_rescan({"status": "unavailable", "scanned_at": fresh}) is False
    assert scs.should_rescan({"status": "unavailable", "scanned_at": stale}) is True
    # Unparseable/absent timestamps retry rather than pinning the image forever.
    assert scs.should_rescan({"status": "unavailable"}) is True


def test_retry_forces_a_rescan_through_the_cooldown(tmp_path, monkeypatch):
    """The panel's Retry must actually rescan. The cooldown paces AUTOMATIC
    refetches, but an operator pressing Retry has usually just fixed the host —
    serving them the identical cached error for 10 minutes makes the button a
    lie (PR #377 review)."""
    svc, d = _svc(tmp_path, monkeypatch)
    cve_path = scs._cve_path(d, scs._key("sha256:fe"))
    scs._write_failure(cve_path, scs.FAIL_DB_UNREADABLE, "permission denied")

    # Freshly recorded, so the automatic path deliberately declines to rescan.
    assert scs.should_rescan(scs.read_image_scan("sha256:fe")) is False

    spawned = []
    monkeypatch.setattr(
        scs, "spawn_scan", lambda ref, iid, **kw: spawned.append((iid, kw))
    )

    # A normal view leaves the cached failure alone...
    svc.read_supply_chain("shop", "dev")
    assert spawned == []
    assert os.path.exists(cve_path)

    # ...but Retry discards it and rescans now.
    out = svc.read_supply_chain("shop", "dev", force=True)
    assert ("sha256:fe", {"force_cve": True}) in spawned
    assert not os.path.exists(cve_path), "the stale failure survived a forced retry"
    # With the failure gone and a scan in flight, the panel shows the honest
    # "scanning" state rather than repeating the error it was just asked to clear.
    assert out["status"] == "pending"


def test_clear_failure_never_discards_a_good_scan(tmp_path, monkeypatch):
    """Retry may throw away an error; it must never throw away real results."""
    d = str(tmp_path / "sc")
    monkeypatch.setattr(scs, "supply_chain_dir", lambda: d)
    _write_scan(
        d,
        "sha256:ok",
        artifacts=[{"name": "openssl", "version": "3.0.11", "type": "deb"}],
        matches=[("CVE-2023-5678", "High", "openssl", "3.0.11")],
    )
    assert scs.clear_failure("sha256:ok") is False
    assert scs.read_image_scan("sha256:ok")["status"] == "ok"
    # Nothing cached at all is not a failure to clear either.
    assert scs.clear_failure("sha256:nothing-here") is False


def test_partial_scan_failure_never_reads_as_a_clean_image(tmp_path, monkeypatch):
    """One member image scanning fine while another fails used to report `ok` —
    a partial scan rendered as a complete, clean bill of health."""
    svc, d = _svc(tmp_path, monkeypatch)
    scs._write_failure(
        scs._cve_path(d, scs._key("sha256:fe")),
        scs.FAIL_DB_MISSING,
        "the shared grype vulnerability database is not available",
    )
    sc = svc.read_supply_chain("shop", "dev")
    assert sc["status"] == "unavailable"
    assert sc["code"] == scs.FAIL_DB_MISSING
    assert "vulnerability database" in sc["reason"]
    # The packages we DID resolve still ride along for the panel to show.
    assert {p["name"] for p in sc["packages"]} == {"openssl", "react"}
