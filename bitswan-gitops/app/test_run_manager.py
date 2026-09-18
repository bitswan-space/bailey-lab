"""In-memory state for requirement test runs — one current run per (copy, BP).

Deliberately NOT persisted. A verdict is only meaningful for the exact code it
was produced from, so it lives for as long as that code is what HEAD points at
and no longer. gitops re-runs HEAD on startup instead of restoring anything,
which means a restart can never resurrect a verdict for code that has since
changed.

Two things make a stored verdict honest:

* `head_sha` — which commit it was produced for. The deploy gate only accepts
  a run whose sha is the one being deployed.
* `tree_sha` — what the working tree actually looked like. live-dev bind-mounts
  the WORKING TREE, not the commit, so a run tests whatever is on disk at that
  moment. If the tree moves afterwards the result is marked stale and stops
  satisfying the gate, rather than quietly vouching for code nobody ran.

Mirrors the shape of `app/snapshot_manager.py`, with one addition no existing
manager has: a run can be cancelled, because a new commit supersedes an
in-flight run.
"""

import asyncio
import logging
import uuid
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

# Run-level status.
RUN_RUNNING = "running"
RUN_COMPLETED = "completed"
RUN_CANCELLED = "cancelled"
RUN_FAILED = "failed"

# Per-requirement verdicts. `queued`/`running` are live states; `pass`/`fail`/
# `no_test` come from a report; `blocked` means a parent failed so the child
# was never run (its own result would be meaningless).
VERDICT_QUEUED = "queued"
VERDICT_RUNNING = "running"
VERDICT_PASS = "pass"
VERDICT_FAIL = "fail"
VERDICT_NO_TEST = "no_test"
VERDICT_BLOCKED = "blocked"

_TERMINAL_VERDICTS = (VERDICT_PASS, VERDICT_FAIL, VERDICT_NO_TEST, VERDICT_BLOCKED)


class RequirementResult:
    """One requirement's state within a run.

    `previous_verdict` carries the last commit's answer while this run is still
    queued or running, so the tab can grey out the old result instead of going
    blank on every commit.
    """

    __slots__ = (
        "id",
        "description",
        "origin",
        "verdict",
        "output",
        "deployment_id",
        "automation",
        "previous_verdict",
        "previous_sha",
    )

    def __init__(
        self,
        id: str,
        description: str = "",
        origin: str = "",
        verdict: str = VERDICT_QUEUED,
        output: str = "",
        deployment_id: str = "",
        automation: str = "",
        previous_verdict: str = "",
        previous_sha: str = "",
    ):
        self.id = id
        self.description = description
        # "proposed" — an agent suggestion the user has not accepted. Carried
        # through so the tab can group proposals separately from verdicts.
        self.origin = origin
        self.verdict = verdict
        self.output = output
        self.deployment_id = deployment_id
        self.automation = automation
        self.previous_verdict = previous_verdict
        self.previous_sha = previous_sha

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "description": self.description,
            "origin": self.origin,
            "verdict": self.verdict,
            "output": self.output,
            "deployment_id": self.deployment_id,
            "automation": self.automation,
            "previous_verdict": self.previous_verdict,
            "previous_sha": self.previous_sha,
        }


class TestRun:
    __slots__ = (
        "run_id",
        "copy",
        "bp",
        "head_sha",
        "head_subject",
        "tree_sha",
        "status",
        "error",
        "results",
        "started_at",
        "completed_at",
    )

    def __init__(
        self,
        run_id: str,
        copy: str | None,
        bp: str,
        head_sha: str = "",
        head_subject: str = "",
        tree_sha: str = "",
    ):
        self.run_id = run_id
        self.copy = copy
        self.bp = bp
        self.head_sha = head_sha
        self.head_subject = head_subject
        self.tree_sha = tree_sha
        self.status = RUN_RUNNING
        self.error: str | None = None
        self.results: dict[str, RequirementResult] = {}
        self.started_at = datetime.now(timezone.utc)
        self.completed_at: datetime | None = None

    def counts(self) -> dict:
        out = {
            VERDICT_QUEUED: 0,
            VERDICT_RUNNING: 0,
            VERDICT_PASS: 0,
            VERDICT_FAIL: 0,
            VERDICT_NO_TEST: 0,
            VERDICT_BLOCKED: 0,
        }
        for result in self.results.values():
            if result.verdict in out:
                out[result.verdict] += 1
        return out

    def is_green(self) -> bool:
        """Every requirement that could be judged came back clean.

        `no_test` does not block: a requirement nobody has written a test for
        is an unfinished contract, not a failing one, and blocking every deploy
        on it would make the feature unusable while a BP is being written. The
        count is reported separately so the gap stays visible.
        """
        if self.status != RUN_COMPLETED:
            return False
        return not any(
            r.verdict
            in (VERDICT_FAIL, VERDICT_BLOCKED, VERDICT_QUEUED, VERDICT_RUNNING)
            for r in self.results.values()
        )

    def to_dict(self, stale: bool = False) -> dict:
        return {
            "run_id": self.run_id,
            "copy": self.copy,
            "bp": self.bp,
            "head_sha": self.head_sha,
            "head_subject": self.head_subject,
            "tree_sha": self.tree_sha,
            "status": self.status,
            "stale": stale,
            "green": self.is_green() and not stale,
            "error": self.error,
            "counts": self.counts(),
            "requirements": [r.to_dict() for r in self.results.values()],
            "started_at": self.started_at.isoformat(),
            "completed_at": (
                self.completed_at.isoformat() if self.completed_at else None
            ),
        }


class TestRunManager:
    """Holds the current run per (copy, BP) and the task executing it."""

    def __init__(self):
        self._runs: dict[str, TestRun] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    @staticmethod
    def key(copy: str | None, bp: str) -> str:
        return f"{copy or 'main'}:{bp}"

    def get(self, copy: str | None, bp: str) -> TestRun | None:
        return self._runs.get(self.key(copy, bp))

    def all_runs(self) -> list[TestRun]:
        return list(self._runs.values())

    def is_running(self, copy: str | None, bp: str) -> bool:
        run = self.get(copy, bp)
        return run is not None and run.status == RUN_RUNNING

    def start(
        self,
        copy: str | None,
        bp: str,
        head_sha: str,
        head_subject: str,
        tree_sha: str,
    ) -> TestRun:
        """Open a new run, carrying the previous run's verdicts forward as the
        greyed-out 'from the last commit' state."""
        previous = self.get(copy, bp)
        run = TestRun(
            run_id=str(uuid.uuid4()),
            copy=copy,
            bp=bp,
            head_sha=head_sha,
            head_subject=head_subject,
            tree_sha=tree_sha,
        )
        if previous:
            for req_id, old in previous.results.items():
                if old.verdict in _TERMINAL_VERDICTS:
                    run.results[req_id] = RequirementResult(
                        id=req_id,
                        description=old.description,
                        origin=old.origin,
                        deployment_id=old.deployment_id,
                        automation=old.automation,
                        previous_verdict=old.verdict,
                        previous_sha=previous.head_sha,
                    )
        self._runs[self.key(copy, bp)] = run
        return run

    def finish(self, run: TestRun, status: str, error: str | None = None) -> None:
        run.status = status
        run.error = error
        run.completed_at = datetime.now(timezone.utc)

    def register_task(self, copy: str | None, bp: str, task: asyncio.Task) -> None:
        self._tasks[self.key(copy, bp)] = task
        task.add_done_callback(
            lambda t, k=self.key(copy, bp): self._tasks.pop(k, None)
            if self._tasks.get(k) is t
            else None
        )

    def cancel(self, copy: str | None, bp: str) -> bool:
        """Abandon an in-flight run.

        Only the asyncio task is cancelled: the test process already handed to
        `docker exec` keeps running inside the container, because killing the
        exec CLIENT does not kill the process it started. Its results are
        discarded rather than recorded, which is what matters for correctness —
        a superseded run must never write a verdict for a commit nobody asked
        about.
        """
        task = self._tasks.get(self.key(copy, bp))
        if task is None or task.done():
            return False
        task.cancel()
        return True

    def forget(self, copy: str | None, bp: str) -> None:
        key = self.key(copy, bp)
        self._runs.pop(key, None)
        self._tasks.pop(key, None)

    def forget_copy(self, copy: str | None) -> None:
        prefix = f"{copy or 'main'}:"
        for key in [k for k in self._runs if k.startswith(prefix)]:
            self._runs.pop(key, None)
            self._tasks.pop(key, None)


# Singleton
test_run_manager = TestRunManager()
