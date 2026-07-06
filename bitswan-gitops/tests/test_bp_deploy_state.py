"""Per-BP deploy-state facade: one bitswan.yaml per BP, aggregated back into the
single whole-workspace dict shape every reader expects.

Guards the split's core invariant: writing each BP's slice to its own file and
aggregating them round-trips to the same dict a single whole-workspace file
would have produced.
"""

import os

import yaml

from app.utils import (
    bp_slice,
    read_bitswan_yaml,
    read_workspace_bitswan,
    write_bp_bitswan,
)


def _whole_ws() -> dict:
    """A whole-workspace dict spanning two BPs (flat deployments + per-BP
    firewall/backups), as the in-memory writers build it."""
    return {
        "deployments": {
            "backend-issues-live-dev": {
                "context": "issues",
                "stage": "live-dev",
                "image": "internal/issues-backend:sha1",
                "source_commit": "aaaa",
            },
            "frontend-invoices-live-dev": {
                "context": "invoices",
                "stage": "live-dev",
                "image": "internal/invoices-frontend:sha2",
                "source_commit": "bbbb",
            },
        },
        "firewall": {
            "issues": {"dev": {"posture": "deny", "rules": {}}},
        },
        "backups": {
            "invoices": {"live_slot": "blue", "slots": {}},
        },
    }


def test_bp_slice_extracts_one_bp():
    ws = _whole_ws()
    s = bp_slice(ws, "issues")
    assert set(s["business_processes"].keys()) == {"issues"}
    assert "issues" in s["firewall"]
    # invoices' data must NOT leak into issues' slice
    assert "backups" not in s  # issues has no backups entry
    assert "invoices" not in s["business_processes"]


def test_bp_slice_groups_copies_under_raw_bp():
    """A copy deployment (context copy-<copy>-<bp>, relative_path
    copies/<copy>/<bp>/...) belongs to the RAW bp — its context lands in that
    bp's slice, so one deploy repo per bp holds main + all copies."""
    ws = {
        "deployments": {
            # main issues
            "backend-issues-live-dev": {
                "context": "issues",
                "stage": "live-dev",
                "relative_path": "copies/main/issues/backend",
            },
            # a copy of issues — different context, same raw bp
            "backend-copy-alice-issues-live-dev": {
                "context": "copy-alice-issues",
                "stage": "live-dev",
                "relative_path": "copies/alice/issues/backend",
            },
            # an unrelated bp
            "backend-invoices-live-dev": {
                "context": "invoices",
                "stage": "live-dev",
                "relative_path": "copies/main/invoices/backend",
            },
        },
        "firewall": {"issues": {"dev": {"posture": "deny", "rules": {}}}},
    }
    s = bp_slice(ws, "issues")
    # Both the main and the copy context are in issues' slice; invoices is not.
    assert set(s["business_processes"].keys()) == {"issues", "copy-alice-issues"}
    assert "issues" in s["firewall"]

    inv = bp_slice(ws, "invoices")
    assert set(inv["business_processes"].keys()) == {"invoices"}


def test_write_then_aggregate_roundtrips(tmp_path):
    gitops = str(tmp_path)
    ws = _whole_ws()
    for bp in ("issues", "invoices"):
        write_bp_bitswan(gitops, bp, ws)

    # Each BP got its own file holding only its slice.
    assert os.path.isfile(tmp_path / "bp" / "issues" / "bitswan.yaml")
    with open(tmp_path / "bp" / "issues" / "bitswan.yaml") as f:
        issues_file = yaml.safe_load(f)
    assert set(issues_file["business_processes"].keys()) == {"issues"}

    # Aggregate reconstructs the whole-workspace flat deployments map.
    agg = read_workspace_bitswan(gitops)
    assert set(agg["deployments"].keys()) == set(ws["deployments"].keys())
    assert agg["deployments"]["backend-issues-live-dev"]["image"] == (
        "internal/issues-backend:sha1"
    )
    assert "issues" in agg["firewall"]
    assert "invoices" in agg["backups"]


def test_read_bitswan_yaml_auto_aggregates(tmp_path):
    """read_bitswan_yaml on the gitops root picks the per-BP layout when bp/
    exists (all ~51 whole-workspace readers stay unchanged); reading one BP dir
    returns just that BP."""
    gitops = str(tmp_path)
    ws = _whole_ws()
    write_bp_bitswan(gitops, "issues", ws)
    write_bp_bitswan(gitops, "invoices", ws)

    whole = read_bitswan_yaml(gitops)
    assert set(whole["deployments"].keys()) == set(ws["deployments"].keys())

    one = read_bitswan_yaml(str(tmp_path / "bp" / "issues"))
    assert set(one["deployments"].keys()) == {"backend-issues-live-dev"}


def test_legacy_single_file_still_read(tmp_path):
    """A pre-split workspace (single top-level bitswan.yaml, no bp/) reads as
    before."""
    gitops = str(tmp_path)
    with open(tmp_path / "bitswan.yaml", "w") as f:
        yaml.dump(
            {
                "business_processes": {
                    "issues": {
                        "live-dev": {
                            "deployments": {
                                "backend-issues-live-dev": {
                                    "context": "issues",
                                    "stage": "live-dev",
                                }
                            }
                        }
                    }
                }
            },
            f,
        )
    got = read_bitswan_yaml(gitops)
    assert "backend-issues-live-dev" in got["deployments"]
