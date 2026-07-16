"""Stale live-dev subpath mounts (#123): a live-dev container mounts its
source as a volume subpath, which docker pins to the directory INODE at
container start. When the copy/BP/automation dir is deleted + recreated at the
same path (copy re-materialization, git rebase/reset in the clone, an agent's
rm -rf + re-checkout), the running container keeps the old deleted inode —
"Up" and healthy-looking, but serving a blank page.

The fix: apply_compose_for_deployments records, per container, the source-dir
inode right after the compose apply (`.live-dev-src/` markers), and
wake_live_dev — fired on every BP load — compares markers against the dir's
current inode. A mismatch recycles the instance: remove its containers +
redeploy so the subpath re-resolves. A plain redeploy would NOT be enough
(unchanged compose config → docker compose leaves the running container
alone), which is also why recording never overwrites a surviving container's
recorded inode."""

import asyncio
import json
import os
import shutil

from app.services.automation_service import AutomationService


class _Container:
    def __init__(self, ctx, dep, created=100, state="running", stage="live-dev"):
        self.id = f"cid-{dep}"
        self.created = created
        self.state = state
        self.labels = {
            "gitops.context": ctx,
            "gitops.deployment_id": dep,
            "gitops.stage": stage,
            "gitops.workspace": "ws",
        }

    def to_docker_dict(self):
        return {"Id": self.id, "Labels": self.labels, "State": self.state}


class _FakeDriver:
    """Label-filtering fake of the infra-driver client (container primitives)."""

    def __init__(self, containers):
        self.containers = list(containers)
        self.removed: list[str] = []

    async def container_list(self, ctx, labels=None):
        out = []
        for c in self.containers:
            if labels and any(c.labels.get(k) != v for k, v in labels.items()):
                continue
            out.append(c)
        return out

    async def container_remove(self, ctx, cid):
        self.removed.append(cid)
        self.containers = [c for c in self.containers if c.id != cid]


def _svc(tmp_path, containers):
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path / "gitops")
    os.makedirs(svc.gitops_dir, exist_ok=True)
    svc.gitops_dir_host = svc.gitops_dir
    svc.secrets_dir = str(tmp_path / "secrets")
    svc.workspace_repo_dir = str(tmp_path / "workspace-repo")
    svc.workspace_name = "ws"
    svc._infra_driver = _FakeDriver(containers)
    os.environ["BITSWAN_MAX_LIVE_DEV"] = "15"
    return svc


REL = "copies/dev-user/shop/frontend"


def _mk_source_dir(svc) -> str:
    d = os.path.join(svc.workspace_repo_dir, REL)
    os.makedirs(d, exist_ok=True)
    return d


def _replace_dir(path: str) -> None:
    """Delete + recreate `path` guaranteeing a DIFFERENT inode (a bare
    rmdir+mkdir may reuse the inode number on some filesystems): create the
    replacement while the original still exists, then swap."""
    old_ino = os.stat(path).st_ino
    tmp = path + ".new"
    os.makedirs(tmp)
    shutil.rmtree(path)
    os.rename(tmp, path)
    assert os.stat(path).st_ino != old_ino, "test needs a genuinely new inode"


def _patch_yaml(monkeypatch, deployments: dict):
    import app.services.automation_service as mod

    def _read(path):
        return {"deployments": deployments}

    monkeypatch.setattr(mod, "read_bitswan_yaml", _read)


_DEP_CONF = {
    "context": "copy-dev-user-shop",
    "stage": "live-dev",
    "relative_path": REL,
    "active": True,
}


def test_record_then_wake_fresh_mount_is_touch_only(tmp_path, monkeypatch):
    # Recorded inode matches the dir on disk → wake must not disturb the
    # running instance (anti-flap: the dashboard fires wake on every BP load).
    conts = [_Container("copy-dev-user-shop", "fe-shop")]
    svc = _svc(tmp_path, conts)
    _mk_source_dir(svc)
    _patch_yaml(monkeypatch, {"fe-shop": dict(_DEP_CONF)})

    asyncio.run(svc.record_live_dev_source_inodes(["fe-shop"]))
    applied: list = []

    async def _apply(ids, deployed_by=None, report=None):
        applied.append(list(ids))

    monkeypatch.setattr(svc, "apply_compose_for_deployments", _apply)
    res = asyncio.run(svc.wake_live_dev("copy-dev-user-shop"))
    assert res.get("already_running") is True
    assert applied == [] and svc._infra_driver.removed == []


def test_wake_recycles_instance_with_stale_mount(tmp_path, monkeypatch):
    # The dir is replaced (new inode) under the running containers → wake must
    # remove ALL of the instance's containers and redeploy them.
    conts = [
        _Container("copy-dev-user-shop", "fe-shop"),
        _Container("copy-dev-user-shop", "be-shop"),
    ]
    svc = _svc(tmp_path, conts)
    src = _mk_source_dir(svc)
    _patch_yaml(
        monkeypatch,
        {
            "fe-shop": dict(_DEP_CONF),
            # the backend member has no source mount — never flagged itself,
            # but recycled along with its instance.
            "be-shop": {"context": "copy-dev-user-shop", "stage": "live-dev"},
        },
    )
    asyncio.run(svc.record_live_dev_source_inodes(["fe-shop", "be-shop"]))

    _replace_dir(src)

    applied: list = []

    async def _apply(ids, deployed_by=None, report=None):
        applied.append(sorted(ids))

    async def _cap():
        return {}

    monkeypatch.setattr(svc, "apply_compose_for_deployments", _apply)
    monkeypatch.setattr(svc, "enforce_live_dev_cap", _cap)

    res = asyncio.run(svc.wake_live_dev("copy-dev-user-shop"))
    assert res.get("recycled") == ["fe-shop"]  # the member that went stale
    assert sorted(res["deployment_ids"]) == ["be-shop", "fe-shop"]
    # BOTH members' containers removed (whole-instance recycle), then redeployed.
    assert sorted(svc._infra_driver.removed) == ["cid-be-shop", "cid-fe-shop"]
    assert applied == [["be-shop", "fe-shop"]]


def test_wake_without_marker_abstains(tmp_path, monkeypatch):
    # A running container we never recorded (e.g. it came up via a driver-side
    # reconcile) must NOT be recycled — detection abstains without evidence.
    conts = [_Container("copy-dev-user-shop", "fe-shop")]
    svc = _svc(tmp_path, conts)
    src = _mk_source_dir(svc)
    _patch_yaml(monkeypatch, {"fe-shop": dict(_DEP_CONF)})
    _replace_dir(src)  # even though the dir was replaced

    res = asyncio.run(svc.wake_live_dev("copy-dev-user-shop"))
    assert res.get("already_running") is True
    assert svc._infra_driver.removed == []


def test_wake_with_missing_source_dir_abstains(tmp_path, monkeypatch):
    # Source dir gone entirely: recycling can't produce a working mount, so the
    # instance is left alone (redeploy would fail anyway).
    conts = [_Container("copy-dev-user-shop", "fe-shop")]
    svc = _svc(tmp_path, conts)
    src = _mk_source_dir(svc)
    _patch_yaml(monkeypatch, {"fe-shop": dict(_DEP_CONF)})
    asyncio.run(svc.record_live_dev_source_inodes(["fe-shop"]))
    shutil.rmtree(src)

    res = asyncio.run(svc.wake_live_dev("copy-dev-user-shop"))
    assert res.get("already_running") is True
    assert svc._infra_driver.removed == []


def test_recording_never_overwrites_surviving_container(tmp_path, monkeypatch):
    # THE papering-over guard: `docker compose up` with unchanged config leaves
    # a running container alone, so a re-record after the dir was replaced must
    # keep the container's ORIGINAL inode (what it actually mounted at start) —
    # otherwise the very apply that failed to recreate it would erase the
    # evidence and the wake path could never flag it.
    conts = [_Container("copy-dev-user-shop", "fe-shop")]
    svc = _svc(tmp_path, conts)
    src = _mk_source_dir(svc)
    _patch_yaml(monkeypatch, {"fe-shop": dict(_DEP_CONF)})

    asyncio.run(svc.record_live_dev_source_inodes(["fe-shop"]))
    first = svc._read_live_dev_src_markers("fe-shop")["cid-fe-shop"]

    _replace_dir(src)
    asyncio.run(svc.record_live_dev_source_inodes(["fe-shop"]))  # same container id
    assert svc._read_live_dev_src_markers("fe-shop")["cid-fe-shop"] == first

    assert asyncio.run(svc._stale_live_dev_members(["fe-shop"])) == ["fe-shop"]


def test_recording_drops_vanished_and_adds_new_containers(tmp_path, monkeypatch):
    # After a recycle the container id changes: the new id gets the current
    # inode and the old id's marker is dropped.
    conts = [_Container("copy-dev-user-shop", "fe-shop")]
    svc = _svc(tmp_path, conts)
    src = _mk_source_dir(svc)
    _patch_yaml(monkeypatch, {"fe-shop": dict(_DEP_CONF)})
    asyncio.run(svc.record_live_dev_source_inodes(["fe-shop"]))

    _replace_dir(src)
    # simulate recreate: same deployment, new container id
    svc._infra_driver.containers = [_Container("copy-dev-user-shop", "fe-shop")]
    svc._infra_driver.containers[0].id = "cid-fe-shop-2"
    asyncio.run(svc.record_live_dev_source_inodes(["fe-shop"]))

    markers = svc._read_live_dev_src_markers("fe-shop")
    assert list(markers) == ["cid-fe-shop-2"]
    assert markers["cid-fe-shop-2"] == os.stat(src).st_ino
    assert asyncio.run(svc._stale_live_dev_members(["fe-shop"])) == []


def test_corrupt_marker_is_treated_as_absent(tmp_path, monkeypatch):
    conts = [_Container("copy-dev-user-shop", "fe-shop")]
    svc = _svc(tmp_path, conts)
    src = _mk_source_dir(svc)
    _patch_yaml(monkeypatch, {"fe-shop": dict(_DEP_CONF)})
    os.makedirs(svc._live_dev_src_dir(), exist_ok=True)
    with open(os.path.join(svc._live_dev_src_dir(), "fe-shop"), "w") as f:
        f.write("not json {")
    _replace_dir(src)
    assert asyncio.run(svc._stale_live_dev_members(["fe-shop"])) == []


def test_apply_compose_records_markers(tmp_path, monkeypatch):
    # Wiring: apply_compose_for_deployments must record the inode markers after
    # the driver apply, so every deploy/wake that can create containers pins
    # what they mounted.
    conts = [_Container("copy-dev-user-shop", "fe-shop")]
    svc = _svc(tmp_path, conts)
    src = _mk_source_dir(svc)
    _patch_yaml(monkeypatch, {"fe-shop": dict(_DEP_CONF)})

    async def _ensure_repo(bp):
        pass

    async def _deploy(**kwargs):
        pass

    async def _refresh_all():
        pass

    svc._infra_driver.ensure_deploy_repo = _ensure_repo
    svc._infra_driver.deploy = _deploy
    svc._infra_driver.deploy_remote_for_bp = lambda bp: "remote"
    monkeypatch.setattr(svc, "refresh_all", _refresh_all)

    asyncio.run(svc.apply_compose_for_deployments(["fe-shop"]))
    marker_path = os.path.join(svc._live_dev_src_dir(), "fe-shop")
    assert os.path.isfile(marker_path)
    with open(marker_path) as f:
        assert json.load(f) == {"cid-fe-shop": os.stat(src).st_ino}
