"""DELETE /automations/{deployment_id} correctness.

The dashboard historically sent the SHORT automation name (`diag-worker`)
instead of the full deployment_id (`diag-worker-copy-<copy>-<bp>-<stage>`).
That matched neither the bitswan.yaml key nor the gitops.deployment_id
container label, so the handler removed nothing — and still returned
success, leaving the container running (issue found via #53).

delete_automation must resolve short names through the entries'
automation_name, 409 on ambiguity, and 404 when nothing matches at all.
"""

import asyncio

import pytest
import yaml
from fastapi import HTTPException

from app.services.automation_service import AutomationService

FULL_ID = "diag-worker-copy-alice-letsgo-live-dev"
SHORT = "diag-worker"


class _Container:
    def __init__(self, deployment_id):
        self.id = f"cid-{deployment_id}"
        self.labels = {
            "gitops.deployment_id": deployment_id,
            "gitops.workspace": "ws",
        }
        self.state = "running"

    def to_docker_dict(self):
        return {"Id": self.id, "Labels": self.labels, "State": self.state}


class _FakeDriver:
    """Filters container_list by exact label match — like the real driver, so
    a short-name lookup genuinely matches zero containers."""

    def __init__(self, containers):
        self.containers = containers
        self.stopped: list[str] = []

    async def container_list(self, ctx, labels=None):
        out = []
        for c in self.containers:
            if all(c.labels.get(k) == v for k, v in (labels or {}).items()):
                out.append(c)
        return out

    async def container_stop(self, ctx, cid):
        self.stopped.append(cid)


def _svc(tmp_path, monkeypatch, deployments, containers):
    (tmp_path / "bitswan.yaml").write_text(yaml.safe_dump({"deployments": deployments}))
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    svc.secrets_dir = str(tmp_path / "secrets")
    svc.workspace_name = "ws"
    svc._infra_driver = _FakeDriver(containers)

    persisted: list[str] = []

    async def _persist(bs_yaml, bps, deployment_id, action):
        persisted.append(deployment_id)

    monkeypatch.setattr(svc, "_persist_bp_state", _persist)
    return svc, persisted


_ENTRY = {
    "automation_name": SHORT,
    "context": "copy-alice-letsgo",
    "relative_path": f"copies/alice/letsgo/{SHORT}",
    "stage": "live-dev",
}


def test_short_name_resolves_to_full_deployment_id(tmp_path, monkeypatch):
    svc, persisted = _svc(
        tmp_path, monkeypatch, {FULL_ID: dict(_ENTRY)}, [_Container(FULL_ID)]
    )
    res = asyncio.run(svc.delete_automation(SHORT))
    assert res["status"] == "success"
    assert FULL_ID in res["message"]
    assert persisted == [FULL_ID]  # bitswan.yaml entry dropped under the FULL id
    assert svc._infra_driver.stopped == [f"cid-{FULL_ID}"]  # container stopped


def test_full_deployment_id_still_works(tmp_path, monkeypatch):
    svc, persisted = _svc(
        tmp_path, monkeypatch, {FULL_ID: dict(_ENTRY)}, [_Container(FULL_ID)]
    )
    res = asyncio.run(svc.delete_automation(FULL_ID))
    assert res["status"] == "success"
    assert persisted == [FULL_ID]
    assert svc._infra_driver.stopped == [f"cid-{FULL_ID}"]


def test_unknown_id_is_404_not_silent_success(tmp_path, monkeypatch):
    svc, persisted = _svc(
        tmp_path, monkeypatch, {FULL_ID: dict(_ENTRY)}, [_Container(FULL_ID)]
    )
    with pytest.raises(HTTPException) as exc:
        asyncio.run(svc.delete_automation("no-such-thing"))
    assert exc.value.status_code == 404
    assert persisted == []  # nothing touched
    assert svc._infra_driver.stopped == []


def test_ambiguous_short_name_is_409(tmp_path, monkeypatch):
    other = "diag-worker-copy-bob-letsgo-live-dev"
    deployments = {
        FULL_ID: dict(_ENTRY),
        other: {**_ENTRY, "context": "copy-bob-letsgo"},
    }
    svc, persisted = _svc(
        tmp_path,
        monkeypatch,
        deployments,
        [_Container(FULL_ID), _Container(other)],
    )
    with pytest.raises(HTTPException) as exc:
        asyncio.run(svc.delete_automation(SHORT))
    assert exc.value.status_code == 409
    assert persisted == []
    assert svc._infra_driver.stopped == []


def test_remove_source_deletes_the_bp_directory(tmp_path, monkeypatch):
    # remove_source=True (the Environment panel's delete) must also delete
    # copies/<scope>/<bp>/<name>/ so a later whole-BP deploy can't resurrect
    # the worker from its surviving source directory.
    copies = tmp_path / "copies"
    src_dir = copies / "alice" / "letsgo" / SHORT
    src_dir.mkdir(parents=True)
    (src_dir / "automation.toml").write_text("id = 'x'\n")
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(copies))

    svc, persisted = _svc(
        tmp_path, monkeypatch, {FULL_ID: dict(_ENTRY)}, [_Container(FULL_ID)]
    )
    svc.workspace_repo_dir = str(tmp_path)

    res = asyncio.run(svc.delete_automation(SHORT, remove_source=True))
    assert res["status"] == "success"
    assert res["source_removed"] is True
    assert persisted == [FULL_ID]
    assert not src_dir.exists()


def test_without_remove_source_the_directory_survives(tmp_path, monkeypatch):
    # Deployments-tab semantics: plain delete keeps the source on disk.
    copies = tmp_path / "copies"
    src_dir = copies / "alice" / "letsgo" / SHORT
    src_dir.mkdir(parents=True)
    (src_dir / "automation.toml").write_text("id = 'x'\n")
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(copies))

    svc, _ = _svc(tmp_path, monkeypatch, {FULL_ID: dict(_ENTRY)}, [_Container(FULL_ID)])
    svc.workspace_repo_dir = str(tmp_path)

    res = asyncio.run(svc.delete_automation(SHORT))
    assert res["status"] == "success"
    assert res["source_removed"] is False
    assert src_dir.exists()


def test_remove_source_is_idempotent_when_dir_already_gone(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(tmp_path / "copies"))
    svc, persisted = _svc(
        tmp_path, monkeypatch, {FULL_ID: dict(_ENTRY)}, [_Container(FULL_ID)]
    )
    svc.workspace_repo_dir = str(tmp_path)

    res = asyncio.run(svc.delete_automation(SHORT, remove_source=True))
    assert res["status"] == "success"
    assert res["source_removed"] is False  # nothing on disk, delete still ok
    assert persisted == [FULL_ID]


def test_container_only_orphan_is_still_deletable(tmp_path, monkeypatch):
    # Entry already gone from bitswan.yaml but the container is still up
    # (e.g. a previously half-completed delete): the full id must still
    # stop the container rather than 404.
    svc, persisted = _svc(tmp_path, monkeypatch, {}, [_Container(FULL_ID)])
    res = asyncio.run(svc.delete_automation(FULL_ID))
    assert res["status"] == "success"
    assert svc._infra_driver.stopped == [f"cid-{FULL_ID}"]
