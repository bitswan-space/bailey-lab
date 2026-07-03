"""Tests for the git task queue that replaces the git lock."""

import asyncio

import pytest

from app.task_queue import TaskQueue, TaskStatus


@pytest.mark.asyncio
async def test_submit_runs_and_records():
    q = TaskQueue()
    ran = asyncio.Event()

    async def work():
        ran.set()

    tid = q.submit("deploy", work, requester_email="alice@example.com", label="bp1")
    await asyncio.wait_for(ran.wait(), timeout=2)
    await asyncio.sleep(0.01)  # let the worker mark it completed
    task = next(t for t in q.snapshot() if t["task_id"] == tid)
    assert task["status"] == TaskStatus.COMPLETED.value
    assert task["requester_email"] == "alice@example.com"
    assert task["kind"] == "deploy"
    assert task["label"] == "bp1"


@pytest.mark.asyncio
async def test_failure_is_recorded_not_raised():
    q = TaskQueue()

    async def boom():
        raise ValueError("nope")

    tid = q.submit("sync", boom)
    await asyncio.sleep(0.05)
    task = next(t for t in q.snapshot() if t["task_id"] == tid)
    assert task["status"] == TaskStatus.FAILED.value
    assert "nope" in (task["error"] or "")


@pytest.mark.asyncio
async def test_lease_serializes_in_fifo_order():
    """acquire()/release() run critical sections one-at-a-time, in order."""
    q = TaskQueue()
    order: list[int] = []

    async def critical(n: int):
        tid = await q.acquire("git", requester_email=f"u{n}@x")
        order.append(n)
        await asyncio.sleep(0.02)  # hold the turn
        q.release(tid)

    # Start three; they must serialize (no interleave) and preserve start order.
    await asyncio.gather(critical(1), critical(2), critical(3))
    assert order == [1, 2, 3]


@pytest.mark.asyncio
async def test_clear_cancels_queued_only():
    q = TaskQueue()
    started = asyncio.Event()
    release_first = asyncio.Event()

    async def hold():
        started.set()
        await release_first.wait()

    async def quick():
        pass

    running = q.submit("git", hold)  # occupies the worker
    await asyncio.wait_for(started.wait(), timeout=2)
    queued = q.submit("git", quick)  # stuck behind the running one

    cancelled = q.clear()
    assert cancelled == 1
    queued_task = next(t for t in q.snapshot() if t["task_id"] == queued)
    assert queued_task["status"] == TaskStatus.CANCELLED.value
    # The running task is untouched; let it finish.
    running_task = next(t for t in q.snapshot() if t["task_id"] == running)
    assert running_task["status"] == TaskStatus.RUNNING.value
    release_first.set()
    await asyncio.sleep(0.02)
