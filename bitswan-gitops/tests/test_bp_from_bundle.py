"""Tests for restoring a business process from a deployment bundle (issue #82).

The Inspect → Download bundle endpoint produces a source-only tar.gz
(``bitswan-bp-bundle/2``: manifest.json + source/ at the bundled commit — no
docker images, no DB dumps) and ``POST /processes/from-bundle`` accepts it to
create a NEW business process. The restored BP must be a genuinely new process:
a fresh ``process-id`` and fresh ``[deployment] id``s so it can never collide
with (or hijack) the BP it was bundled from. Same fixture style as
test_bp_creation.py: real git, no docker.
"""

import asyncio
import io
import json
import os
import subprocess
import tarfile

import pytest
import toml

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
    monkeypatch.setenv("GIT_COMMITTER_NAME", "t")
    monkeypatch.setenv("GIT_COMMITTER_EMAIL", "t@t")
    return {"copies_dir": str(copies_dir), "svc": ProcessService()}


AUTOMATION_TOML = """# Backend worker for the shop.
[deployment]
# The deployment id keys the container + routes.
id = "11111111-1111-1111-1111-111111111111"
memory-reservation = 128
"""


def _make_bundle(
    files: dict[str, str],
    manifest: dict | None = None,
    top: str = "shop-dev-c68b64fe",
) -> bytes:
    """Assemble an in-memory bundle tar.gz: `files` are paths relative to the
    payload root (`manifest.json`, `source/...`); `top` is the wrapping
    top-level directory ("" = payload at archive root)."""
    if manifest is not None:
        files = {**files, "manifest.json": json.dumps(manifest)}
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for rel, content in files.items():
            data = content.encode()
            info = tarfile.TarInfo(name=os.path.join(top, rel) if top else rel)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def _manifest(**overrides) -> dict:
    base = {
        "format": "bitswan-bp-bundle/2",
        "bp": "shop",
        "display_name": "Shop",
        "stage": "dev",
        "commit": "c68b64fe8fd4000836c2e2fc05dc9301dc39c656",
    }
    base.update(overrides)
    return base


def _source_files() -> dict[str, str]:
    return {
        "source/process.toml": (
            'process-id = "99999999-9999-9999-9999-999999999999"\nname = "Shop"\n'
        ),
        "source/README.md": "# Shop\n",
        "source/backend/automation.toml": AUTOMATION_TOML,
        "source/backend/main.py": "print('hi')\n",
    }


def test_restore_happy_path(env):
    svc = env["svc"]
    bundle = _make_bundle(_source_files(), manifest=_manifest())
    entry = asyncio.run(
        svc.create_business_process_from_bundle(bundle, created_by="a@b")
    )
    assert entry["name"] == "shop" and entry["in_main"] is True
    assert entry["display_name"] == "Shop"

    # The source tree landed in the main checkout and reached the repo's
    # deploy-only main (born in main, like create).
    clone = os.path.join(env["copies_dir"], "main", "shop")
    assert os.path.isfile(os.path.join(clone, "backend", "main.py"))
    assert asyncio.run(git_server.bp_main_has_content("shop")) is True
    bare = git_server.bp_bare_repo_path("shop")
    names = _git("-C", bare, "ls-tree", "-r", "--name-only", "main").stdout.split()
    assert "process.toml" in names and "backend/automation.toml" in names
    # No bundle plumbing leaks into the BP tree.
    assert "manifest.json" not in names

    subject = _git("-C", bare, "log", "-1", "--format=%s", "main").stdout.strip()
    assert subject == "Restore business process Shop from bundle of shop@c68b64fe"
    author = _git("-C", bare, "log", "-1", "--format=%ae", "main").stdout.strip()
    assert author == "a@b"

    # Discovery sees it immediately (the route broadcasts this snapshot).
    listed = {e["name"]: e for e in svc.get_all_processes()}
    assert listed["shop"]["display_name"] == "Shop"


def test_restore_regenerates_all_ids(env):
    """A restored BP is a NEW process: fresh process-id, and every member
    automation gets a fresh [deployment] id — never the bundle's."""
    svc = env["svc"]
    entry = asyncio.run(
        svc.create_business_process_from_bundle(
            _make_bundle(_source_files(), manifest=_manifest())
        )
    )
    clone = os.path.join(env["copies_dir"], "main", "shop")

    cfg = toml.load(os.path.join(clone, "process.toml"))
    assert cfg["process-id"] == entry["id"]
    assert cfg["process-id"] != "99999999-9999-9999-9999-999999999999"

    with open(os.path.join(clone, "backend", "automation.toml")) as f:
        content = f.read()
    auto = toml.loads(content)
    assert auto["deployment"]["id"] != "11111111-1111-1111-1111-111111111111"
    # Targeted string edit: comments and sibling keys survive.
    assert "# Backend worker for the shop." in content
    assert "# The deployment id keys the container + routes." in content
    assert auto["deployment"]["memory-reservation"] == 128


def test_restore_two_restores_get_distinct_ids(env):
    """Restoring the same bundle twice (under different names) must yield two
    BPs with disjoint identities."""
    svc = env["svc"]
    bundle = _make_bundle(_source_files(), manifest=_manifest())
    asyncio.run(svc.create_business_process_from_bundle(bundle, name="Shop A"))
    asyncio.run(svc.create_business_process_from_bundle(bundle, name="Shop B"))
    ids = set()
    for slug in ("shop-a", "shop-b"):
        clone = os.path.join(env["copies_dir"], "main", slug)
        ids.add(toml.load(os.path.join(clone, "process.toml"))["process-id"])
        ids.add(
            toml.load(os.path.join(clone, "backend", "automation.toml"))["deployment"][
                "id"
            ]
        )
    assert len(ids) == 4  # 2 process-ids + 2 deployment ids, all distinct


def test_restore_name_override(env):
    svc = env["svc"]
    entry = asyncio.run(
        svc.create_business_process_from_bundle(
            _make_bundle(_source_files(), manifest=_manifest()),
            name="Shop Restored",
        )
    )
    assert entry["name"] == "shop-restored"
    assert entry["display_name"] == "Shop Restored"
    clone = os.path.join(env["copies_dir"], "main", "shop-restored")
    assert toml.load(os.path.join(clone, "process.toml"))["name"] == "Shop Restored"


def test_restore_accepts_payload_at_archive_root(env):
    """The pair manifest.json + source/ at the archive root (no wrapping
    top-level dir) is accepted too."""
    svc = env["svc"]
    entry = asyncio.run(
        svc.create_business_process_from_bundle(
            _make_bundle(_source_files(), manifest=_manifest(), top="")
        )
    )
    assert entry["name"] == "shop"


def test_restore_rejects_wrong_format(env):
    svc = env["svc"]
    with pytest.raises(ValueError, match="bitswan-bp-bundle/2"):
        asyncio.run(
            svc.create_business_process_from_bundle(
                _make_bundle(
                    _source_files(), manifest=_manifest(format="bitswan-bp-bundle/1")
                )
            )
        )


def test_restore_rejects_missing_manifest(env):
    svc = env["svc"]
    with pytest.raises(ValueError, match="manifest.json"):
        asyncio.run(
            svc.create_business_process_from_bundle(_make_bundle(_source_files()))
        )


def test_restore_rejects_missing_process_toml(env):
    svc = env["svc"]
    files = {k: v for k, v in _source_files().items() if "process.toml" not in k}
    with pytest.raises(ValueError, match="process.toml"):
        asyncio.run(
            svc.create_business_process_from_bundle(
                _make_bundle(files, manifest=_manifest())
            )
        )


def test_restore_rejects_garbage_archive(env):
    svc = env["svc"]
    with pytest.raises(ValueError, match="not a valid"):
        asyncio.run(svc.create_business_process_from_bundle(b"not a tarball"))


def test_restore_duplicate_slug_rejected(env):
    svc = env["svc"]
    asyncio.run(svc.create_business_process("Shop"))
    with pytest.raises(FileExistsError):
        asyncio.run(
            svc.create_business_process_from_bundle(
                _make_bundle(_source_files(), manifest=_manifest())
            )
        )


def test_bundle_roundtrip(env, tmp_path, monkeypatch):
    """End-to-end pair: the archive built by bundle_deployment is accepted by
    create_business_process_from_bundle and reproduces the source tree (with
    regenerated identities)."""
    from app.services.automation_service import AutomationService
    from app.utils import dump_bitswan_yaml

    svc = env["svc"]
    asyncio.run(svc.create_business_process("Shop"))

    # Add a member automation and publish it to the BP repo's main.
    clone = os.path.join(env["copies_dir"], "main", "shop")
    os.makedirs(os.path.join(clone, "backend"))
    with open(os.path.join(clone, "backend", "automation.toml"), "w") as f:
        f.write(AUTOMATION_TOML)
    asyncio.run(bp_git.commit_in_bp_clone(clone, "add backend"))
    asyncio.run(bp_git.publish_main_from_clone(clone, "shop"))
    sha = _git("rev-parse", "HEAD", cwd=clone).stdout.strip()

    # A deployed stage in bitswan.yaml is what makes the bundle downloadable.
    gitops_dir = tmp_path / "gitops"
    gitops_dir.mkdir()
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))
    asvc = AutomationService()
    asvc.gitops_dir = str(gitops_dir)
    with open(gitops_dir / "bitswan.yaml", "w") as f:
        # dump_bitswan_yaml groups the flat map into business_processes[bp][stage].
        dump_bitswan_yaml(
            {
                "deployments": {
                    "backend-shop-dev": {
                        "context": "shop",
                        "stage": "dev",
                        "image": "img:1",
                        "source_commit": sha,
                    }
                }
            },
            f,
        )

    out_path = asyncio.run(asvc.bundle_deployment("shop", "dev", sha))
    try:
        with tarfile.open(out_path) as t:
            names = t.getnames()
            top = f"shop-dev-{sha[:8]}"
            assert f"{top}/manifest.json" in names
            assert f"{top}/source/process.toml" in names
            assert f"{top}/source/backend/automation.toml" in names
            manifest = json.load(t.extractfile(f"{top}/manifest.json"))
        assert manifest == {
            "format": "bitswan-bp-bundle/2",
            "bp": "shop",
            "display_name": "Shop",
            "stage": "dev",
            "commit": sha,
        }

        with open(out_path, "rb") as f:
            bundle = f.read()
    finally:
        os.remove(out_path)

    entry = asyncio.run(
        svc.create_business_process_from_bundle(bundle, name="Shop Restored")
    )
    assert entry["name"] == "shop-restored"
    restored = os.path.join(env["copies_dir"], "main", "shop-restored")
    assert os.path.isfile(os.path.join(restored, "backend", "automation.toml"))
    with open(os.path.join(restored, "README.md")) as f:
        assert f.read() == "# Shop\n"
    # Fresh identities, disjoint from the original BP's.
    orig_pid = toml.load(os.path.join(clone, "process.toml"))["process-id"]
    new_cfg = toml.load(os.path.join(restored, "process.toml"))
    assert new_cfg["process-id"] != orig_pid
    assert new_cfg["name"] == "Shop Restored"
    dep_id = toml.load(os.path.join(restored, "backend", "automation.toml"))[
        "deployment"
    ]["id"]
    assert dep_id != "11111111-1111-1111-1111-111111111111"


def test_bundle_requires_deployed_stage(env, tmp_path, monkeypatch):
    """No bitswan.yaml entry for the bp+stage → 404, never an empty archive."""
    from fastapi import HTTPException

    from app.services.automation_service import AutomationService

    svc = env["svc"]
    asyncio.run(svc.create_business_process("Shop"))
    clone = os.path.join(env["copies_dir"], "main", "shop")
    sha = _git("rev-parse", "HEAD", cwd=clone).stdout.strip()

    gitops_dir = tmp_path / "gitops"
    gitops_dir.mkdir()
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))
    asvc = AutomationService()
    asvc.gitops_dir = str(gitops_dir)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(asvc.bundle_deployment("shop", "dev", sha))
    assert exc.value.status_code == 404

    with pytest.raises(HTTPException) as exc:
        asyncio.run(asvc.bundle_deployment("shop", "dev", "not-a-sha"))
    assert exc.value.status_code == 400
