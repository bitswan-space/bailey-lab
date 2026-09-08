"""A release's audit record stops being editable when the release happens.

Sign-offs are keyed by image content hash, so re-freezing staging on an image
that is already in production used to reopen it for auditing: a new verdict
replaced the old one, and the production history row — which recomputed its
"audited by" badge from the current store — silently showed the new report as
the evidence for a release that had been approved on the old one.

Two things close that: a released image refuses further sign-offs, and the
commit that releases an image names the sign-offs it was released on.
"""

import pytest
import yaml
from fastapi import HTTPException

import app.services.automation_service as mod
from app.services.automation_service import AutomationService

REPORT = "# Audit — invoices\n\nRead the payment path; the threshold is a constant.\n"
LATER = "# Audit — invoices\n\nSecond look, months after the release.\n"


def _svc(tmp_path):
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    svc.secrets_dir = str(tmp_path / "secrets")
    svc.workspace_name = "finance"
    return svc


def _write(tmp_path, bs):
    (tmp_path / "bitswan.yaml").write_text(yaml.safe_dump(bs))


def _read(tmp_path):
    return yaml.safe_load((tmp_path / "bitswan.yaml").read_text())


@pytest.fixture()
def frozen(tmp_path, monkeypatch):
    monkeypatch.setattr(mod, "daemon_user_role", lambda by: "auditor")
    _write(
        tmp_path,
        {"staging_gate": {"invoices": {"frozen": True, "frozen_sha": "abc123"}}},
    )

    async def persisted(bs, bps, bp, kind, deployed_by=None, message=None):
        _write(tmp_path, bs)

    svc = _svc(tmp_path)
    monkeypatch.setattr(svc, "_persist_bp_state", persisted)
    monkeypatch.setattr(svc, "staging_content_sha", lambda bp: "abc123")
    return svc, tmp_path


async def test_a_released_image_refuses_further_signoffs(frozen):
    svc, tmp_path = frozen
    await svc.record_audit("invoices", "approve", by="auditor@x", report=REPORT)

    bs = _read(tmp_path)
    bs["staging_gate"]["invoices"]["released_shas"] = ["abc123"]
    _write(tmp_path, bs)

    with pytest.raises(HTTPException) as ei:
        await svc.record_audit("invoices", "reject", by="auditor@x", report=LATER)
    assert ei.value.status_code == 409
    assert "released" in ei.value.detail

    records = _read(tmp_path)["audits"]["invoices"]["abc123"]
    assert len(records) == 1
    assert "threshold is a constant" in records[0]["report"]


async def test_what_production_runs_counts_as_released_without_a_list(frozen):
    # Images released before promotions recorded them are still released: the
    # production stage says what it is running.
    svc, tmp_path = frozen
    bs = _read(tmp_path)
    bs["business_processes"] = {
        "invoices": {"production": {"deployments": {"api": {"checksum": "sha256:aa"}}}}
    }
    _write(tmp_path, bs)
    live = svc.deployed_content_sha("invoices", "production")
    bs["staging_gate"]["invoices"]["frozen_sha"] = live
    _write(tmp_path, bs)
    assert svc.audit_closed("invoices", live)

    svc.staging_content_sha = lambda bp: live
    with pytest.raises(HTTPException) as ei:
        await svc.record_audit("invoices", "approve", by="auditor@x", report=REPORT)
    assert ei.value.status_code == 409


async def test_an_unreleased_image_can_still_be_signed_again(frozen):
    # Changing your mind before the release is the whole point of the store
    # being append-only — closure applies to what has already gone out.
    svc, tmp_path = frozen
    await svc.record_audit("invoices", "reject", by="auditor@x", report=REPORT)
    await svc.record_audit("invoices", "approve", by="auditor@x", report=LATER)

    records = _read(tmp_path)["audits"]["invoices"]["abc123"]
    assert [r["verdict"] for r in records] == ["approve", "reject"]
    assert "Second look" in records[0]["report"]
    assert "threshold is a constant" in records[1]["report"]


async def test_the_gate_says_the_record_is_closed(frozen):
    svc, tmp_path = frozen
    assert svc.read_staging_gate("invoices")["released"] is False

    bs = _read(tmp_path)
    bs["staging_gate"]["invoices"]["released_shas"] = ["abc123"]
    _write(tmp_path, bs)
    assert svc.read_staging_gate("invoices")["released"] is True


async def test_a_release_records_the_signoffs_it_went_out_on(frozen):
    svc, tmp_path = frozen
    await svc.record_audit("invoices", "approve", by="auditor@x", report=REPORT)

    bs = _read(tmp_path)
    bs.setdefault("business_processes", {}).setdefault("invoices", {})["production"] = {
        "deployments": {"api": {"checksum": "sha256:aa"}}
    }
    _write(tmp_path, bs)
    released_sha = svc.deployed_content_sha("invoices", "production")
    # The audits are keyed by the image being released, whatever staging called
    # it: point the store at the released hash and promote.
    bs = _read(tmp_path)
    bs["audits"]["invoices"][released_sha] = bs["audits"]["invoices"].pop("abc123")
    _write(tmp_path, bs)

    await svc.write_bp_deploy(
        bp="invoices",
        stage="production",
        git_commit="deadbeef",
        members=[],
        deployed_by="admin@x",
        source="staging",
    )

    bs = _read(tmp_path)
    stamped = bs["business_processes"]["invoices"]["production"]["audit"]
    assert [e["who"] for e in stamped] == ["auditor@x"]
    assert stamped[0]["verdict"] == "approve"
    assert stamped[0]["id"] == bs["audits"]["invoices"][released_sha][0]["id"]
    # And the image is closed from here on, without anyone having to scan git.
    assert bs["staging_gate"]["invoices"]["released_shas"] == [released_sha]
    assert svc.audit_closed("invoices", released_sha)


def _git(*args, cwd):
    import os
    import subprocess

    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_COMMITTER_NAME="t")
    subprocess.run(["git", *args], cwd=cwd, env=env, check=True)


async def test_the_production_row_shows_the_report_the_release_went_out_on(
    tmp_path, monkeypatch
):
    """The badge on a release reads the sign-offs that release named.

    Both the sign-off store and the deployment record live in the business
    process's own bitswan.yaml, so this is one repo with two commits: the
    release, and a later verdict on the same image by the same auditor. What
    the release row shows must be the first one.
    """
    monkeypatch.delenv("BITSWAN_COPIES_DIR", raising=False)
    repo = tmp_path / "bp" / "invoices"
    repo.mkdir(parents=True)
    _git("init", "-q", cwd=str(repo))
    _git("config", "user.email", "t@t", cwd=str(repo))
    _git("config", "user.name", "t", cwd=str(repo))

    svc = _svc(tmp_path)
    released_sha = svc.content_sha(["sha256:aa"])
    signoff = {
        "id": "au1",
        "who": "auditor@x",
        "role": "auditor",
        "verdict": "approve",
        "at": "2026-09-01T10:00:00+00:00",
    }

    def commit(bs, message):
        _write(repo, bs)
        _git("add", "bitswan.yaml", cwd=str(repo))
        _git("commit", "-qm", message, cwd=str(repo))

    release = {
        "business_processes": {
            "invoices": {
                "production": {
                    "git_commit": "aaaaaaaa",
                    "deployments": {
                        "api": {"image": "img:aaaaaaaa", "checksum": "sha256:aa"}
                    },
                    "audit": [signoff],
                }
            }
        },
        "audits": {
            "invoices": {
                released_sha: [
                    {**signoff, "report": "What this release was approved on."}
                ]
            }
        },
    }
    commit(release, "promote business process invoices to production")

    second_look = yaml.safe_load(yaml.safe_dump(release))
    second_look["audits"]["invoices"][released_sha].insert(
        0,
        {
            "id": "au2",
            "who": "auditor@x",
            "role": "auditor",
            "verdict": "approve",
            "at": "2026-12-01T10:00:00+00:00",
            "report": "Second look, months after the release.",
        },
    )
    commit(second_look, "audit \u2014 auditor@x approved invoices image again")

    history = await svc.bp_history("invoices", "production")
    entry = history["history"][0]
    assert [a["who"] for a in entry["audit"]] == ["auditor@x"]
    assert entry["audit"][0]["report"] == "What this release was approved on."
    assert entry["audit"][0]["at"] == signoff["at"]
