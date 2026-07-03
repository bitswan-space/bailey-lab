"""
Git task queue: serializes git-mutating operations through a single FIFO worker
instead of guarding them with a lock that fails on contention.

Background
----------
Git operations (deploys, syncs, promotes, commits, template applies, …) used to
be serialized by a global ``GitLockContext`` (a ``threading.Lock`` with a 10s
timeout). Under concurrent use that lock either FAILED the request ("Failed to
acquire git lock within N seconds") or blocked it. Neither is acceptable.

This module replaces that lock with an explicit, observable task queue:

* Every git-mutating action is SUBMITTED as a task and the caller gets a task id
  back immediately (fire-and-forget) — it never fails on contention and never
  blocks the request thread waiting for a lock.
* A single worker runs tasks strictly one-at-a-time in FIFO order, so the git
  repo is never touched concurrently — the same guarantee the lock gave, without
  the failure mode. Operations run inside a task therefore need no further git
  locking.
* The queue is observable: ``snapshot()`` lists queued/running/recent tasks
  (each carrying the initiating user's email), and ``subscribe()`` streams live
  updates for the dashboard's queue panel.
* Admins can ``clear()`` the queue — every still-queued task is cancelled (its
  coroutine never runs); the currently-running task is left to finish (a git
  operation can't be safely killed mid-write).
"""

import asyncio
import contextvars
import logging
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Awaitable, Callable

logger = logging.getLogger(__name__)

# The email of the user whose request is currently being served, set by the HTTP
# middleware (from X-Forwarded-Email / the by/deployed_by param). Git operations
# deep in the call stack read it to attribute their queue task without threading
# the email through every function. Defaults to None for background work.
current_requester: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "current_requester", default=None
)


class TaskStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class Task:
    """One queued git-mutating action. ``kind`` is a short human label
    ("deploy", "sync", "promote", …); ``requester_email`` is the user who
    initiated it (forwarded from the gate as X-Forwarded-Email)."""

    task_id: str
    kind: str
    requester_email: str | None = None
    label: str | None = None  # optional sub-target, e.g. the BP/automation name
    status: TaskStatus = TaskStatus.QUEUED
    message: str = ""
    error: str | None = None
    created_at: datetime = field(default_factory=_now)
    started_at: datetime | None = None
    completed_at: datetime | None = None

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "kind": self.kind,
            "requester_email": self.requester_email,
            "label": self.label,
            "status": self.status.value,
            "message": self.message,
            "error": self.error,
            "created_at": self.created_at.isoformat(),
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat()
            if self.completed_at
            else None,
        }


# A task's work is an async, no-arg callable producing the operation's result.
TaskFn = Callable[[], Awaitable[object]]


class TaskQueue:
    """Single-worker FIFO queue serializing git-mutating operations."""

    # How many finished tasks to keep visible in the queue panel.
    _HISTORY = 50

    def __init__(self) -> None:
        # The asyncio.Queue + worker are created lazily inside the RUNNING event
        # loop (not at import time, which would bind them to the wrong/no loop),
        # and recreated if the loop changes (e.g. across test cases).
        self._queue: asyncio.Queue[str] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._tasks: dict[str, Task] = {}
        self._fns: dict[str, TaskFn] = {}
        self._order: deque[str] = deque()  # creation order for snapshot()
        self._cancelled: set[str] = set()
        self._releases: dict[str, asyncio.Event] = {}  # lease task_id → release event
        self._subscribers: set[asyncio.Queue[dict]] = set()
        self._worker: asyncio.Task | None = None
        self._running_id: str | None = None

    # ------------------------------------------------------------------ submit
    def submit(
        self,
        kind: str,
        fn: TaskFn,
        *,
        requester_email: str | None = None,
        label: str | None = None,
    ) -> str:
        """Enqueue a git-mutating operation and return its task id immediately.

        ``fn`` is an async no-arg callable run by the worker when this task
        reaches the front of the queue. The result/exception is recorded on the
        task; the caller does NOT wait for it (fire-and-forget).
        """
        task = Task(
            task_id=str(uuid.uuid4()),
            kind=kind,
            requester_email=requester_email,
            label=label,
        )
        self._tasks[task.task_id] = task
        self._fns[task.task_id] = fn
        self._order.append(task.task_id)
        self._trim_history()
        self._ensure_worker()
        self._queue.put_nowait(task.task_id)
        self._broadcast(task)
        return task.task_id

    # -------------------------------------------------------------------- lease
    async def acquire(
        self, kind: str, *, requester_email: str | None = None, label: str | None = None
    ) -> str:
        """Take the queue's exclusive turn for a critical section (the git-lock
        replacement). Enqueues a task and AWAITS until it reaches the front and
        the worker grants it (status → running); then the caller runs its git
        ops and must call ``release(task_id)``. Serialized FIFO like the lock,
        but it queues (never fails on contention) and is visible. If the task is
        cancelled while queued (admin clear), this raises ``asyncio.CancelledError``.
        """
        granted: asyncio.Event = asyncio.Event()
        released: asyncio.Event = asyncio.Event()

        async def _hold() -> None:
            granted.set()
            await released.wait()

        task_id = self.submit(kind, _hold, requester_email=requester_email, label=label)
        self._releases[task_id] = released
        # Wait until granted (running) OR cancelled while still queued.
        while not granted.is_set():
            task = self._tasks.get(task_id)
            if task is None or task.status == TaskStatus.CANCELLED:
                self._releases.pop(task_id, None)
                raise asyncio.CancelledError("git task cancelled while queued")
            await asyncio.sleep(0.05)
        return task_id

    def release(self, task_id: str) -> None:
        """Release a lease taken with ``acquire`` so the worker advances."""
        ev = self._releases.pop(task_id, None)
        if ev is not None:
            ev.set()

    # ------------------------------------------------------------------- worker
    def _ensure_worker(self) -> None:
        """Create the queue + worker in the current running loop, (re)binding if
        the loop changed. Always called from within a running loop (submit is
        invoked from async handlers / acquire)."""
        loop = asyncio.get_running_loop()
        if self._queue is None or self._loop is not loop:
            self._queue = asyncio.Queue()
            self._loop = loop
            self._worker = asyncio.create_task(self._run())
        elif self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._run())

    async def _run(self) -> None:
        while True:
            task_id = await self._queue.get()
            try:
                task = self._tasks.get(task_id)
                fn = self._fns.pop(task_id, None)
                if task is None or fn is None:
                    continue
                if task_id in self._cancelled or task.status == TaskStatus.CANCELLED:
                    continue  # cleared while queued
                task.status = TaskStatus.RUNNING
                task.started_at = _now()
                self._running_id = task_id
                self._broadcast(task)
                try:
                    await fn()
                    task.status = TaskStatus.COMPLETED
                except asyncio.CancelledError:
                    task.status = TaskStatus.CANCELLED
                    raise
                except Exception as e:  # noqa: BLE001 — record, never crash the worker
                    task.status = TaskStatus.FAILED
                    task.error = str(e)
                    logger.exception("task %s (%s) failed", task_id, task.kind)
                finally:
                    task.completed_at = _now()
                    self._running_id = None
                    self._broadcast(task)
            finally:
                self._queue.task_done()

    # -------------------------------------------------------------------- admin
    def clear(self) -> int:
        """Cancel every still-QUEUED task (the running one is left to finish).
        Returns the number cancelled."""
        n = 0
        for task_id, task in self._tasks.items():
            if task.status == TaskStatus.QUEUED:
                task.status = TaskStatus.CANCELLED
                task.completed_at = _now()
                task.message = "cancelled by admin"
                self._cancelled.add(task_id)
                self._broadcast(task)
                n += 1
        return n

    # --------------------------------------------------------------- observable
    def snapshot(self) -> list[dict]:
        """Queued + running + recent-finished tasks, newest first."""
        return [
            self._tasks[t].to_dict() for t in reversed(self._order) if t in self._tasks
        ]

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue[dict] = asyncio.Queue()
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def _broadcast(self, task: Task) -> None:
        payload = task.to_dict()
        for q in list(self._subscribers):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                pass

    def _trim_history(self) -> None:
        finished = (TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED)
        done_ids = [
            t
            for t in self._order
            if self._tasks.get(t) and self._tasks[t].status in finished
        ]
        while len(done_ids) > self._HISTORY:
            old = done_ids.pop(0)
            self._order.remove(old)
            self._tasks.pop(old, None)
            self._fns.pop(old, None)
            self._cancelled.discard(old)


# Module-level singleton shared across the gitops process.
task_queue = TaskQueue()
