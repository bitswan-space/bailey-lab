"""A promoted deployment must resolve its automation.toml from the COMMIT it
was built from — not the current workspace HEAD.

A promote re-deploys a baked image built at a specific commit. Its config
(expose / port / services / memory_reservation_policy) is whatever automation.toml
said AT THAT COMMIT, and that is immutable: editing automation.toml afterwards
must never silently reinterpret an already-deployed (and, for an audit-gated
promote, already-audited) image. This is also why an always-on worker used to
turn on-demand in production — resolve_automation_config fell through to the
workspace HEAD (or the on-demand default) once the image-baked checksum blob
tree was gone. These guard the commit-pinned resolution.
"""

import asyncio
import os
import subprocess

from app.services.automation_service import AutomationService
from app.utils import AutomationConfig


def _git(cwd, *args):
    subprocess.run(
        ["git", "-c", "user.email=t@e.co", "-c", "user.name=t", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
    )


def _toml(policy: str, reservation: int = 128) -> str:
    return (
        "[deployment]\n"
        f"memory-reservation = {reservation}\n"
        f'memory_reservation_policy = "{policy}"\n'
    )


def _bp_repo(tmp_path, bp: str, automation: str):
    """A per-BP repo clone at <copies>/main/<bp> with <automation>/automation.toml
    committed twice: always-on at HEAD~1, then on-demand at HEAD. Returns the repo
    dir + the always-on commit sha (the 'what shipped' revision)."""
    copies = tmp_path / "copies"
    repo = copies / "main" / bp
    auto_dir = repo / automation
    auto_dir.mkdir(parents=True)
    _git(tmp_path, "init", "-q", str(repo))
    # C1 — always-on (this is the version the promoted image was built from).
    (auto_dir / "automation.toml").write_text(_toml("always-on", 256))
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "always-on")
    sha = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    # C2 — someone later edits the worker back to on-demand (drifts HEAD).
    (auto_dir / "automation.toml").write_text(_toml("on-demand", 128))
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "on-demand")
    os.environ["BITSWAN_COPIES_DIR"] = str(copies)
    return repo, sha


def _svc(tmp_path):
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    svc.workspace_repo_dir = str(tmp_path / "copies")  # HEAD (drifted) source
    svc.secrets_dir = str(tmp_path / "secrets")
    svc.workspace_name = "ws"
    return svc


def test_promoted_resolves_at_source_commit_not_head(tmp_path):
    _, always_on_sha = _bp_repo(tmp_path, "shop2", "backend")
    svc = _svc(tmp_path)

    conf = {
        "stage": "production",
        "relative_path": "copies/main/shop2/backend",
        # Image-baked: the checksum blob tree does not exist under gitops_dir,
        # so resolution must fall to the commit — NOT to workspace HEAD.
        "checksum": "deadbeefdeadbeef",
        "source_commit": always_on_sha,
    }
    cfg = asyncio.run(svc.resolve_automation_config(conf))
    assert cfg.memory_reservation_policy == "always-on", (
        "must read the automation.toml AT the deployment's commit (always-on), "
        "not the drifted workspace HEAD (on-demand)"
    )
    assert cfg.memory_reservation == 256


def test_legacy_no_commit_falls_back_to_workspace(tmp_path):
    # A pre-commit-pinning deploy (no source_commit) still resolves from the
    # workspace source so a frontend keeps exposing — best-effort, not a default.
    _bp_repo(tmp_path, "shop3", "backend")
    # Workspace HEAD for this automation says on-demand (C2 checked out).
    svc = _svc(tmp_path)
    conf = {
        "stage": "production",
        "relative_path": "copies/main/shop3/backend",
        "checksum": "deadbeefdeadbeef",  # no blob tree
        # no source_commit
    }
    cfg = asyncio.run(svc.resolve_automation_config(conf))
    # Working tree is at C2 (on-demand); the legacy fallback reads it.
    assert cfg.memory_reservation_policy == "on-demand"


def test_blob_tree_snapshot_wins_when_present(tmp_path):
    # When the immutable <gitops_dir>/<checksum> content snapshot still exists,
    # it is the source of truth (no git needed).
    svc = _svc(tmp_path)
    checksum = "abc123"
    snap = tmp_path / checksum / "backend"
    snap.mkdir(parents=True)
    (snap / "automation.toml").write_text(_toml("always-on", 512))
    conf = {
        "stage": "production",
        "relative_path": "backend",
        "checksum": f"{checksum}/backend",
    }
    cfg = asyncio.run(svc.resolve_automation_config(conf))
    assert cfg.memory_reservation_policy == "always-on"
    assert cfg.memory_reservation == 512


def test_missing_everything_defaults(tmp_path):
    svc = _svc(tmp_path)
    cfg = asyncio.run(
        svc.resolve_automation_config({"stage": "production", "relative_path": ""})
    )
    assert isinstance(cfg, AutomationConfig)
    assert cfg.memory_reservation_policy == "on-demand"  # the declared default
