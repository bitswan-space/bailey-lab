"""Regression tests for #130 — bp-name validation / path-traversal.

Two distinct sinks are covered:

1. The `automations` routes accepted a `{bp}` path param (and a body `bp`)
   without the `validate_bp_name` guard their siblings apply. Unvalidated, a
   member-supplied name flows into a filesystem path / git cwd inside gitops
   (`bp_state_path(...)`), a path traversal.

2. `_build_git_command` interpolates the git `cwd` into a `su -c "cd {cwd} …"`
   shell string. The command *args* were `shlex.quote`d but `cwd` was not — so
   in nsenter/host mode the same unvalidated `bp` reaching `cwd` becomes host
   command execution. This is the latent-critical half of the finding.
"""

import shlex

import pytest
from fastapi import HTTPException

from app.utils import _build_git_command
from app.routes.automations import _require_valid_bp, _validated_bp
from app.services.automation_service import AutomationService


# --- sink 2: nsenter builder must shell-quote cwd -------------------------


def test_build_git_command_quotes_cwd_in_nsenter_mode(monkeypatch):
    monkeypatch.setenv("HOST_PATH", "/usr/bin:/bin")
    monkeypatch.setenv("HOST_HOME", "/root")
    monkeypatch.setenv("HOST_USER", "root")

    # A cwd carrying shell metacharacters is the injection vector. It must land
    # in the built command as a single shell-quoted token, never raw.
    evil = '/gitops/bp/x"; touch /tmp/pwned #'
    exec_command, kwargs = _build_git_command("git", "status", cwd=evil)

    assert exec_command[0] == "nsenter"
    host_command = exec_command[-1]  # the `sh -c <string>` payload

    # Quoted form present; raw break-out sequence absent.
    assert f"cd {shlex.quote(evil)} &&" in host_command
    assert "; touch /tmp/pwned" not in host_command.replace(shlex.quote(evil), "")
    # kwargs empty in nsenter mode (cwd is baked into the shell string).
    assert kwargs == {}


def test_build_git_command_local_fallback(monkeypatch):
    for v in ("HOST_PATH", "HOST_HOME", "HOST_USER"):
        monkeypatch.delenv(v, raising=False)
    exec_command, kwargs = _build_git_command("git", "status", cwd="/some/dir")
    assert exec_command == ["git", "status"]
    assert kwargs == {"cwd": "/some/dir"}


# --- sink 1: route boundary guard -----------------------------------------


@pytest.mark.parametrize(
    "bad",
    [
        "",
        ".",
        "..",
        "../etc/passwd",
        "a/b",
        "foo/../bar",
        "-rf",  # leading dash
        ".hidden",  # leading dot
        'a"b',  # quote
        "a b",  # space
        "$(id)",  # command substitution chars
    ],
)
def test_route_guard_rejects_unsafe_bp(bad):
    with pytest.raises(HTTPException) as ei:
        _require_valid_bp(bad)
    assert ei.value.status_code == 400


def test_route_guard_accepts_valid_bp():
    for good in ("invoice-processing", "bp_1.2", "AbC123", "a-b_c.d"):
        assert _validated_bp(good) == good


# --- sink 1, defense in depth: the service layer also validates -----------


class _StubSelf:
    """A do-nothing self: the guard must fire before any attribute is touched."""


async def test_service_bp_history_validates_before_touching_state():
    # validate_bp_name is the method's first statement, so a bad name raises
    # ValueError before the stubbed self would blow up on a missing attribute.
    with pytest.raises(ValueError):
        await AutomationService.bp_history(_StubSelf(), "../evil", "dev")
