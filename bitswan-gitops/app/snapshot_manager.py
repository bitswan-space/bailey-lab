"""
Snapshot manager: tracks in-flight snapshot/restore/clone tasks with
per-(bp, stage) locking.

Deliberately mirrors `app/deploy_manager.py` rather than generalising it —
DeployTask's shape and the `deploy_progress` event are consumed by existing
clients and must not change. A snapshot task locks every bp×stage it
touches (restore/clone reserve source AND target atomically), so concurrent
operations on the same BP+stage 409 instead of corrupting each other.
"""

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum

logger = logging.getLogger(__name__)


class SnapshotStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"


class SnapshotStep(str, Enum):
    """Ordered steps — the dashboard derives its progress bar position from
    this order, so keep it in execution order."""

    VALIDATING = "validating"
    SNAPSHOT_POSTGRES = "snapshot_postgres"
    SNAPSHOT_COUCHDB = "snapshot_couchdb"
    SNAPSHOT_MINIO = "snapshot_minio"
    PRE_RESTORE_SNAPSHOT = "pre_restore_snapshot"
    PRUNING = "pruning"
    RESTORE_POSTGRES = "restore_postgres"
    RESTORE_COUCHDB = "restore_couchdb"
    RESTORE_MINIO = "restore_minio"
    DONE = "done"


# What each operation runs, in order. The UI weights its progress bar by
# position in the relevant sequence.
OPERATION_STEPS: dict[str, list[str]] = {
    "create": [
        SnapshotStep.VALIDATING.value,
        SnapshotStep.SNAPSHOT_POSTGRES.value,
        SnapshotStep.SNAPSHOT_COUCHDB.value,
        SnapshotStep.SNAPSHOT_MINIO.value,
        SnapshotStep.DONE.value,
    ],
    "restore": [
        SnapshotStep.VALIDATING.value,
        SnapshotStep.PRE_RESTORE_SNAPSHOT.value,
        SnapshotStep.SNAPSHOT_POSTGRES.value,
        SnapshotStep.SNAPSHOT_COUCHDB.value,
        SnapshotStep.SNAPSHOT_MINIO.value,
        SnapshotStep.PRUNING.value,
        SnapshotStep.RESTORE_POSTGRES.value,
        SnapshotStep.RESTORE_COUCHDB.value,
        SnapshotStep.RESTORE_MINIO.value,
        SnapshotStep.DONE.value,
    ],
    "clone": [
        SnapshotStep.VALIDATING.value,
        SnapshotStep.SNAPSHOT_POSTGRES.value,
        SnapshotStep.SNAPSHOT_COUCHDB.value,
        SnapshotStep.SNAPSHOT_MINIO.value,
        SnapshotStep.PRE_RESTORE_SNAPSHOT.value,
        SnapshotStep.PRUNING.value,
        SnapshotStep.RESTORE_POSTGRES.value,
        SnapshotStep.RESTORE_COUCHDB.value,
        SnapshotStep.RESTORE_MINIO.value,
        SnapshotStep.DONE.value,
    ],
}


@dataclass
class SnapshotTask:
    task_id: str
    operation: str  # create | restore | clone | delete
    bp: str
    stages: list[str]  # every bp×stage this task locks
    source_stage: str | None = None
    target_stage: str | None = None
    snapshot_id: str | None = None  # input for restore; output for create
    status: SnapshotStatus = SnapshotStatus.PENDING
    step: SnapshotStep | None = None
    message: str = ""
    error: str | None = None
    result: dict | None = None
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    completed_at: datetime | None = None

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "operation": self.operation,
            "bp": self.bp,
            "stages": self.stages,
            "source_stage": self.source_stage,
            "target_stage": self.target_stage,
            "snapshot_id": self.snapshot_id,
            "status": self.status.value,
            "step": self.step.value if self.step else None,
            "steps": OPERATION_STEPS.get(self.operation, []),
            "message": self.message,
            "error": self.error,
            "result": self.result,
            "started_at": self.started_at.isoformat(),
            "completed_at": (
                self.completed_at.isoformat() if self.completed_at else None
            ),
        }


class SnapshotManager:
    def __init__(self):
        self._tasks: dict[str, SnapshotTask] = {}  # task_id → task
        self._active: dict[str, str] = {}  # "{bp}:{stage}" → task_id
        self._lock = asyncio.Lock()

    @staticmethod
    def _key(bp: str, stage: str) -> str:
        return f"{bp}:{stage}"

    def is_busy(self, bp: str, stage: str) -> bool:
        return self._key(bp, stage) in self._active

    async def create_task(
        self,
        operation: str,
        bp: str,
        stages: list[str],
        source_stage: str | None = None,
        target_stage: str | None = None,
        snapshot_id: str | None = None,
    ) -> tuple["SnapshotTask | None", str | None]:
        """Atomically reserve every bp×stage the operation touches.

        Returns (task, None) on success, or (None, conflicting_stage) when
        ANY stage is already locked — in which case nothing is reserved.
        """
        async with self._lock:
            for stage in stages:
                if self._key(bp, stage) in self._active:
                    return None, stage
            task_id = str(uuid.uuid4())
            task = SnapshotTask(
                task_id=task_id,
                operation=operation,
                bp=bp,
                stages=list(stages),
                source_stage=source_stage,
                target_stage=target_stage,
                snapshot_id=snapshot_id,
            )
            self._tasks[task_id] = task
            for stage in stages:
                self._active[self._key(bp, stage)] = task_id
            return task, None

    async def update_task(
        self,
        task_id: str,
        status: SnapshotStatus | None = None,
        step: SnapshotStep | None = None,
        message: str | None = None,
        error: str | None = None,
        snapshot_id: str | None = None,
        result: dict | None = None,
    ):
        task = self._tasks.get(task_id)
        if not task:
            return
        if status is not None:
            task.status = status
        if step is not None:
            task.step = step
        if message is not None:
            task.message = message
        if error is not None:
            task.error = error
        if snapshot_id is not None:
            task.snapshot_id = snapshot_id
        if result is not None:
            task.result = result
        if status in (SnapshotStatus.COMPLETED, SnapshotStatus.FAILED):
            task.completed_at = datetime.now(timezone.utc)
            async with self._lock:
                for stage in task.stages:
                    key = self._key(task.bp, stage)
                    if self._active.get(key) == task_id:
                        self._active.pop(key, None)

    def get_task(self, task_id: str) -> SnapshotTask | None:
        return self._tasks.get(task_id)

    def get_active_tasks_for_bp(self, bp: str) -> list[SnapshotTask]:
        return [
            self._tasks[tid]
            for key, tid in self._active.items()
            if key.startswith(f"{bp}:") and tid in self._tasks
        ]

    def cleanup_old_tasks(self, max_age_seconds: int = 3600):
        now = datetime.now(timezone.utc)
        to_remove = [
            task_id
            for task_id, task in self._tasks.items()
            if task.status in (SnapshotStatus.COMPLETED, SnapshotStatus.FAILED)
            and (now - task.started_at).total_seconds() > max_age_seconds
        ]
        for task_id in to_remove:
            del self._tasks[task_id]
        if to_remove:
            logger.info("Cleaned up %d old snapshot tasks", len(to_remove))


# Singleton
snapshot_manager = SnapshotManager()
