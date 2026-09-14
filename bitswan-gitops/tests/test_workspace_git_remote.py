import asyncio
import os
import stat

import pytest

from app.services import workspace_git_remote as remote


def _mode(path):
    return stat.S_IMODE(os.stat(path).st_mode)


def test_keypair_is_generated_lazily_with_private_modes_and_is_stable(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_WORKSPACE_NAME", "finance")
    secrets = str(tmp_path / "secrets")
    public = asyncio.run(remote.ensure_keypair(secrets))
    assert public.startswith("ssh-ed25519 ")
    assert public.endswith("bitswan-gitops-finance")
    assert _mode(remote.remote_dir(secrets)) == 0o700
    assert _mode(remote.private_key_path(secrets)) == 0o600
    assert asyncio.run(remote.key_fingerprint(secrets)).startswith("SHA256:")
    assert asyncio.run(remote.ensure_keypair(secrets)) == public


@pytest.mark.parametrize(
    "url",
    [
        "git@github.com:acme/workspace.git",
        "ssh://git@host.example:2222/acme/workspace.git",
        "ssh://forgejo.example/acme/workspace",
    ],
)
def test_ssh_remote_urls_are_accepted(url):
    assert remote.validate_remote_url(f"  {url}  ") == url


@pytest.mark.parametrize(
    "url",
    [
        "https://github.com/acme/workspace.git",
        "http://gitlab.example/acme/workspace.git",
        "-oProxyCommand=touch /tmp/pwned",
        "git@github.com:acme/with space.git",
        "",
        "not a url",
    ],
)
def test_non_ssh_remote_urls_are_rejected(url):
    with pytest.raises(remote.RemoteUrlError):
        remote.validate_remote_url(url)


def test_https_rejection_explains_ssh_only():
    with pytest.raises(remote.RemoteUrlError, match="Only SSH remotes"):
        remote.validate_remote_url("https://github.com/acme/workspace.git")


def test_local_remotes_need_the_opt_in(monkeypatch):
    monkeypatch.setattr(remote, "ALLOW_LOCAL_REMOTES", False)
    with pytest.raises(remote.RemoteUrlError):
        remote.validate_remote_url("file:///srv/git/workspace.git")
    monkeypatch.setattr(remote, "ALLOW_LOCAL_REMOTES", True)
    assert remote.validate_remote_url("file:///srv/git/workspace.git")
    assert remote.validate_remote_url("/srv/git/workspace.git")


def test_remote_host_is_extracted_for_task_labels():
    assert remote.remote_host("git@github.com:acme/workspace.git") == "github.com"
    assert remote.remote_host("ssh://git@host.example:2222/acme/x.git") == "host.example"
    assert remote.remote_host("file:///srv/git/x.git") == "local"


def test_config_and_status_round_trip_as_private_files(tmp_path):
    secrets = str(tmp_path / "secrets")
    assert remote.load_config(secrets)["url"] is None
    saved = remote.save_config(secrets, "git@github.com:acme/ws.git", "admin@example.com")
    loaded = remote.load_config(secrets)
    assert loaded["url"] == "git@github.com:acme/ws.git"
    assert loaded["updated_by"] == "admin@example.com"
    assert loaded["updated_at"] == saved["updated_at"]
    assert _mode(os.path.join(remote.remote_dir(secrets), remote.CONFIG_FILE)) == 0o600

    assert remote.load_status(secrets)["result"] == "unconfigured"
    remote.save_status(secrets, {"result": "ok", "branches": {"dev": {"result": "pushed"}}})
    assert remote.load_status(secrets)["branches"]["dev"]["result"] == "pushed"
    assert _mode(os.path.join(remote.remote_dir(secrets), remote.STATUS_FILE)) == 0o600

    remote.save_config(secrets, None, "admin@example.com")
    assert remote.load_config(secrets)["url"] is None


def test_ssh_env_pins_the_dedicated_key_and_known_hosts(tmp_path):
    secrets = str(tmp_path / "secrets")
    env = remote.ssh_env(secrets)
    command = env["GIT_SSH_COMMAND"]
    assert remote.private_key_path(secrets) in command
    assert "IdentitiesOnly=yes" in command
    assert "BatchMode=yes" in command
    assert "StrictHostKeyChecking=accept-new" in command
    assert remote.known_hosts_path(secrets) in command
    assert env["GIT_TERMINAL_PROMPT"] == "0"
    assert _mode(remote.known_hosts_path(secrets)) == 0o600
