"""Commit-triggered test runs: which filesystem events start a run.

Tests are CI here — they run because a commit landed, not because someone
pressed a button — so what counts as "a commit landed" is worth pinning down.
"""

import types

from app.lifespan import CopyChangeHandler

ROOT = "/copies"


def _handler(monkeypatch):
    loop = types.SimpleNamespace(call_soon_threadsafe=lambda fn: fn())
    handler = CopyChangeHandler(loop, ROOT)
    scheduled: list[tuple[str, str]] = []
    monkeypatch.setattr(
        handler, "_schedule_tests_ping", lambda copy, bp: scheduled.append((copy, bp))
    )
    # The other pipelines are not under test here.
    monkeypatch.setattr(handler, "_schedule_copies_ping", lambda *a: None)
    monkeypatch.setattr(handler, "_schedule_process_refresh", lambda *a: None)
    monkeypatch.setattr(handler, "_schedule_automations_refresh", lambda *a: None)
    return handler, scheduled


def _event(path):
    return types.SimpleNamespace(src_path=path)


def test_branch_tip_move_is_a_commit(monkeypatch):
    handler, _ = _handler(monkeypatch)
    assert handler._is_commit(f"{ROOT}/dev1/shop/.git/refs/heads/main")
    assert handler._is_commit(f"{ROOT}/dev1/shop/.git/HEAD")


def test_staging_a_file_is_not_a_commit(monkeypatch):
    """`git add` writes .git/index. Re-running a suite for that would cost
    more than it is worth."""
    handler, _ = _handler(monkeypatch)
    assert not handler._is_commit(f"{ROOT}/dev1/shop/.git/index")


def test_bp_is_read_out_of_the_path(monkeypatch):
    handler, _ = _handler(monkeypatch)
    assert handler._bp_from_git_path(f"{ROOT}/dev1/shop/.git/HEAD") == "shop"
    # A .git directly under the copy is not a BP.
    assert handler._bp_from_git_path(f"{ROOT}/dev1/.git/HEAD") is None


def test_commit_in_a_copy_schedules_a_run(monkeypatch):
    handler, scheduled = _handler(monkeypatch)
    handler._handle(_event(f"{ROOT}/dev1/shop/.git/refs/heads/main"))
    assert scheduled == [("dev1", "shop")]


def test_commit_in_main_does_not(monkeypatch):
    """The gate is on the copy; main's tip is whatever a sync just
    fast-forwarded to, so testing it again is pure duplication."""
    handler, scheduled = _handler(monkeypatch)
    handler._handle(_event(f"{ROOT}/main/shop/.git/refs/heads/main"))
    assert scheduled == []


def test_a_source_edit_does_not_schedule_a_run(monkeypatch):
    handler, scheduled = _handler(monkeypatch)
    handler._handle(_event(f"{ROOT}/dev1/shop/backend/main.go"))
    assert scheduled == []


def test_git_housekeeping_is_ignored(monkeypatch):
    handler, scheduled = _handler(monkeypatch)
    handler._handle(_event(f"{ROOT}/dev1/shop/.git/objects/ab/cdef"))
    handler._handle(_event(f"{ROOT}/dev1/shop/.git/logs/HEAD"))
    assert scheduled == []


def test_a_burst_of_events_coalesces_into_one_pending_run(monkeypatch):
    handler, _ = _handler(monkeypatch)
    # Restore the real scheduler to exercise the dirty-set coalescing.
    monkeypatch.undo()
    loop = types.SimpleNamespace(call_soon_threadsafe=lambda fn: fn())
    handler = CopyChangeHandler(loop, ROOT)
    handler._tests_ping_task = types.SimpleNamespace(done=lambda: False)
    handler._schedule_tests_ping("dev1", "shop")
    handler._schedule_tests_ping("dev1", "shop")
    handler._schedule_tests_ping("dev1", "other")
    assert handler._tests_dirty == {("dev1", "shop"), ("dev1", "other")}
