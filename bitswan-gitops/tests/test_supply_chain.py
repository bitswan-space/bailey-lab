"""Supply-chain: syft/grype JSON parsing, the SBOM+CVE merge, and the
bitswan.yaml-versioned out-of-scope waiver log. Real binaries are not invoked —
parsing is exercised against fixture JSON and git writes are stubbed.
"""

import asyncio
import json
import os

from app.utils import read_bitswan_yaml, dump_bitswan_yaml
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

    monkeypatch.setattr(asvc, "update_git", _noop_update_git)
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


def test_waiver_add_remove_roundtrip_versioned(tmp_path, monkeypatch):
    svc, _ = _svc(tmp_path, monkeypatch)
    sc = asyncio.run(
        svc.add_supply_chain_waiver(
            "shop", "dev", "openssl", "CVE-2023-5678", "not reachable", by="tim@x"
        )
    )
    assert len(sc["waivers"]) == 1
    w = sc["waivers"][0]
    assert w["package"] == "openssl" and w["cve"] == "CVE-2023-5678"
    assert w["by"] == "tim@x" and w["comment"] == "not reachable"

    # Persisted in bitswan.yaml (audit log), coexisting with other keys.
    raw = read_bitswan_yaml(str(tmp_path))
    assert (
        raw["supply_chain"]["shop"]["dev"]["waivers"]["openssl|CVE-2023-5678"]["by"]
        == "tim@x"
    )
    assert raw["secrets"] == {"keep": "me"}

    sc2 = asyncio.run(
        svc.remove_supply_chain_waiver(
            "shop", "dev", "openssl", "CVE-2023-5678", by="tim@x"
        )
    )
    assert sc2["waivers"] == []
