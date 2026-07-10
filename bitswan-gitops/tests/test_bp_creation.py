"""Tests for business-process creation in the per-BP-repo world.

Creation makes the BP its OWN git repo, scaffolds process.toml + README into
the MAIN checkout, commits, and publishes to the repo's deploy-only main — a
BP is born in main (in_main from birth). The route then materializes the
requesting copy as a clone of main; every other copy can materialize it too,
immediately. (Previously the scaffold rode only the creating copy's branch and
main stayed an empty seed until Sync & Deploy, so a fresh BP was invisible to
every other copy — the ordering bug these tests pin down.)
"""

import asyncio
import os
import subprocess

import pytest

from app.services import bp_git, git_server
from app.services.process_service import ProcessService


def _git(*args, cwd=None, check=True):
    env = dict(os.environ)
    env.setdefault("GIT_AUTHOR_NAME", "t")
    env.setdefault("GIT_AUTHOR_EMAIL", "t@t")
    env.setdefault("GIT_COMMITTER_NAME", "t")
    env.setdefault("GIT_COMMITTER_EMAIL", "t@t")
    return subprocess.run(
        ["git", *args], cwd=cwd, env=env, capture_output=True, text=True, check=check
    )


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(git_server, "GIT_REPOS_DIR", str(tmp_path / "git"))
    monkeypatch.setattr(
        git_server, "HOOKS_SRC_DIR", str(tmp_path / "nonexistent-hooks")
    )
    copies_dir = tmp_path / "copies"
    copies_dir.mkdir()
    (copies_dir / "main").mkdir()
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(copies_dir))
    monkeypatch.delenv("BITSWAN_GIT_REMOTE", raising=False)
    # template_service._commit uses --author but relies on the ambient
    # committer identity (the gitops container configures one); provide it.
    monkeypatch.setenv("GIT_COMMITTER_NAME", "t")
    monkeypatch.setenv("GIT_COMMITTER_EMAIL", "t@t")
    return {"copies_dir": str(copies_dir), "svc": ProcessService()}


def test_create_in_main_publishes_bare_main(env):
    svc = env["svc"]
    entry = asyncio.run(svc.create_business_process("orders"))
    assert entry["name"] == "orders" and entry["in_main"] is True

    # The BP has its own repo and the scaffold reached its deploy-only main —
    # not just the checkout (the old latent bug).
    bare = git_server.bp_bare_repo_path("orders")
    assert os.path.isdir(os.path.join(bare, "objects"))
    assert asyncio.run(git_server.bp_main_has_content("orders")) is True
    names = _git("-C", bare, "ls-tree", "--name-only", "main").stdout.split()
    assert "process.toml" in names and "README.md" in names

    # The main checkout is a clone of the BP repo, clean and aligned.
    clone = os.path.join(env["copies_dir"], "main", "orders")
    assert os.path.isdir(os.path.join(clone, ".git"))
    assert _git("status", "--porcelain", cwd=clone).stdout.strip() == ""


def test_new_bp_is_born_in_main_and_copy_switchable(env):
    """A BP is created in main FIRST (in_main from birth), so it can be
    materialized into any copy immediately — the fix for the ordering bug where a
    fresh BP rode only the creating copy's branch and stayed invisible to every
    other copy until Sync & Deploy."""
    svc = env["svc"]
    entry = asyncio.run(svc.create_business_process("orders"))
    assert entry["in_main"] is True
    # Born in main: the scaffold reached the repo's deploy-only main immediately.
    assert asyncio.run(git_server.bp_main_has_content("orders")) is True

    # The create route materializes the requesting copy as a clone of main (after
    # adding the template to main); model that here — the copy branches off main.
    copy_dir = os.path.join(env["copies_dir"], "u1")
    os.makedirs(copy_dir)
    ok = asyncio.run(bp_git.clone_bp_into_copy(copy_dir, "u1", "orders", base="main"))
    assert ok is True
    clone = os.path.join(copy_dir, "orders")
    assert os.path.isfile(os.path.join(clone, "process.toml"))
    branch = _git("rev-parse", "--abbrev-ref", "HEAD", cwd=clone).stdout.strip()
    assert branch == "u1"

    # THE FIX: a SECOND copy created afterwards also materializes the BP straight
    # from main — the switch-copies case that was impossible before (the BP only
    # existed on the first copy's branch, not main).
    copy2 = os.path.join(env["copies_dir"], "u2")
    os.makedirs(copy2)
    ok2 = asyncio.run(bp_git.clone_bp_into_copy(copy2, "u2", "orders", base="main"))
    assert ok2 is True
    assert os.path.isfile(os.path.join(copy2, "orders", "process.toml"))


def test_create_duplicate_rejected(env):
    svc = env["svc"]
    asyncio.run(svc.create_business_process("orders"))
    with pytest.raises(FileExistsError):
        asyncio.run(svc.create_business_process("orders"))


def test_create_with_human_readable_name(env):
    """Issue #77: the typed name is the display name; the directory, repo and
    wire `name` are the slug derived from it, and process.toml records both."""
    import toml

    svc = env["svc"]
    entry = asyncio.run(svc.create_business_process("Zpracování faktur (v2)"))
    assert entry["name"] == "zpracovani-faktur-v2"
    assert entry["display_name"] == "Zpracování faktur (v2)"

    clone = os.path.join(env["copies_dir"], "main", "zpracovani-faktur-v2")
    cfg = toml.load(os.path.join(clone, "process.toml"))
    assert cfg["name"] == "Zpracování faktur (v2)"
    assert cfg["process-id"] == entry["id"]
    with open(os.path.join(clone, "README.md")) as f:
        assert f.read().startswith("# Zpracování faktur (v2)")

    # Discovery round-trips the display name into the SSE/REST snapshot.
    svc.refresh(None)
    listed = {e["name"]: e for e in svc.get_all_processes()}
    assert listed["zpracovani-faktur-v2"]["display_name"] == "Zpracování faktur (v2)"


def test_create_slug_collision_rejected(env):
    """Two display names that slugify identically fight over one directory."""
    svc = env["svc"]
    asyncio.run(svc.create_business_process("Invoice Processing"))
    with pytest.raises(FileExistsError):
        asyncio.run(svc.create_business_process("invoice   PROCESSING!"))


def test_create_unslugifiable_name_rejected(env):
    svc = env["svc"]
    with pytest.raises(ValueError):
        asyncio.run(svc.create_business_process("---"))


def test_discovery_falls_back_to_dir_name(env):
    """BPs created before the `name` key existed display their directory name."""
    svc = env["svc"]
    asyncio.run(svc.create_business_process("orders"))
    clone = os.path.join(env["copies_dir"], "main", "orders")
    toml_path = os.path.join(clone, "process.toml")
    with open(toml_path) as f:
        pid_line = [line for line in f if line.startswith("process-id")]
    with open(toml_path, "w") as f:
        f.writelines(pid_line)

    svc.refresh(None)
    listed = {e["name"]: e for e in svc.get_all_processes()}
    assert listed["orders"]["display_name"] == "orders"


def test_rename_updates_display_name_and_publishes(env):
    """Renaming changes only process.toml's `name`: the slug (directory,
    repo, deployment ids) stays, and the commit reaches the deploy-only main
    like any other main-scope service commit."""
    import toml

    svc = env["svc"]
    created = asyncio.run(svc.create_business_process("Invoice Processing"))

    entry = asyncio.run(
        svc.rename_business_process("invoice-processing", "Zpracování faktur")
    )
    assert entry["name"] == "invoice-processing"
    assert entry["display_name"] == "Zpracování faktur"
    assert entry["id"] == created["id"]

    clone = os.path.join(env["copies_dir"], "main", "invoice-processing")
    cfg = toml.load(os.path.join(clone, "process.toml"))
    assert cfg["name"] == "Zpracování faktur"
    assert cfg["process-id"] == created["id"]

    bare = git_server.bp_bare_repo_path("invoice-processing")
    subject = _git("-C", bare, "log", "-1", "--format=%s", "main").stdout.strip()
    assert subject == "Rename business process Invoice Processing to Zpracování faktur"

    # Discovery round-trips the new display name into the SSE/REST snapshot.
    listed = {e["name"]: e for e in svc.get_all_processes()}
    assert listed["invoice-processing"]["display_name"] == "Zpracování faktur"


def test_rename_copy_scope_stays_local(env):
    """A copy-scope rename rides the copy until Sync & Deploy — the repo's
    main must not advance (same rule as copy-scope creation)."""
    svc = env["svc"]
    copy_dir = os.path.join(env["copies_dir"], "u1")
    os.makedirs(copy_dir)
    asyncio.run(svc.create_business_process("orders", copy="u1"))

    entry = asyncio.run(
        svc.rename_business_process("orders", "Order Intake", copy="u1")
    )
    assert entry["display_name"] == "Order Intake"
    assert asyncio.run(git_server.bp_main_has_content("orders")) is False


def test_rename_noop_creates_no_commit(env):
    svc = env["svc"]
    asyncio.run(svc.create_business_process("orders"))
    bare = git_server.bp_bare_repo_path("orders")
    before = _git("-C", bare, "rev-parse", "main").stdout.strip()
    asyncio.run(svc.rename_business_process("orders", "orders"))
    assert _git("-C", bare, "rev-parse", "main").stdout.strip() == before


def test_rename_legacy_bp_without_name_key(env):
    """Pre-#77 BPs (no `name` in process.toml) can be renamed; the commit
    message falls back to the directory name for the old side."""
    import toml

    svc = env["svc"]
    asyncio.run(svc.create_business_process("orders"))
    clone = os.path.join(env["copies_dir"], "main", "orders")
    toml_path = os.path.join(clone, "process.toml")
    with open(toml_path) as f:
        pid_line = [line for line in f if line.startswith("process-id")]
    with open(toml_path, "w") as f:
        f.writelines(pid_line)
    _git("add", "-A", cwd=clone)
    _git("commit", "-m", "strip name key", cwd=clone)

    asyncio.run(svc.rename_business_process("orders", "Order Intake"))
    assert toml.load(toml_path)["name"] == "Order Intake"
    subject = _git("log", "-1", "--format=%s", cwd=clone).stdout.strip()
    assert subject == "Rename business process orders to Order Intake"


def test_rename_missing_bp_rejected(env):
    svc = env["svc"]
    with pytest.raises(FileNotFoundError):
        asyncio.run(svc.rename_business_process("nope", "New Name"))


def test_rename_unslugifiable_name_rejected(env):
    svc = env["svc"]
    asyncio.run(svc.create_business_process("orders"))
    with pytest.raises(ValueError):
        asyncio.run(svc.rename_business_process("orders", "---"))


def test_waiver_write_publishes_main_scope(env):
    """A main-scope CVE waiver is committed in the BP clone AND advances the
    repo's main (it would otherwise be wiped by the next realign)."""
    from app.services import cve_waivers

    svc = env["svc"]
    asyncio.run(svc.create_business_process("orders"))
    asyncio.run(
        cve_waivers.set_waiver(
            "orders", None, "libx", "CVE-2024-1", "accepted", "a@b", "Jan 1, 2026"
        )
    )
    bare = git_server.bp_bare_repo_path("orders")
    names = _git("-C", bare, "ls-tree", "--name-only", "main").stdout.split()
    assert "cve-waivers.yaml" in names
    # And the copy-scope variant stays local until sync.
    copy_dir = os.path.join(env["copies_dir"], "u1")
    os.makedirs(copy_dir)
    asyncio.run(bp_git.clone_bp_into_copy(copy_dir, "u1", "orders"))
    asyncio.run(
        cve_waivers.set_waiver(
            "orders", "u1", "liby", "CVE-2024-2", "accepted", "a@b", "Jan 1, 2026"
        )
    )
    main_names = _git("-C", bare, "ls-tree", "--name-only", "main").stdout
    content = _git("-C", bare, "show", "main:cve-waivers.yaml").stdout
    assert "CVE-2024-2" not in content
    assert "cve-waivers.yaml" in main_names
