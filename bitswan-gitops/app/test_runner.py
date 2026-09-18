"""Run a business process's requirement tests and record the verdicts.

The tests execute as a `docker exec` inside the BP's live-dev container — the
same container the automation itself runs in, not a throwaway one — so they see
the real service dependencies and the code as it is on disk. `/app` is mounted
READ-ONLY there, which is why every built-in runner writes its report to /tmp.

Two properties this module is responsible for:

* A verdict is evidence-based. The runner is asked for a machine-readable
  report and the verdict comes from that (see `requirement_verdicts`), never
  from the exit code, which lies in both directions.
* A child requirement is not run while its parent is failing. A parent is a
  precondition: a child's result would be noise, so it is reported `blocked`
  instead of being executed and counted.
"""

import asyncio
import hashlib
import logging
import os

from app.services.infra_driver_client import ExecSpec
from app.services.requirement_verdicts import (
    FRAMEWORK_GO,
    FRAMEWORK_PYTEST,
    parse_report,
    verdict_for_requirement,
)
from app.services.testable_requirements import (
    Requirement,
    read_requirements,
    read_testing_config,
    requirement_token,
)
from app.test_run_manager import (
    RUN_CANCELLED,
    RUN_COMPLETED,
    RUN_FAILED,
    VERDICT_BLOCKED,
    VERDICT_FAIL,
    VERDICT_NO_TEST,
    VERDICT_PASS,
    VERDICT_QUEUED,
    VERDICT_RUNNING,
    RequirementResult,
    TestRun,
    test_run_manager,
)
from app.utils import call_git_command_with_output, sanitize_automation_name

logger = logging.getLogger(__name__)

# Built-in runners. Both `cd /app` first: the source is mounted there, and the
# stock pipeline-runtime-environment image declares no WORKDIR, so a bare
# `pytest` would try to collect from `/`. Both print a parseable report to
# stdout — pytest cannot write JUnit XML to stdout, so it is cat'd afterwards.
DEFAULT_RUNNERS = {
    FRAMEWORK_GO: "cd /app && go test -run {id} -json ./...",
    FRAMEWORK_PYTEST: (
        "cd /app && pytest -k {id} --junitxml=/tmp/bs-{id}.xml -q; cat /tmp/bs-{id}.xml"
    ),
}

# Flags a custom runner needs for its report to be parseable at all. Missing
# them is the most likely reason a hand-written runner produces nothing, so we
# say so in the failure instead of leaving a bare "unparseable report".
_REPORT_FLAGS = {FRAMEWORK_GO: "-json", FRAMEWORK_PYTEST: "--junitxml"}

DEFAULT_TIMEOUT_SECONDS = 120

# Cap on what one exec may return before we stop accumulating it.
_MAX_CAPTURE_BYTES = 512 * 1024


async def _git(cwd: str, *args) -> str:
    out, _, rc = await call_git_command_with_output("git", *args, cwd=cwd)
    return out.strip() if rc == 0 else ""


async def head_state(clone_path: str) -> tuple[str, str, str]:
    """(sha, subject, tree_sha) of the BP clone's HEAD.

    `tree_sha` is the *working tree's* hash, not the commit's: live-dev mounts
    the working tree, so this is what the run actually tested and what
    staleness is measured against.
    """
    sha = await _git(clone_path, "rev-parse", "HEAD")
    subject = await _git(clone_path, "log", "-1", "--format=%s")
    tree = await working_tree_sha(clone_path)
    return sha, subject, tree


async def working_tree_sha(clone_path: str) -> str:
    """A fingerprint of the tree as it is ON DISK, uncommitted edits included.

    Read-only by construction: it neither writes git objects nor touches the
    user's index, because this is computed on every read of the test state and
    must never have a side effect on someone's working copy.

    Tracked changes are covered exactly by the `git diff HEAD` patch. Untracked
    files are covered by name/size/mtime rather than content — hashing the
    bytes of arbitrary untracked files would mean reading whatever happens to
    be sitting in the directory, and a mtime change is enough to know the tree
    moved.
    """
    head = await _git(clone_path, "rev-parse", "HEAD")
    diff, _, _ = await call_git_command_with_output(
        "git", "diff", "HEAD", cwd=clone_path
    )
    untracked, _, _ = await call_git_command_with_output(
        "git", "ls-files", "--others", "--exclude-standard", cwd=clone_path
    )

    digest = hashlib.sha256()
    digest.update(head.encode())
    digest.update(diff.encode())
    for rel in sorted(line for line in untracked.splitlines() if line.strip()):
        digest.update(rel.encode())
        try:
            st = os.stat(os.path.join(clone_path, rel))
            digest.update(f"{st.st_size}:{st.st_mtime_ns}".encode())
        except OSError:
            digest.update(b"missing")
    return digest.hexdigest()


def resolve_framework(runner: str, framework: str) -> str:
    """Which report parser applies.

    An explicit `framework` wins. Otherwise it is inferred from a custom runner
    so an existing `[testing] runner = "go test …"` keeps working without the
    BP having to be edited first.
    """
    if framework:
        return framework.strip().lower()
    text = (runner or "").lower()
    if "go test" in text:
        return FRAMEWORK_GO
    if "pytest" in text:
        return FRAMEWORK_PYTEST
    return ""


def build_command(runner: str, framework: str, req_id: str) -> str:
    """The shell command for one requirement.

    `{id}` becomes the requirement's token (hyphens → underscores) so it can
    appear in a test function name.
    """
    template = runner or DEFAULT_RUNNERS.get(framework, "")
    return template.replace("{id}", requirement_token(req_id))


def runner_hint(runner: str, framework: str) -> str:
    """A sentence explaining why a custom runner produced no report, or ''."""
    if not runner:
        return ""
    flag = _REPORT_FLAGS.get(framework)
    if flag and flag not in runner:
        return (
            f"\n\nThe [testing] runner for this business process does not pass "
            f"{flag}, so it produces no machine-readable report and no verdict "
            f"can be read from it. Either drop `runner` to use the built-in "
            f"{framework} runner, or add {flag} to it."
        )
    return ""


class _Target:
    """Where and how one requirement's test runs."""

    __slots__ = ("deployment_id", "automation", "command", "framework", "error")

    def __init__(
        self,
        deployment_id: str = "",
        automation: str = "",
        command: str = "",
        framework: str = "",
        error: str = "",
    ):
        self.deployment_id = deployment_id
        self.automation = automation
        self.command = command
        self.framework = framework
        self.error = error


def resolve_target(req: Requirement, cfg, members: list[dict]) -> _Target:
    """Pick the live-dev deployment and command for one requirement.

    An explicit automation (per-requirement, else the BP's `[testing]`) is
    matched exactly. Without one, a BP with a single automation is
    unambiguous; anything else is a configuration error naming the candidates,
    because guessing which container a test belongs in is how a suite silently
    tests the wrong thing.
    """
    if not members:
        # The BP has no automations at all — there is nothing to run a test
        # in. That is an unfinished business process, not a misconfigured one,
        # so it must not read as a failure.
        return _Target(error="")

    automation = req.automation or cfg.automation
    if automation:
        wanted = sanitize_automation_name(automation)
        match = next((m for m in members if m.get("automation_name") == wanted), None)
        if not match:
            available = ", ".join(sorted(m.get("automation_name", "") for m in members))
            return _Target(
                error=(
                    f"[testing] automation = {automation!r} does not match any "
                    f"automation in this business process. Available: "
                    f"{available or '(none)'}"
                )
            )
    elif len(members) == 1:
        match = members[0]
    else:
        candidates = ", ".join(sorted(m.get("automation_name", "") for m in members))
        return _Target(
            error=(
                "this business process has more than one automation, so the "
                'container to test in is ambiguous. Set automation = "<name>" '
                f"under [testing] in process.toml. Candidates: {candidates}"
            )
        )

    runner = req.runner or cfg.runner
    framework = resolve_framework(runner, cfg.framework)
    if not framework:
        return _Target(
            error=(
                'no test framework configured. Set framework = "go" or '
                'framework = "pytest" under [testing] in process.toml.'
            )
        )
    return _Target(
        deployment_id=match.get("deployment_id", ""),
        automation=match.get("automation_name", ""),
        command=build_command(runner, framework, req.id),
        framework=framework,
    )


async def _exec_in_deployment(
    svc, deployment_id: str, command: str, timeout: int
) -> tuple[str, str | None]:
    """Run `command` in the deployment's container. Returns (output, error)."""
    containers = await svc.get_container(deployment_id)
    if not containers:
        return "", (
            f"no running container for deployment {deployment_id!r} — the "
            "live-dev instance could not be woken."
        )

    chunks: list[bytes] = []
    size = 0

    async def _capture(data: bytes):
        nonlocal size
        if size >= _MAX_CAPTURE_BYTES:
            return
        chunks.append(data)
        size += len(data)

    spec = ExecSpec(container=containers[0].get("Id"), cmd=["sh", "-c", command])
    try:
        await asyncio.wait_for(
            svc.infra_driver.exec(
                svc._workspace_ctx(),
                spec,
                on_stdout=_capture,
                on_stderr=_capture,
            ),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        return b"".join(chunks).decode("utf-8", "replace"), (
            f"test timed out after {timeout}s"
        )
    except Exception as e:  # noqa: BLE001 — surfaced as the requirement's failure
        return b"".join(chunks).decode("utf-8", "replace"), str(e)
    return b"".join(chunks).decode("utf-8", "replace"), None


def _levels(requirements: list[Requirement]) -> list[list[str]]:
    """Requirement ids grouped by depth, parents before children.

    A requirement whose parent is missing is a root, so an orphan is still
    tested rather than silently dropped from the run.
    """
    by_id = {r.id: r for r in requirements}
    depth: dict[str, int] = {}

    def _depth(req_id: str, seen: frozenset) -> int:
        if req_id in depth:
            return depth[req_id]
        req = by_id[req_id]
        parent = req.parent
        # A cycle (or a self-parent) cannot deepen forever — treat it as a root.
        if not parent or parent not in by_id or parent in seen:
            depth[req_id] = 0
        else:
            depth[req_id] = _depth(parent, seen | {req_id}) + 1
        return depth[req_id]

    for req in requirements:
        _depth(req.id, frozenset())

    levels: list[list[str]] = []
    for req in requirements:
        d = depth[req.id]
        while len(levels) <= d:
            levels.append([])
        levels[d].append(req.id)
    return levels


async def _run_one(
    svc, run: TestRun, req: Requirement, target: _Target, timeout: int, on_change
) -> None:
    result = run.results[req.id]
    result.verdict = VERDICT_RUNNING
    await on_change()

    output, error = await _exec_in_deployment(
        svc, target.deployment_id, target.command, timeout
    )
    if error:
        result.verdict = VERDICT_FAIL
        result.output = f"{error}\n\n{output}".strip()
    else:
        parsed = parse_report(target.framework, output)
        verdict, detail = verdict_for_requirement(req.id, parsed)
        result.verdict = verdict
        if verdict == VERDICT_FAIL and parsed.suite_error:
            detail = detail + runner_hint(req.runner or "", target.framework)
        result.output = detail
    await on_change()


async def _run_group(svc, run, group, timeout, on_change) -> None:
    """One deployment's requirements, sequentially — a single container should
    not be running several test processes at once."""
    for req, target in group:
        await _run_one(svc, run, req, target, timeout, on_change)


def _selection(
    requirements: list[Requirement],
    run: TestRun,
    only_ids: set[str] | None,
    failed_only: bool,
) -> set[str]:
    """Which requirements this run actually executes.

    A subset run still picks up anything we have no verdict for at all —
    otherwise "re-run failed" would leave a brand-new requirement sitting in
    `queued` forever and the gate could never go green.
    """
    known = {r.id for r in requirements}
    if only_ids:
        selected = {i for i in only_ids if i in known}
    elif failed_only:
        selected = {
            r.id
            for r in requirements
            if run.results.get(r.id)
            and run.results[r.id].previous_verdict == VERDICT_FAIL
        }
    else:
        return known
    for r in requirements:
        existing = run.results.get(r.id)
        if existing is None or not existing.previous_verdict:
            selected.add(r.id)
    return selected


async def execute_run(
    copy: str | None,
    bp: str,
    only_ids: set[str] | None = None,
    failed_only: bool = False,
) -> TestRun:
    """Run the BP's requirement tests and record every verdict on the run."""
    from app.dependencies import get_automation_service
    from app.services.bp_git import bp_clone_path

    clone = bp_clone_path(copy, bp)
    sha, subject, tree = await head_state(clone)
    run = test_run_manager.start(copy, bp, sha, subject, tree)

    async def on_change():
        await broadcast_test_state(run)

    try:
        requirements = read_requirements(copy, bp)
        cfg = read_testing_config(copy, bp)
    except ValueError as e:
        test_run_manager.finish(run, RUN_FAILED, str(e))
        await on_change()
        return run

    selected = _selection(requirements, run, only_ids, failed_only)

    # Seed every row: selected ones queue up, the rest keep the verdict they
    # already had so a subset re-run does not blank the table.
    for req in requirements:
        existing = run.results.get(req.id)
        carried = existing.previous_verdict if existing else ""
        result = RequirementResult(
            id=req.id,
            description=req.description,
            origin=req.origin,
            verdict=VERDICT_QUEUED
            if req.id in selected
            else (carried or VERDICT_QUEUED),
            previous_verdict=carried,
            previous_sha=existing.previous_sha if existing else "",
        )
        run.results[req.id] = result

    if not requirements:
        test_run_manager.finish(run, RUN_COMPLETED)
        await on_change()
        return run

    svc = get_automation_service()
    members = svc.members_for_bp(bp, copy=copy, stage="live-dev")

    # Wake the live-dev group before exec'ing: an evicted instance would
    # otherwise 404 and every requirement would fail for the wrong reason.
    if members:
        try:
            await svc.wake_live_dev(members[0].get("context", ""), stage="live-dev")
        except Exception as e:  # noqa: BLE001 — a wake failure is not fatal yet
            logger.warning("wake before tests failed for %s/%s: %s", copy, bp, e)

    timeout = cfg.timeout or DEFAULT_TIMEOUT_SECONDS
    by_id = {r.id: r for r in requirements}
    targets: dict[str, _Target] = {}
    for req in requirements:
        targets[req.id] = resolve_target(req, cfg, members)

    await on_change()

    try:
        for level in _levels(requirements):
            groups: dict[str, list] = {}
            for req_id in level:
                if req_id not in selected:
                    continue
                req = by_id[req_id]
                result = run.results[req_id]

                parent = run.results.get(req.parent) if req.parent else None
                if parent is not None and parent.verdict != VERDICT_PASS:
                    # The parent is a precondition — running the child now
                    # would produce a result nobody could trust.
                    result.verdict = VERDICT_BLOCKED
                    result.output = (
                        f"not run: parent requirement {req.parent} is "
                        f"{parent.verdict}"
                    )
                    continue

                target = targets[req_id]
                if target.error:
                    result.verdict = VERDICT_FAIL
                    result.output = target.error
                    continue
                if not target.deployment_id:
                    # The BP has no automation to run anything in.
                    result.verdict = VERDICT_NO_TEST
                    continue

                result.deployment_id = target.deployment_id
                result.automation = target.automation
                groups.setdefault(target.deployment_id, []).append((req, target))

            await on_change()
            if groups:
                await asyncio.gather(
                    *[
                        _run_group(svc, run, group, timeout, on_change)
                        for group in groups.values()
                    ]
                )
    except asyncio.CancelledError:
        test_run_manager.finish(run, RUN_CANCELLED)
        raise
    except Exception as e:  # noqa: BLE001
        logger.exception("test run failed for %s/%s", copy, bp)
        test_run_manager.finish(run, RUN_FAILED, str(e))
        await on_change()
        return run

    test_run_manager.finish(run, RUN_COMPLETED)
    await on_change()
    return run


async def broadcast_test_state(run: TestRun) -> None:
    """Push the run to SSE subscribers. Best-effort: a notify failure must
    never turn into a test failure."""
    try:
        from app.event_broadcaster import event_broadcaster

        await event_broadcaster.broadcast("test_state", run.to_dict())
    except Exception as e:  # noqa: BLE001
        logger.debug("test_state broadcast failed: %s", e)


# Strong references to in-flight runs — prevents GC before completion.
_bg_tasks: set[asyncio.Task] = set()


def spawn_run(
    copy: str | None,
    bp: str,
    only_ids: set[str] | None = None,
    failed_only: bool = False,
) -> asyncio.Task:
    """Start (or restart) a run in the background.

    A run already in flight is cancelled first: a new commit supersedes the
    old one, and recording a verdict for code that is no longer HEAD is worse
    than recording none.
    """
    test_run_manager.cancel(copy, bp)

    async def _run():
        try:
            await execute_run(copy, bp, only_ids=only_ids, failed_only=failed_only)
        except asyncio.CancelledError:
            logger.info("test run superseded for %s/%s", copy, bp)
            raise

    task = asyncio.create_task(_run())
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)
    test_run_manager.register_task(copy, bp, task)
    return task


async def current_state(copy: str | None, bp: str) -> dict | None:
    """The run's state with staleness computed against the tree right now."""
    run = test_run_manager.get(copy, bp)
    if run is None:
        return None
    from app.services.bp_git import bp_clone_path

    tree = await working_tree_sha(bp_clone_path(copy, bp))
    stale = bool(run.tree_sha) and bool(tree) and tree != run.tree_sha
    return run.to_dict(stale=stale)


async def is_green_for(copy: str | None, bp: str, sha: str | None = None) -> bool:
    """Gate predicate: a completed, non-stale, clean run for `sha`."""
    run = test_run_manager.get(copy, bp)
    if run is None or not run.is_green():
        return False
    if sha and run.head_sha != sha:
        return False
    state = await current_state(copy, bp)
    return bool(state and not state["stale"])
