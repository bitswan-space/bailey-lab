"""Tests for the Inspect-modal backend: bp_files (git-backed source browse at a
commit), scale_business_process (scale all of a BP stage's members) and the
inspect payload shape the Overview panel renders. The bundle (docker save +
pg_dump) is exercised live."""

import asyncio
import os
import subprocess
import types

from app.utils import dump_bitswan_yaml
from app.services import automation_service as asvc
from app.services.automation_service import (
    AutomationService,
    SECRET_MASK,
    _project_inspect,
)


def _git(*args, cwd):
    env = dict(
        os.environ,
        GIT_AUTHOR_NAME="t",
        GIT_AUTHOR_EMAIL="t@t",
        GIT_COMMITTER_NAME="t",
        GIT_COMMITTER_EMAIL="t@t",
    )
    return subprocess.run(
        ["git", *args], cwd=cwd, env=env, check=True, capture_output=True, text=True
    )


def _setup_bp_repo(tmp_path, monkeypatch, bp="shop"):
    """Build the per-BP layout the Inspect backend now expects: a bare repo at
    BITSWAN_GIT_REPOS_DIR/<bp>.git and its clone at copies/main/<bp> (copies/main
    itself is NOT a repo anymore). Returns the clone path."""
    repos = tmp_path / "git"
    copies = tmp_path / "copies"
    repos.mkdir(parents=True, exist_ok=True)
    (copies / "main").mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("BITSWAN_GIT_REPOS_DIR", str(repos))
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(copies))
    bare = repos / f"{bp}.git"
    _git("init", "-q", "--bare", "--initial-branch=main", str(bare), cwd=str(tmp_path))
    clone = copies / "main" / bp
    _git("clone", "-q", str(bare), str(clone), cwd=str(tmp_path))
    _git("config", "user.email", "t@t", cwd=str(clone))
    _git("config", "user.name", "t", cwd=str(clone))
    return clone


def _commit_push(clone, message):
    _git("add", "-A", cwd=str(clone))
    _git("commit", "-qm", message, cwd=str(clone))
    # main is deploy-only on a real bare (pre-receive hook), but this test bare
    # has no hook — push straight to main so fetch_main can see the commit.
    _git("push", "-q", "origin", "HEAD:refs/heads/main", cwd=str(clone))
    return _git("rev-parse", "HEAD", cwd=str(clone)).stdout.strip()


def test_bp_files_list_and_read(tmp_path, monkeypatch):
    clone = _setup_bp_repo(tmp_path, monkeypatch)
    (clone / "backend").mkdir(parents=True)
    (clone / "README.md").write_text("# shop\n")
    (clone / "backend" / "main.go").write_text("package main\n")
    sha = _commit_push(clone, "c1")

    svc = AutomationService()

    # Full recursive tree of the BP, nested folders-before-files. Paths are
    # BP-relative (the clone IS the BP repo — no bp/ prefix).
    tree = asyncio.run(svc.bp_file_tree("shop", sha))
    entries = tree["entries"]
    names = {e["name"]: e["kind"] for e in entries}
    assert names == {"backend": "folder", "README.md": "file"}
    backend = next(e for e in entries if e["name"] == "backend")
    assert backend["children"][0]["name"] == "main.go"
    assert backend["children"][0]["path"] == "backend/main.go"

    # Reading a file at the deployed commit.
    f = asyncio.run(svc.bp_file_content("shop", sha, "README.md"))
    assert f["content"] == "# shop\n" and f["truncated"] is False

    # A nested file resolves too.
    g = asyncio.run(svc.bp_file_content("shop", sha, "backend/main.go"))
    assert g["content"] == "package main\n"


def test_bp_diff_between_two_deploys(tmp_path, monkeypatch):
    """Inspect → "Diff vs current": diffing a prior deploy's source commit
    against the current one must surface the change (the e2e history chapter).
    Regression guard for the per-BP layout — the diff runs inside the BP's own
    clone in copies/main, not the (now non-repo) copies/main root."""
    clone = _setup_bp_repo(tmp_path, monkeypatch)
    (clone / "README.md").write_text("# shop v1\n")
    v1 = _commit_push(clone, "v1")
    (clone / "README.md").write_text("# shop v1\n\nManager approval tier (v2)\n")
    v2 = _commit_push(clone, "v2")

    svc = AutomationService()
    res = asyncio.run(svc.bp_diff("shop", v1, v2))
    assert "Manager approval tier (v2)" in res["diff"], res
    assert res["from"] == v1 and res["to"] == v2

    # A no-op diff (same commit) is genuinely empty, not an error.
    same = asyncio.run(svc.bp_diff("shop", v2, v2))
    assert same["diff"] == ""


def test_scale_business_process_scales_all_members(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    bs = {
        "deployments": {
            "backend-shop-dev": {
                "stage": "dev",
                "context": "shop",
                "image_id": "sha256:a",
            },
            "frontend-shop-dev": {
                "stage": "dev",
                "context": "shop",
                "image_id": "sha256:b",
            },
        }
    }
    with open(tmp_path / "bitswan.yaml", "w") as f:
        dump_bitswan_yaml(bs, f)

    calls = []

    async def _fake_scale(self, deployment_id, replicas):
        calls.append((deployment_id, replicas))
        return {"status": "success", "replicas": replicas}

    monkeypatch.setattr(asvc.AutomationService, "scale_automation", _fake_scale)

    res = asyncio.run(svc.scale_business_process("shop", "dev", 3))
    assert res["replicas"] == 3
    assert set(res["members"]) == {"backend-shop-dev", "frontend-shop-dev"}
    assert sorted(calls) == [("backend-shop-dev", 3), ("frontend-shop-dev", 3)]


# --- the Overview panel's payload shape (#265) -----------------------------

# A realistic `docker inspect` record for a live-dev frontend container, trimmed
# to the keys the projection reads plus a couple it must NOT forward.
_RAW_INSPECT = {
    "Id": "56e6dff3a7de1f2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071829304",
    "Created": "2026-07-30T14:53:59.123456789Z",
    "Name": "/frontend-copy-admin-timssandbox2-bswn-io-bp-bookmaker-live-dev",
    "RestartCount": 0,
    "Image": "sha256:aaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999",
    "State": {
        "Status": "running",
        "Running": True,
        "Paused": False,
        "Pid": 41234,
        "Health": {"Status": "healthy", "FailingStreak": 0, "Log": [{"Output": "ok"}]},
    },
    "Config": {
        "Hostname": "56e6dff3a7de",
        "Image": "internal/horror-bookmaker-frontend:sha244750a6479",
        "Labels": {
            "gitops.deployment_id": "frontend-bookmaker-live-dev",
            "gitops.workspace": "horror",
        },
        # MUST NOT reach the client unmasked — the whole point of the allow-list.
        "Env": ["API_KEY=supersecret", "BITSWAN_AUTOMATION_STAGE=live-dev"],
        "Healthcheck": {
            "Test": ["CMD-SHELL", "curl -f localhost:3000"],
            "Interval": 30000000000,
        },
    },
    "HostConfig": {
        "NanoCpus": 2000000000,
        "Memory": 536870912,
        "NetworkMode": "horror-net",
    },
    "NetworkSettings": {
        "Ports": {
            "3000/tcp": [{"HostIp": "0.0.0.0", "HostPort": "32770"}],
            "9000/tcp": None,
        },
        "Networks": {
            "horror-net": {
                "IPAddress": "172.19.0.7",
                "MacAddress": "02:42:ac:13:00:07",
                "NetworkID": "abc123",
            }
        },
    },
    "Mounts": [
        {
            "Type": "bind",
            "Source": "/opt/bitswan/copies/main/bookmaker",
            "Destination": "/src",
            "Mode": "ro",
            "RW": False,
        }
    ],
}

# What `Container.to_docker_dict()` produces — the flat `/containers/json` LIST
# shape that inspect_automation used to return, leaving the panel blank.
_LIST_DICT = {
    "Id": _RAW_INSPECT["Id"],
    "Names": ["/frontend-bookmaker-live-dev"],
    "State": "running",
    "Status": "healthy",
    "Created": 1785000839,
    "Image": "internal/horror-bookmaker-frontend:sha244750a6479",
    "Labels": {"gitops.deployment_id": "frontend-bookmaker-live-dev"},
}


def test_project_inspect_keeps_the_nested_fields_the_panel_renders():
    p = _project_inspect(_RAW_INSPECT)

    assert (
        p["Name"] == "/frontend-copy-admin-timssandbox2-bswn-io-bp-bookmaker-live-dev"
    )
    assert p["State"]["Status"] == "running"
    assert p["State"]["Running"] is True
    assert p["State"]["Pid"] == 41234
    assert p["State"]["Health"] == {"Status": "healthy", "FailingStreak": 0}
    assert p["Config"]["Hostname"] == "56e6dff3a7de"
    assert p["Config"]["Image"] == "internal/horror-bookmaker-frontend:sha244750a6479"
    assert p["Config"]["Labels"]["gitops.workspace"] == "horror"
    assert p["Config"]["Healthcheck"]["Interval"] == 30000000000
    assert p["HostConfig"] == {
        "NanoCpus": 2000000000,
        "Memory": 536870912,
        "NetworkMode": "horror-net",
    }
    assert p["NetworkSettings"]["Networks"] == {
        "horror-net": {"IPAddress": "172.19.0.7"}
    }
    # A published port keeps its host binding; an exposed-but-unpublished port
    # normalizes from null to [] so the UI can tell it from a missing field.
    assert p["NetworkSettings"]["Ports"] == {
        "3000/tcp": [{"HostIp": "0.0.0.0", "HostPort": "32770"}],
        "9000/tcp": [],
    }
    assert p["Mounts"] == [
        {
            "Type": "bind",
            "Source": "/opt/bitswan/copies/main/bookmaker",
            "Destination": "/src",
            "Mode": "ro",
            "RW": False,
        }
    ]
    # `Created` stays docker's RFC3339 string — NOT coerced to a number, which is
    # what rendered every timestamp as January 1970.
    assert p["Created"] == "2026-07-30T14:53:59.123456789Z"


def test_project_inspect_is_an_allow_list_and_drops_raw_env():
    p = _project_inspect(_RAW_INSPECT)
    # The unmasked `Config.Env` must never be forwarded; masked rows are attached
    # separately by inspect_automation as a top-level `Env`.
    assert "Env" not in p["Config"]
    assert "Log" not in p["State"]["Health"]
    assert "MacAddress" not in p["NetworkSettings"]["Networks"]["horror-net"]


def test_project_inspect_tolerates_an_empty_record():
    p = _project_inspect({})
    assert p["Id"] is None
    assert p["State"] == {"Status": None, "Running": None, "Pid": None}
    assert p["Config"]["Labels"] == {}
    assert p["Mounts"] == []
    assert "Health" not in p["State"]


def _inspect_stub(containers, inspect_result=None, boom=False):
    """A minimal `self` for AutomationService.inspect_automation."""

    async def get_container(_deployment_id):
        return containers

    async def container_inspect(_ctx, _cid):
        if boom:
            raise RuntimeError("driver unreachable")
        return inspect_result

    return types.SimpleNamespace(
        get_container=get_container,
        infra_driver=types.SimpleNamespace(container_inspect=container_inspect),
        _workspace_ctx=lambda: None,
        _env_secret_visibility=lambda _dep, _by: ({"API_KEY"}, False),
    )


def _inspect(stub, deployment_id="frontend-bookmaker-live-dev", by=None):
    return asyncio.run(AutomationService.inspect_automation(stub, deployment_id, by=by))


def test_inspect_automation_returns_the_inspect_shape_not_the_list_shape():
    """The regression this fixes: the endpoint used to return the flat container
    LIST dict, so the panel's Name/Status/Network/IP/Ports/Hostname/PID reads
    (all nested) resolved to nothing."""
    rows = _inspect(_inspect_stub([dict(_LIST_DICT)], inspect_result=_RAW_INSPECT))

    assert len(rows) == 1
    row = rows[0]
    # Nested, docker-shaped — not `Names`/`State: "running"`.
    assert "Names" not in row
    assert row["Name"].lstrip("/").startswith("frontend-")
    assert row["State"]["Status"] == "running"
    assert row["State"]["Pid"] == 41234
    assert row["NetworkSettings"]["Networks"]["horror-net"]["IPAddress"] == "172.19.0.7"
    assert row["Config"]["Hostname"] == "56e6dff3a7de"
    assert row["HostConfig"]["Memory"] == 536870912
    assert row["Mounts"][0]["Destination"] == "/src"
    assert isinstance(row["Created"], str)

    # Env still arrives masked, exactly as before.
    by_name = {e["name"]: e for e in row["Env"]}
    assert by_name["API_KEY"]["value"] == SECRET_MASK
    assert by_name["API_KEY"]["masked"] is True
    assert by_name["BITSWAN_AUTOMATION_STAGE"]["value"] == "live-dev"


def test_inspect_automation_keeps_list_labels_when_inspect_reports_none():
    raw = {**_RAW_INSPECT, "Config": {**_RAW_INSPECT["Config"], "Labels": {}}}
    rows = _inspect(_inspect_stub([dict(_LIST_DICT)], inspect_result=raw))
    assert rows[0]["Config"]["Labels"] == _LIST_DICT["Labels"]


def test_inspect_automation_degrades_to_the_list_record_when_inspect_fails():
    """A container we can't inspect must still be listed (the UI marks the
    fields it couldn't read as unavailable) — not dropped."""
    rows = _inspect(_inspect_stub([dict(_LIST_DICT)], boom=True))
    assert len(rows) == 1
    assert rows[0]["Names"] == _LIST_DICT["Names"]
    assert "Env" not in rows[0]


def test_inspect_automation_degrades_when_the_container_vanished():
    rows = _inspect(_inspect_stub([dict(_LIST_DICT)], inspect_result={}))
    assert rows == [_LIST_DICT]
