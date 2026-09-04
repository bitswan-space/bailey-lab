"""The audit environment materialized when staging is frozen."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from app.services import audit_env


def git(*args, cwd):
    subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        env={
            **os.environ,
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@example.com",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@example.com",
        },
    )


@pytest.fixture()
def repo(tmp_path, monkeypatch):
    """A BP repo with two commits: what production serves, then what staging
    has frozen. Returns (clone_dir, production_commit, audited_commit)."""
    monkeypatch.setenv("BITSWAN_AUDITS_DIR", str(tmp_path / "audits"))
    clone = tmp_path / "clone"
    clone.mkdir()
    git("init", "-q", "-b", "main", cwd=clone)
    (clone / "worker.py").write_text("def run():\n    return 1\n")
    (clone / "README.md").write_text("# invoice processing\n")
    git("add", ".", cwd=clone)
    git("commit", "-qm", "in production", cwd=clone)
    production = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=clone, capture_output=True, text=True
    ).stdout.strip()
    (clone / "worker.py").write_text(
        "def run():\n    return 2  # totals now include VAT\n"
    )
    (clone / "vendors").mkdir()
    (clone / "vendors" / "ares.py").write_text("VAT_LOOKUP = 'https://ares.example'\n")
    git("add", ".", cwd=clone)
    git("commit", "-qm", "awaiting audit", cwd=clone)
    audited = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=clone, capture_output=True, text=True
    ).stdout.strip()
    return str(clone), production, audited


async def test_prepare_lays_out_the_audited_source_and_the_diff(repo):
    clone, production, audited = repo
    env = await audit_env.prepare("invoices", "sha1234", audited, production, clone)

    assert env["ready"] is True
    src = audit_env.source_dir("invoices", "sha1234")
    assert open(os.path.join(src, "worker.py")).read().endswith("include VAT\n")
    assert os.path.exists(os.path.join(src, "vendors", "ares.py"))

    diff = audit_env.read_diff("invoices", "sha1234")["diff"]
    assert "worker.py" in diff
    assert "+    return 2" in diff
    assert "vendors/ares.py" in diff

    brief = open(audit_env.brief_path("invoices", "sha1234")).read()
    assert "report.md" in brief
    assert audited[:12] in brief
    assert production[:12] in brief


async def test_the_source_is_the_audited_version_not_the_tip(repo):
    clone, production, _ = repo
    await audit_env.prepare("invoices", "old", production, None, clone)
    src = audit_env.source_dir("invoices", "old")
    assert open(os.path.join(src, "worker.py")).read() == "def run():\n    return 1\n"
    assert not os.path.exists(os.path.join(src, "vendors"))
    assert "nothing deployed" in audit_env.read_diff("invoices", "old")["diff"]


async def test_report_survives_a_refreeze_but_the_source_is_rebuilt(repo):
    clone, production, audited = repo
    await audit_env.prepare("invoices", "sha1234", audited, production, clone)
    audit_env.write_report("invoices", "sha1234", "# Findings\n\nLooks fine.\n")
    stray = os.path.join(audit_env.source_dir("invoices", "sha1234"), "stray.txt")
    open(stray, "w").write("left over from a previous extraction")

    await audit_env.prepare("invoices", "sha1234", audited, production, clone)

    assert audit_env.read_report("invoices", "sha1234")["content"].startswith(
        "# Findings"
    )
    assert not os.path.exists(stray)


async def test_teardown_keeps_the_evidence_and_drops_the_copy(repo):
    clone, production, audited = repo
    await audit_env.prepare("invoices", "sha1234", audited, production, clone)
    audit_env.write_report("invoices", "sha1234", "# Findings\n")

    audit_env.teardown("invoices", "sha1234")

    assert not os.path.isdir(audit_env.source_dir("invoices", "sha1234"))
    assert audit_env.read_report("invoices", "sha1234")["content"] == "# Findings\n"
    assert audit_env.read_diff("invoices", "sha1234")["exists"] is True
    assert audit_env.describe("invoices", "sha1234")["ready"] is False


async def test_search_finds_matches_in_the_audited_source(repo):
    clone, production, audited = repo
    await audit_env.prepare("invoices", "sha1234", audited, production, clone)

    hits = audit_env.search("invoices", "sha1234", "vat")
    paths = {m["path"] for m in hits["matches"]}
    assert "worker.py" in paths
    assert "vendors/ares.py" in paths
    assert hits["truncated"] is False
    assert all(m["line"] > 0 for m in hits["matches"])

    assert audit_env.search("invoices", "sha1234", "")["matches"] == []
    assert audit_env.search("invoices", "sha1234", "no-such-token")["matches"] == []


async def test_search_stops_at_the_limit(repo):
    clone, _, audited = repo
    await audit_env.prepare("invoices", "many", audited, None, clone)
    big = os.path.join(audit_env.source_dir("invoices", "many"), "many.txt")
    open(big, "w").write("vat\n" * 50)
    hits = audit_env.search("invoices", "many", "vat", limit=10)
    assert len(hits["matches"]) == 10
    assert hits["truncated"] is True


def test_a_bp_or_sha_that_would_escape_the_audits_directory_is_refused():
    for bad in ("../etc", "a/b", "", "."):
        with pytest.raises(ValueError):
            audit_env.audit_dir(bad, "sha")
        with pytest.raises(ValueError):
            audit_env.audit_dir("invoices", bad)


async def test_a_commit_that_is_not_there_is_an_error_not_an_empty_audit(repo):
    clone, _, _ = repo
    with pytest.raises(ValueError):
        await audit_env.prepare("invoices", "sha1234", "deadbeef", None, clone)
    with pytest.raises(ValueError):
        await audit_env.prepare("invoices", "sha1234", "not-a-sha", None, clone)


def test_describe_says_so_when_staging_is_not_frozen():
    d = audit_env.describe("invoices", None)
    assert d["ready"] is False
    assert "not frozen" in d["reason"]


async def test_a_report_over_the_cap_is_refused(repo):
    clone, _, audited = repo
    await audit_env.prepare("invoices", "sha1234", audited, None, clone)
    with pytest.raises(ValueError):
        audit_env.write_report(
            "invoices", "sha1234", "x" * (audit_env.MAX_REPORT_BYTES + 1)
        )


async def test_a_link_out_of_the_repository_is_left_out_not_fatal(repo, tmp_path):
    """The business-process scaffold ships `backend/go.mod` as a symlink to
    `/deps/go.mod`, which is resolved inside the build image and points nowhere
    in the archive. Refusing to build the audit environment over it took the
    whole audit away — the e2e caught exactly that."""
    clone, production, audited = repo
    (Path(clone) / "backend").mkdir()
    os.symlink("/deps/go.mod", Path(clone) / "backend" / "go.mod")
    (Path(clone) / "backend" / "main.go").write_text("package main\n")
    git("add", "-A", cwd=clone)
    git("commit", "-qm", "scaffold links", cwd=clone)
    tip = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=clone, capture_output=True, text=True
    ).stdout.strip()

    env = await audit_env.prepare("invoices", "links", tip, production, clone)

    assert env["ready"] is True
    src = audit_env.source_dir("invoices", "links")
    assert (Path(src) / "backend" / "main.go").read_text() == "package main\n"
    assert not (Path(src) / "backend" / "go.mod").exists()
    # …and the brief says what the copy is missing, so the auditor is not left
    # wondering whether a file was deleted or never copied.
    brief = open(audit_env.brief_path("invoices", "links")).read()
    assert "Left out of this copy" in brief
    assert "backend/go.mod" in brief


async def test_an_in_repository_symlink_survives(repo, tmp_path):
    clone, _, _ = repo
    (Path(clone) / "shared.py").write_text("SHARED = 1\n")
    os.symlink("shared.py", Path(clone) / "alias.py")
    git("add", "-A", cwd=clone)
    git("commit", "-qm", "relative link", cwd=clone)
    tip = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=clone, capture_output=True, text=True
    ).stdout.strip()

    await audit_env.prepare("invoices", "rel", tip, None, clone)
    src = Path(audit_env.source_dir("invoices", "rel"))
    assert (src / "alias.py").is_symlink()
    assert (src / "alias.py").read_text() == "SHARED = 1\n"


async def test_an_empty_source_directory_is_not_a_ready_environment(repo):
    clone, _, audited = repo
    await audit_env.prepare("invoices", "empty", audited, None, clone)
    src = audit_env.source_dir("invoices", "empty")
    for name in os.listdir(src):
        target = os.path.join(src, name)
        if os.path.isdir(target):
            shutil.rmtree(target)
        else:
            os.remove(target)
    assert audit_env.describe("invoices", "empty")["ready"] is False
