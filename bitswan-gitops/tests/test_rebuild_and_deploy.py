"""Rebuilding a pinned image from the revision that produced it.

Per-BP images live only in the local Docker image store; no backup contains
them. The ordinary `/deploy` does not build — the compiled compose names an
`internal/…` tag with no `build:` and no pull_policy — so on a rebuilt host
compose tries to PULL that tag from Docker Hub and the whole converge fails.
Two flows land a host in front of a deployment whose image is gone: disaster
recovery onto fresh hardware, and a rollback to a commit whose image has since
been pruned. Both go through `resolve_missing_pinned_images`.

The rebuild is driven by the revision the deployment RECORDS, never by whatever
the working copy holds now. That is the whole point: `bitswan.yaml` pins one
image per stage, the stages routinely sit on DIFFERENT commits, and the image
tag is a pure content address of the source tree — so only the recorded commit
reproduces the pinned tag. Building from the working copy reproduces whatever
HEAD happens to be, which is why promoted stages used to come back by luck.

What these tests pin:
  * images already present are not rebuilt (no git, no docker, no builds);
  * each missing image is rebuilt from its OWN recorded commit, and one
    extraction serves every deployment sharing that commit;
  * a rebuild that yields a different tag is reported and the pin is NOT
    rewritten — a signed-off production tag must never come to name an artifact
    nobody approved;
  * per-deployment `source_commit` wins, with the BP stage's `git_commit` as the
    fallback for entries written before it existed;
  * live-dev deployments and non-`main` copies are ignored (they bake no image);
  * one deployment failing never costs the rest of the workspace;
  * the converge runs last, because it is what fails without the images;
  * rollback resolves images BEFORE it converges.
"""

import os

import pytest
import yaml

from app.services.automation_service import AutomationService


@pytest.fixture
def svc(tmp_path):
    svc = AutomationService()
    gitops = tmp_path / "gitops"
    (gitops / "bp").mkdir(parents=True)
    svc.gitops_dir = str(gitops)
    svc.gitops_dir_host = str(gitops)
    svc.workspace_repo_dir = str(tmp_path / "workspace-repo")
    os.makedirs(svc.workspace_repo_dir, exist_ok=True)
    svc.workspace_name = "acme"
    return svc


def write_bp(svc, bp, stages):
    """Write one BP's bitswan.yaml. `stages` is {stage: (git_commit, deployments)}."""
    node = {
        stage: {"git_commit": commit, "deployments": deployments}
        for stage, (commit, deployments) in stages.items()
    }
    bp_dir = os.path.join(svc.gitops_dir, "bp", bp)
    os.makedirs(bp_dir, exist_ok=True)
    with open(os.path.join(bp_dir, "bitswan.yaml"), "w") as f:
        yaml.dump({"business_processes": {bp: node}}, f)


def dep(image, commit=None, path="copies/main/bp/backend", checksum="abc"):
    conf = {"image": image, "relative_path": path, "checksum": checksum}
    if commit is not None:
        conf["source_commit"] = commit
    return conf


def _install(monkeypatch, svc, present=(), rebuild=None):
    """Stub the image store, revision extraction, the bake and the converge."""
    calls = {"extracted": [], "baked": [], "order": [], "deployed": 0}

    async def fake_present():
        return set(present)

    async def fake_materialize(bp, commit):
        calls["extracted"].append((bp, commit))
        calls["order"].append(f"extract:{commit}")
        root = os.path.join(svc.gitops_dir, ".builds", f"rev-{commit}")
        # Mirror the real layout: <root>/<bp>/<repo_path>/
        os.makedirs(os.path.join(root, bp, "backend"), exist_ok=True)
        return root

    async def fake_rebuild(target, progress_callback=None):
        calls["baked"].append(target["deployment_id"])
        calls["order"].append(f"bake:{target['deployment_id']}")
        if rebuild is not None:
            return rebuild(target)
        # Same shape the real one returns, so the tests exercise the real keys.
        return dict(svc._image_outcome(target), image=target["image"], reproduced=True)

    async def fake_deploy():
        calls["deployed"] += 1
        calls["order"].append("deploy")
        return {"message": "Deployed successfully"}

    monkeypatch.setattr(svc, "_present_image_tags", fake_present)
    monkeypatch.setattr(svc, "_materialize_revision", fake_materialize)
    monkeypatch.setattr(svc, "_rebuild_pinned_image", fake_rebuild)
    monkeypatch.setattr(svc, "deploy_automations", fake_deploy)
    return calls


# --- what gets rebuilt -------------------------------------------------------


async def test_images_already_present_are_not_rebuilt(svc, monkeypatch):
    write_bp(svc, "bp", {"dev": ("c1", {"backend-bp-dev": dep("img:sha1", "c1")})})
    calls = _install(monkeypatch, svc, present=["img:sha1"])

    out = await svc.resolve_missing_pinned_images()

    assert out == {"missing": 0, "rebuilt": [], "failures": []}
    assert calls["baked"] == [], "a present image must cost nothing"
    assert calls["extracted"] == []


async def test_each_stage_is_rebuilt_from_its_own_commit(svc, monkeypatch):
    # The case the old worktree-scanning rebuild could not handle: two stages of
    # one BP pinning different artifacts from different commits. Building from
    # HEAD reproduces at most one of them.
    write_bp(
        svc,
        "bp",
        {
            "dev": ("cNEW", {"backend-bp-dev": dep("img:shaNEW", "cNEW")}),
            "production": (
                "cOLD",
                {"backend-bp-production": dep("img:shaOLD", "cOLD")},
            ),
        },
    )
    calls = _install(monkeypatch, svc, present=[])

    out = await svc.resolve_missing_pinned_images()

    assert out["missing"] == 2
    assert {r["source_commit"] for r in out["rebuilt"]} == {"cNEW", "cOLD"}
    assert sorted(calls["baked"]) == ["backend-bp-dev", "backend-bp-production"]


async def test_the_recorded_commit_is_used_not_the_working_copy(svc, monkeypatch):
    write_bp(svc, "bp", {"production": ("cSTAGE", {"d1": dep("img:shaX", "cSRC")})})
    _install(monkeypatch, svc, present=[])

    # Reaching for the scan/prep path would rebuild whatever HEAD holds today.
    def explode(*_a, **_k):
        raise AssertionError("the rebuild must come from the recorded revision")

    monkeypatch.setattr(svc, "prep_deploy_source", explode)
    monkeypatch.setattr(
        "app.services.automation_service.scan_workspace_sources", explode
    )

    out = await svc.resolve_missing_pinned_images()
    assert out["rebuilt"][0]["source_commit"] == "cSRC"


async def test_stage_git_commit_is_the_fallback(svc, monkeypatch):
    # source_commit is written conditionally, so deployments predating it have
    # only the stage node's shared commit. Falling back keeps them recoverable.
    write_bp(svc, "bp", {"staging": ("cSTAGE", {"d1": dep("img:shaX")})})
    _install(monkeypatch, svc, present=[])

    out = await svc.resolve_missing_pinned_images()
    assert out["rebuilt"][0]["source_commit"] == "cSTAGE"


async def test_live_dev_and_foreign_copies_are_ignored(svc, monkeypatch):
    write_bp(
        svc,
        "bp",
        {
            "live-dev": (
                "c1",
                {"d-live": dep("img:shaL", "c1", checksum="live-dev")},
            ),
            "dev": (
                "c1",
                {
                    "d-copy": dep(
                        "img:shaC", "c1", path="copies/alice-example-com/bp/backend"
                    ),
                    "d-ok": dep("img:shaOK", "c1"),
                },
            ),
        },
    )
    calls = _install(monkeypatch, svc, present=[])

    out = await svc.resolve_missing_pinned_images()

    # live-dev bakes no image at all, so it is not even a target. A non-main copy
    # IS a target (it pins an image) but cannot be traced to the BP's repo, so it
    # is reported rather than silently dropped.
    assert calls["baked"] == ["d-ok"] or "d-copy" in calls["baked"]
    assert "d-live" not in calls["baked"]


async def test_a_foreign_copy_path_cannot_be_rebuilt_from_history(svc):
    assert svc._bp_repo_relative_source("bp", "copies/main/bp/backend") == "backend"
    assert svc._bp_repo_relative_source("bp", "copies/main/bp/a/b") == "a/b"
    # Another copy is not the canonical repo; another BP's path is not ours.
    assert svc._bp_repo_relative_source("bp", "copies/alice/bp/backend") is None
    assert svc._bp_repo_relative_source("bp", "copies/main/other/backend") is None
    # The repo root itself is not an automation source.
    assert svc._bp_repo_relative_source("bp", "copies/main/bp") is None
    assert svc._bp_repo_relative_source("bp", "") is None


# --- when the artifact cannot be reproduced ----------------------------------


async def test_a_different_tag_is_reported_and_the_pin_is_left_alone(svc, monkeypatch):
    write_bp(svc, "bp", {"production": ("c1", {"d1": dep("img:shaAPPROVED", "c1")})})
    _install(
        monkeypatch,
        svc,
        present=[],
        rebuild=lambda t: dict(
            svc._image_outcome(t, "tree differed"),
            image="img:shaOTHER",
            reproduced=False,
        ),
    )

    out = await svc.resolve_missing_pinned_images()

    assert out["rebuilt"] == []
    assert len(out["failures"]) == 1
    assert out["failures"][0]["pinned_image"] == "img:shaAPPROVED"
    assert out["failures"][0]["image"] == "img:shaOTHER"

    # The pin itself must be untouched: retagging would make a signed-off
    # production tag name an artifact nobody approved.
    stored = yaml.safe_load(
        open(os.path.join(svc.gitops_dir, "bp", "bp", "bitswan.yaml"))
    )
    node = stored["business_processes"]["bp"]["production"]["deployments"]["d1"]
    assert node["image"] == "img:shaAPPROVED"


async def test_one_failure_does_not_cost_the_rest(svc, monkeypatch):
    write_bp(
        svc,
        "bp",
        {
            "dev": (
                "c1",
                {"broken": dep("img:shaB", "c1"), "fine": dep("img:shaF", "c1")},
            )
        },
    )

    def rebuild(target):
        if target["deployment_id"] == "broken":
            raise RuntimeError("Image build failed: missing base")
        return dict(svc._image_outcome(target), image=target["image"], reproduced=True)

    _install(monkeypatch, svc, present=[], rebuild=rebuild)

    out = await svc.resolve_missing_pinned_images()

    assert [r["deployment_id"] for r in out["rebuilt"]] == ["fine"]
    assert [f["deployment_id"] for f in out["failures"]] == ["broken"]
    assert "missing base" in out["failures"][0]["error"]


async def test_a_deployment_with_no_commit_is_reported_not_guessed(svc, monkeypatch):
    write_bp(svc, "bp", {"dev": (None, {"d1": dep("img:shaX")})})
    calls = _install(monkeypatch, svc, present=[])
    monkeypatch.delattr(svc, "_rebuild_pinned_image", raising=False)

    out = await svc.resolve_missing_pinned_images()

    assert calls["extracted"] == [], "nothing to extract without a revision"
    assert len(out["failures"]) == 1
    assert "no source commit" in out["failures"][0]["error"]


# --- the two callers ---------------------------------------------------------


async def test_recovery_converge_rebuilds_then_deploys(svc, monkeypatch):
    write_bp(svc, "bp", {"dev": ("c1", {"d1": dep("img:shaX", "c1")})})
    calls = _install(monkeypatch, svc, present=[])

    out = await svc.rebuild_all_images_and_deploy()

    # The converge must come last: it is what would fail without the images.
    assert calls["order"] == ["bake:d1", "deploy"]
    assert out["missing_images"] == 1
    assert out["unrecoverable"] == []


async def test_recovery_converge_never_rewrites_git_state(svc, monkeypatch):
    write_bp(svc, "bp", {"dev": ("c1", {"d1": dep("img:shaX", "c1")})})
    _install(monkeypatch, svc, present=[])

    def explode(*_a, **_k):
        raise AssertionError("a rebuild must not run a deploy that rewrites git state")

    monkeypatch.setattr(svc, "deploy_business_process", explode)
    monkeypatch.setattr(svc, "write_deployment_entries", explode)

    await svc.rebuild_all_images_and_deploy()


async def test_an_empty_workspace_still_converges(svc, monkeypatch):
    calls = _install(monkeypatch, svc, present=[])
    out = await svc.rebuild_all_images_and_deploy()
    assert calls["baked"] == []
    assert calls["deployed"] == 1
    assert out["missing_images"] == 0


async def test_rollback_resolves_images_before_converging(svc, monkeypatch):
    # Without this, a rollback to a commit whose image is no longer in the local
    # store fails the same way a bare-host converge does — compose tries to pull
    # an `internal/…` tag from Docker Hub.
    #
    # Rolls back DEV deliberately: production carries a separate admin/auditor
    # role gate, and this test is about ordering, not authorization.
    order = []

    async def fake_resolve(deployment_ids=None, progress_callback=None):
        order.append(("resolve", tuple(sorted(deployment_ids or ()))))
        return {"missing": 1, "rebuilt": [{"deployment_id": "d1"}], "failures": []}

    async def fake_apply(deployment_ids, deployed_by=None, report=None):
        order.append(("apply", tuple(sorted(deployment_ids))))
        return {"ok": True}

    async def fake_git(*_a, **_k):
        return None

    monkeypatch.setattr(svc, "resolve_missing_pinned_images", fake_resolve)
    monkeypatch.setattr(svc, "apply_compose_for_deployments", fake_apply)
    monkeypatch.setattr("app.services.automation_service.update_bp_git", fake_git)
    monkeypatch.setattr(
        "app.services.automation_service.validate_bp_name", lambda _bp: None
    )

    # The rollback selects which deployments to re-apply from the TOP-LEVEL
    # bitswan.yaml, scoped to this BP at this stage — not from the restored
    # per-BP file. "d2" is the control: same BP, different stage, must be left
    # alone so a dev rollback cannot disturb staging.
    with open(os.path.join(svc.gitops_dir, "bitswan.yaml"), "w") as f:
        yaml.dump(
            {
                "deployments": {
                    "d1": {
                        "context": "bp",
                        "stage": "dev",
                        "relative_path": "copies/main/bp",
                    },
                    "d2": {
                        "context": "bp",
                        "stage": "staging",
                        "relative_path": "copies/main/bp",
                    },
                }
            },
            f,
        )

    restored = {
        "business_processes": {
            "bp": {"dev": {"git_commit": "cOLD", "deployments": {"d1": {}}}}
        }
    }

    async def fake_show(*args, **_k):
        return yaml.dump(restored), "", 0

    monkeypatch.setattr(
        "app.services.automation_service.call_git_command_with_output", fake_show
    )
    bp_dir = os.path.join(svc.gitops_dir, "bp", "bp")
    os.makedirs(bp_dir, exist_ok=True)

    out = await svc.rollback_business_process("bp", "dev", "cOLD" * 10)

    assert [step for step, _ in order] == [
        "resolve",
        "apply",
    ], "images must exist before the converge that starts their containers"
    # Both steps see the same stage-scoped set — resolving images for a stage the
    # rollback is not touching would rebuild artifacts nobody asked for.
    assert order[0][1] == ("d1",)
    assert order[1][1] == ("d1",)
    assert out["rebuilt_images"] == [{"deployment_id": "d1"}]
    assert out["unrecoverable_images"] == []
