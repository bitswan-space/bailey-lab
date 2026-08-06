"""Off-site snapshot access after the backup move: gitops no longer keeps its
own restic repo/index. Pruned snapshots are listed and fetched back through
the automation-server daemon's socket, authenticated with this workspace's own
gitops secret (the socket is mounted into every workspace, so being a peer
proves nothing)."""

import asyncio

import httpx
import pytest

from app import utils


class _FakeResponse:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}", request=None, response=None
            )


class _FakeClient:
    """Records the calls gitops makes to the daemon socket."""

    def __init__(self, get_payload=None, post_status=200):
        self.get_payload = get_payload if get_payload is not None else {"snapshots": []}
        self.post_status = post_status
        self.gets = []
        self.posts = []
        self.closed = False

    def get(self, url, params=None, headers=None, **kwargs):
        self.gets.append({"url": url, "params": params, "headers": headers})
        return _FakeResponse(self.get_payload)

    def post(self, url, json=None, headers=None, **kwargs):
        self.posts.append({"url": url, "json": json, "headers": headers})
        return _FakeResponse({}, status=self.post_status)

    def close(self):
        self.closed = True


@pytest.fixture
def daemon(monkeypatch):
    """Patch the daemon transport seam and the workspace identity env."""
    monkeypatch.setenv("BITSWAN_WORKSPACE_NAME", "tenant-a")
    monkeypatch.setenv("BITSWAN_GITOPS_SECRET", "ws-secret-a")

    client = _FakeClient()

    def _seam():
        return client, "http://daemon"

    monkeypatch.setattr(utils, "_ingress_client_and_base", _seam)
    return client


def test_list_offsite_snapshots_sends_workspace_proof(daemon):
    daemon.get_payload = {
        "snapshots": [
            {
                "snapshot_id": "snap-1",
                "restic_snapshot": "abc",
                "backed_up_at": "2026-07-28T02:00:00Z",
            },
        ]
    }
    refs = utils.daemon_list_offsite_snapshots("bp1", "production")

    assert [r["snapshot_id"] for r in refs] == ["snap-1"]
    call = daemon.gets[0]
    assert call["url"].endswith("/backup/offsite-snapshots")
    assert call["params"] == {
        "workspace": "tenant-a",
        "bp": "bp1",
        "stage": "production",
    }
    # The workspace's own secret is what distinguishes us from a sibling.
    assert call["headers"]["X-Bitswan-Workspace-Secret"] == "ws-secret-a"
    assert daemon.closed


def test_list_offsite_snapshots_swallows_transport_errors(monkeypatch, daemon):
    def _raise(*a, **kw):
        raise httpx.ConnectError("connection refused")

    daemon.get = _raise
    assert utils.daemon_list_offsite_snapshots("bp1", "production") == []
    assert daemon.closed


def test_fetch_offsite_snapshot_posts_identity(daemon):
    utils.daemon_fetch_offsite_snapshot("bp1", "production", "snap-1")

    call = daemon.posts[0]
    assert call["url"].endswith("/backup/fetch-snapshot")
    assert call["json"] == {
        "workspace": "tenant-a",
        "bp": "bp1",
        "stage": "production",
        "snapshot_id": "snap-1",
    }
    assert call["headers"]["X-Bitswan-Workspace-Secret"] == "ws-secret-a"
    assert daemon.closed


def test_fetch_offsite_snapshot_raises_on_failure(daemon):
    """A failed fetch must raise: callers run it BEFORE anything destructive,
    so a dead daemon has to abort the restore rather than proceed."""
    daemon.post_status = 500
    with pytest.raises(httpx.HTTPStatusError):
        utils.daemon_fetch_offsite_snapshot("bp1", "production", "snap-1")
    assert daemon.closed


def test_restore_of_a_pruned_snapshot_aborts_when_not_in_backups(monkeypatch, daemon):
    """spawn_restore_snapshot must 404 (LookupError) for a snapshot that is
    neither local nor in the server's backups — before any task is created."""
    from app import snapshot_runner
    from app.services import snapshot_service

    class _NoLocalSnapshots:
        def get_snapshot(self, *a, **kw):
            raise LookupError("gone")

    monkeypatch.setattr(
        snapshot_service, "get_snapshot_service", lambda: _NoLocalSnapshots()
    )
    daemon.get_payload = {"snapshots": []}  # not in the backups either

    with pytest.raises(LookupError):
        asyncio.run(
            snapshot_runner.spawn_restore_snapshot(
                "bp1", "snap-gone", "production", "dev"
            )
        )
