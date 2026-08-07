"""Deployment history reads each commit ONCE, however many deployments exist.

History is asked per deployment but derived per commit. The original code read
and yaml-parsed `bitswan.yaml` at every commit separately for every deployment:
`git show <ref>:bitswan.yaml` twice per (deployment, commit) pair. On a real
workspace — 289 deployments over 140 commits — that is ~81,000 git subprocess
spawns and ~162,000 yaml parses, all on the event loop. The startup warm-up
never finished, and while it ran it starved every other request in the process
(measured: an empty 404 took 1.4s at the median).

These tests pin the fix: the number of commit reads is a function of the
COMMITS, not of the deployments, and the history each deployment gets is
unchanged.
"""

import asyncio
import os
import subprocess

import pytest
import yaml

from app.services.automation_service import AutomationService


def _git(*args, cwd):
    env = dict(os.environ)
    env.setdefault("GIT_AUTHOR_NAME", "t")
    env.setdefault("GIT_AUTHOR_EMAIL", "t@t")
    env.setdefault("GIT_COMMITTER_NAME", "t")
    env.setdefault("GIT_COMMITTER_EMAIL", "t@t")
    return subprocess.run(
        ["git", *args], cwd=cwd, env=env, capture_output=True, text=True, check=True
    )


DEPLOYMENTS = [f"dep-{i}-copy-alice-bp{i}-live-dev" for i in range(12)]


@pytest.fixture
def history_repo(tmp_path, monkeypatch):
    """A gitops dir whose bitswan.yaml gains one deployment per commit, so every
    deployment has a different, checkable history."""
    gitops_dir = tmp_path / "gitops"
    gitops_dir.mkdir()
    _git("init", "-q", "-b", "main", ".", cwd=str(gitops_dir))

    deployments: dict[str, dict] = {}
    for i, dep in enumerate(DEPLOYMENTS):
        deployments[dep] = {
            "checksum": f"sum{i}",
            "stage": "dev",
            "relative_path": f"copies/alice/bp{i}",
            "active": True,
            "replicas": 1,
        }
        with open(gitops_dir / "bitswan.yaml", "w") as f:
            yaml.safe_dump({"deployments": deployments}, f)
        _git("add", "-A", cwd=str(gitops_dir))
        _git("commit", "-qm", f"deploy {dep}", cwd=str(gitops_dir))

    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(gitops_dir))
    monkeypatch.delenv("HOST_PATH", raising=False)

    svc = AutomationService()
    svc.gitops_dir = str(gitops_dir)
    return svc


def _count_git_reads(svc, monkeypatch):
    """Count `git show <ref>:bitswan.yaml` calls the service makes."""
    reads: list[str] = []
    original = svc._fetch_yaml_at_commit

    async def _counting(commit_hash, bitswan_dir):
        reads.append(commit_hash)
        return await original(commit_hash, bitswan_dir)

    monkeypatch.setattr(svc, "_fetch_yaml_at_commit", _counting)
    return reads


def test_warm_up_reads_each_commit_once_regardless_of_deployment_count(
    history_repo, monkeypatch
):
    svc = history_repo
    reads = _count_git_reads(svc, monkeypatch)

    asyncio.run(svc.warm_history_cache())

    n_commits = len(DEPLOYMENTS)
    n_deployments = len(DEPLOYMENTS)
    # Each commit and each commit's parent, once each — and nothing per
    # deployment. The old code did 2 reads per (deployment, commit) pair.
    assert (
        len(reads) == 2 * n_commits
    ), f"expected {2 * n_commits} commit reads, got {len(reads)}"
    assert len(reads) == len(set(reads)), "a ref was read more than once"
    assert len(reads) < n_deployments * n_commits, "still scaling with deployments"


def test_history_after_warm_up_needs_no_further_commit_reads(history_repo, monkeypatch):
    """A warm process answers the History tab with zero git reads of commits."""
    svc = history_repo
    asyncio.run(svc.warm_history_cache())

    reads = _count_git_reads(svc, monkeypatch)
    for dep in DEPLOYMENTS:
        asyncio.run(svc.get_automation_history(dep))
    assert reads == [], f"served history re-read commits: {reads}"


def test_history_content_is_unchanged_by_the_shared_cache(history_repo):
    """The derived history itself must be identical to the per-deployment read.

    Each deployment was introduced by exactly one commit and never changed
    after, so each has exactly one entry, carrying that commit's message.
    """
    svc = history_repo
    for i, dep in enumerate(DEPLOYMENTS):
        page = asyncio.run(svc.get_automation_history(dep))
        assert page["total"] == 1, f"{dep}: expected one entry, got {page['total']}"
        entry = page["items"][0]
        assert entry["message"] == f"deploy {dep}"
        assert entry["checksum"] == f"sum{i}"
        assert entry["stage"] == "dev"
        assert entry["replicas"] == 1


def test_a_replica_change_is_its_own_history_entry(history_repo):
    """Guard the other branch of the comparison (replicas, not just checksum)."""
    svc = history_repo
    gitops_dir = svc.gitops_dir
    with open(os.path.join(gitops_dir, "bitswan.yaml")) as f:
        doc = yaml.safe_load(f)
    doc["deployments"][DEPLOYMENTS[0]]["replicas"] = 3
    with open(os.path.join(gitops_dir, "bitswan.yaml"), "w") as f:
        yaml.safe_dump(doc, f)
    _git("add", "-A", cwd=gitops_dir)
    _git("commit", "-qm", "scale up", cwd=gitops_dir)

    page = asyncio.run(svc.get_automation_history(DEPLOYMENTS[0]))
    assert page["total"] == 2
    assert page["items"][0]["message"] == "scale up"
    assert page["items"][0]["replicas"] == 3


def test_the_commit_list_is_reread_when_head_moves(history_repo):
    """The per-ref cache is keyed by immutable commits, but the commit LIST is
    not — a new deploy must show up."""
    svc = history_repo
    before = asyncio.run(svc.get_automation_history(DEPLOYMENTS[0]))
    assert before["total"] == 1

    gitops_dir = svc.gitops_dir
    with open(os.path.join(gitops_dir, "bitswan.yaml")) as f:
        doc = yaml.safe_load(f)
    doc["deployments"][DEPLOYMENTS[0]]["checksum"] = "sum-new"
    with open(os.path.join(gitops_dir, "bitswan.yaml"), "w") as f:
        yaml.safe_dump(doc, f)
    _git("add", "-A", cwd=gitops_dir)
    _git("commit", "-qm", "redeploy", cwd=gitops_dir)

    after = asyncio.run(svc.get_automation_history(DEPLOYMENTS[0]))
    assert after["total"] == 2
    assert after["items"][0]["checksum"] == "sum-new"
