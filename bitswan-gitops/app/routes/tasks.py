"""
Git task-queue API: observe the queue and (admin) clear it.

The queue serializes git-mutating operations in place of the old git lock (see
app/task_queue.py). Live updates are relayed onto the existing /events/stream SSE
as `task_queue` events (wired in app/lifespan.py), so the dashboard's toast panel
gets them on the connection it already holds.
"""

from fastapi import APIRouter, HTTPException

from app.task_queue import task_queue
from app.utils import daemon_user_role

router = APIRouter(tags=["tasks"])


@router.get("/tasks")
async def list_tasks() -> dict:
    """The current queue: queued + running + recent-finished tasks, newest
    first. Each carries the initiating user's email."""
    return {"tasks": task_queue.snapshot()}


@router.post("/tasks/clear")
async def clear_tasks(by: str | None = None) -> dict:
    """Cancel every still-queued task. Admin-only: the role is resolved from the
    daemon's authoritative store (never client-asserted), and we fail closed.
    The currently-running task is left to finish — a git operation can't be
    safely killed mid-write."""
    if daemon_user_role(by or "") != "admin":
        raise HTTPException(status_code=403, detail="clearing the queue is admin-only")
    cancelled = task_queue.clear()
    return {"cancelled": cancelled}
