"""`POST /automations/rebuild-and-deploy` — the recovery converge.

Per-BP images live only in the local Docker image store; no backup contains
them. The ordinary `/deploy` does not build — the compiled compose names an
`internal/…` tag with no `build:` and no pull_policy — so on a rebuilt host
compose tries to PULL that tag from Docker Hub and the whole converge fails.
This endpoint builds first.

What these tests pin:
  * images are rebuilt for every source, then the normal converge runs — in
    that order, because the converge is what fails without them;
  * only the pure `prep_deploy_source` is used, so git state and bitswan.yaml
    are untouched (a rebuild is not a redeployment);
  * one automation failing to build does not cost the rest of the workspace;
  * pinned images the rebuild could NOT reproduce are reported, since that is
    the case an operator must act on (re-promote) rather than discover as a
    container that never starts.
"""

import pytest

from app.services.automation_service import AutomationService


@pytest.fixture
def svc(tmp_path, monkeypatch):
    svc = AutomationService()
    gitops = tmp_path / "gitops"
    ws = tmp_path / "workspace-repo"
    gitops.mkdir()
    ws.mkdir()
    svc.gitops_dir = str(gitops)
    svc.gitops_dir_host = str(gitops)
    svc.workspace_repo_dir = str(ws)
    svc.workspace_name = "acme"
    return svc


def _install(monkeypatch, svc, sources, pinned=None, prep=None):
    """Stub the filesystem scan, the restored bitswan.yaml and the converge."""
    calls = {"prepped": [], "deployed": 0, "order": []}

    monkeypatch.setattr(
        "app.services.automation_service.scan_workspace_sources",
        lambda root, copy=None: sources,
    )
    monkeypatch.setattr(
        "app.services.automation_service.read_bitswan_yaml",
        lambda _dir: {"deployments": pinned or {}},
    )

    async def fake_prep(relative_path, stage, copy=None, progress_callback=None):
        calls["prepped"].append((relative_path, stage))
        calls["order"].append("prep")
        if prep is not None:
            return prep(relative_path)
        return {
            "deployment_id": relative_path.replace("/", "-"),
            "image": f"internal/acme-{relative_path.split('/')[-1]}-app:shaOK",
        }

    async def fake_deploy():
        calls["deployed"] += 1
        calls["order"].append("deploy")
        return {"message": "Deployed successfully"}

    monkeypatch.setattr(svc, "prep_deploy_source", fake_prep)
    monkeypatch.setattr(svc, "deploy_automations", fake_deploy)
    return calls


async def test_builds_every_source_then_converges(svc, monkeypatch):
    sources = [
        {"relative_path": "copies/main/bp/backend"},
        {"relative_path": "copies/main/bp/frontend"},
    ]
    calls = _install(monkeypatch, svc, sources)

    out = await svc.rebuild_all_images_and_deploy()

    assert [p[0] for p in calls["prepped"]] == [
        "copies/main/bp/backend",
        "copies/main/bp/frontend",
    ]
    # The converge must come last: it is what would fail without the images.
    assert calls["order"] == ["prep", "prep", "deploy"]
    assert calls["deployed"] == 1
    assert len(out["rebuilt"]) == 2
    assert out["build_failures"] == []


async def test_uses_only_the_pure_prep_so_git_state_is_untouched(svc, monkeypatch):
    # prep_deploy_source is documented as no-yaml-write / no-commit / no-compose.
    # Reaching for deploy_business_process instead would rewrite bitswan.yaml and
    # record deploy history, turning a recovery into a redeployment.
    calls = _install(monkeypatch, svc, [{"relative_path": "copies/main/bp/backend"}])

    def explode(*_a, **_k):
        raise AssertionError("a rebuild must not run a deploy that rewrites git state")

    monkeypatch.setattr(svc, "deploy_business_process", explode)
    monkeypatch.setattr(svc, "deploy_source_set", explode)
    monkeypatch.setattr(svc, "write_deployment_entries", explode)

    await svc.rebuild_all_images_and_deploy()
    assert calls["prepped"] == [("copies/main/bp/backend", "dev")]


async def test_one_failed_build_does_not_cost_the_workspace(svc, monkeypatch):
    sources = [
        {"relative_path": "copies/main/bp/broken"},
        {"relative_path": "copies/main/bp/fine"},
    ]

    def prep(relative_path):
        if "broken" in relative_path:
            raise RuntimeError("Image build failed: missing base")
        return {"deployment_id": "fine", "image": "internal/acme-fine-app:shaOK"}

    calls = _install(monkeypatch, svc, sources, prep=prep)

    out = await svc.rebuild_all_images_and_deploy()

    assert calls["deployed"] == 1, "the rest of the workspace must still converge"
    assert [f["relative_path"] for f in out["build_failures"]] == ["copies/main/bp/broken"]
    assert "missing base" in out["build_failures"][0]["error"]
    assert [r["relative_path"] for r in out["rebuilt"]] == ["copies/main/bp/fine"]


async def test_reports_pinned_images_it_could_not_reproduce(svc, monkeypatch):
    # A promoted tag is only reproducible while the source still hashes to it.
    # Once the tree has moved on, that artifact is gone and the operator has to
    # re-promote — so it must be named, not silently missing.
    sources = [{"relative_path": "copies/main/bp/backend"}]
    pinned = {
        "backend-bp-dev": {"image": "internal/acme-backend-app:shaOK"},
        "backend-bp-production": {"image": "internal/acme-backend-app:shaOLD"},
    }
    _install(
        monkeypatch,
        svc,
        sources,
        pinned=pinned,
        prep=lambda _p: {
            "deployment_id": "backend-bp-dev",
            "image": "internal/acme-backend-app:shaOK",
        },
    )

    out = await svc.rebuild_all_images_and_deploy()

    assert out["unreproduced_images"] == {
        "backend-bp-production": "internal/acme-backend-app:shaOLD"
    }, "the production pin no longer matches the source and must be flagged"


async def test_a_workspace_with_no_sources_still_converges(svc, monkeypatch):
    calls = _install(monkeypatch, svc, [])
    await svc.rebuild_all_images_and_deploy()
    assert calls["prepped"] == []
    assert calls["deployed"] == 1
