import asyncio
from contextlib import asynccontextmanager
import logging
import os
import threading

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler


from .dependencies import get_automation_service
from .deploy_manager import deploy_manager
from .snapshot_manager import snapshot_manager
from .event_broadcaster import event_broadcaster
from .services.process_service import process_service
from .routes.copies import refresh_copies

logger = logging.getLogger(__name__)


def _copies_dir() -> str:
    return os.environ.get("BITSWAN_COPIES_DIR", "/copies")


async def _broadcast_processes() -> None:
    """Push the current `processes` snapshot over the SSE feed.

    Consumed by the workspace dashboard so it never has to walk the
    filesystem itself. Driven from both `WorkspaceChangeHandler` (main repo)
    and `CopyChangeHandler` (per-copy).
    """
    try:
        await event_broadcaster.broadcast(
            "processes", process_service.get_all_processes()
        )
    except Exception as e:
        logger.warning("Failed to broadcast processes: %s", e)


async def _broadcast_copies() -> None:
    """Push the current `copies` snapshot over the SSE feed.

    Carries the same payload as `GET /copies/`. Driven by
    `CopyChangeHandler` so the dashboard never has to poll.
    """
    try:
        copies = await refresh_copies()
        await event_broadcaster.broadcast("copies", copies)
    except Exception as e:
        logger.warning("Failed to broadcast copies: %s", e)


async def _broadcast_automations() -> None:
    """Push the current `automations` snapshot over the SSE feed.

    Driven by the filesystem watchers (when `bitswan.yaml` or any
    `automation.toml` changes) and by the Docker event watcher. Reads from
    `AutomationService.get_automations()` which now consults the scope-keyed
    cache and overlays live Docker state on read.
    """
    try:
        automations = await get_automation_service().get_automations()
        data = [
            a.model_dump(mode="json") if hasattr(a, "model_dump") else a
            for a in automations
        ]
        await event_broadcaster.broadcast("automations", data)
    except Exception as e:
        logger.warning("Failed to broadcast automations: %s", e)


class WorkspaceChangeHandler(FileSystemEventHandler):
    """Handle file system changes in the workspace directory.

    Two parallel pipelines:
      - process refresh (`process.toml` create/delete/move, plus directory
        events that add/remove BPs).
      - automation refresh (`automation.toml` / `bitswan.yaml` changes).

    Both share the same coarse "anything happened" trigger for create/
    delete/move events, since those almost always coincide with BP or
    automation creation. `on_modified` is filtered by basename so editing
    a python file inside an automation doesn't fire either refresh.
    """

    def __init__(self, event_loop):
        super().__init__()
        self.event_loop = event_loop
        self.update_scheduled = False
        self.update_lock = threading.Lock()
        self.automations_scheduled = False
        self.automations_lock = threading.Lock()

    def schedule_update(self):
        """Schedule a process-cache refresh + broadcast (debounced 500ms)."""
        with self.update_lock:
            if self.update_scheduled:
                return
            self.update_scheduled = True

        async def delayed_update():
            await asyncio.sleep(0.5)  # debounce 500ms for bursts
            try:
                # Refresh the main-repo BP cache before downstream consumers
                # read from it.
                process_service.refresh(None)
                await _broadcast_processes()
            except Exception as e:
                logger.warning("Error publishing processes: %s", e)
            finally:
                with self.update_lock:
                    self.update_scheduled = False

        asyncio.run_coroutine_threadsafe(delayed_update(), self.event_loop)

    def schedule_automations_update(self):
        """Schedule an automation-cache refresh + broadcast (debounced 500ms).

        Runs independently of the process pipeline so concurrent events don't
        clobber each other. `refresh_all` is cheap (single bitswan.yaml read
        + per-scope filesystem scan).
        """
        with self.automations_lock:
            if self.automations_scheduled:
                return
            self.automations_scheduled = True

        async def delayed_update():
            await asyncio.sleep(0.5)
            try:
                await get_automation_service().refresh_all()
                await _broadcast_automations()
            except Exception as e:
                logger.warning("Error refreshing automations: %s", e)
            finally:
                with self.automations_lock:
                    self.automations_scheduled = False

        asyncio.run_coroutine_threadsafe(delayed_update(), self.event_loop)

    def on_created(self, event):
        self.schedule_update()
        self.schedule_automations_update()

    def on_deleted(self, event):
        self.schedule_update()
        self.schedule_automations_update()

    def on_moved(self, event):
        self.schedule_update()
        self.schedule_automations_update()

    def on_modified(self, event):
        src = getattr(event, "src_path", "") or ""
        if src.endswith("process.toml"):
            self.schedule_update()
        if src.endswith("automation.toml") or src.endswith("bitswan.yaml"):
            self.schedule_automations_update()


class CopyChangeHandler(FileSystemEventHandler):
    """Watch copy directories for file changes and broadcast via SSE.

    Narrowly filtered so editing code inside an automation doesn't fire any
    refresh — only events that meaningfully change the state we publish:
      - copies-list ping: events at the copies root (copy added /
        removed), or events under a copy's `.git/` (commit detection,
        which flips `synced` / `commit_hash`).
      - per-copy process refresh: `process.toml` events.
      - per-copy automation refresh: `automation.toml` events.
      - per-copy automation refresh-all on `bitswan.yaml` events
        (defensive — bitswan.yaml normally lives at the gitops root, not
        inside a copy).

    The copy name is derived from the event path so we only re-scan the
    affected scope.
    """

    # Path-suffix markers that flip git state we publish — commits, index
    # writes, branch tip moves. Anything else under `.git/` (e.g. pack file
    # housekeeping) is ignored.
    _GIT_STATE_SUFFIXES = ("/.git/HEAD", "/.git/index", "/.git/ORIG_HEAD")
    _GIT_REFS_SEGMENT = "/.git/refs/heads/"

    def __init__(self, event_loop, copies_root: str):
        super().__init__()
        self.event_loop = event_loop
        # Root of the per-copy clones (${BITSWAN_COPIES_DIR}, default /copies).
        # The `main` copy is the default-branch / main scope (keyed None).
        self.copies_root = os.path.realpath(copies_root)
        # Per-copy debounce timers, one set per refresh pipeline.
        self._process_tasks: dict[str | None, asyncio.Task] = {}
        self._automation_tasks: dict[str | None, asyncio.Task] = {}
        # Single timer for the "ping" copies-list broadcast.
        self._copy_ping_task: asyncio.Task | None = None

    def _copy_from_path(self, path: str) -> str | None:
        """Return the name of the copy containing `path`, or None when the
        event is at the copies root (e.g. a copy being added / removed) or
        within the `main` copy (the main scope is keyed None everywhere)."""
        try:
            rel = os.path.relpath(os.path.realpath(path), self.copies_root)
        except ValueError:
            return None
        if rel == "." or rel.startswith(".."):
            return None
        parts = rel.replace("\\", "/").split("/")
        if len(parts) <= 1:
            return None
        first = parts[0]
        # The `main` copy is the unprefixed/None scope.
        if first == "main":
            return None
        return first or None

    def _is_git_state_change(self, path: str) -> bool:
        """True for paths whose change can flip `synced` / `commit_hash`."""
        if not path:
            return False
        norm = path.replace("\\", "/")
        if norm.endswith(self._GIT_STATE_SUFFIXES):
            return True
        return self._GIT_REFS_SEGMENT in norm

    def _schedule_copies_ping(self):
        """Refresh the cached copy list and broadcast it over SSE."""

        async def _broadcast():
            await asyncio.sleep(1)
            await _broadcast_copies()

        def _run():
            if self._copy_ping_task and not self._copy_ping_task.done():
                self._copy_ping_task.cancel()
            self._copy_ping_task = asyncio.ensure_future(_broadcast())

        self.event_loop.call_soon_threadsafe(_run)

    def _schedule_process_refresh(self, copy: str | None):
        """Debounced refresh + SSE broadcast for one copy's BP cache.

        `copy=None` means the event hit the copies root itself — a
        copy was probably added or removed. Refresh the full set so the
        cache reflects the new shape, then broadcast.
        """

        async def _refresh():
            await asyncio.sleep(0.5)
            try:
                if copy is None:
                    process_service.refresh_all()
                else:
                    if os.path.isdir(os.path.join(self.copies_root, copy)):
                        process_service.refresh(copy)
                    else:
                        process_service.forget_copy(copy)
                await _broadcast_processes()
            except Exception as e:
                logger.warning(
                    "Failed to refresh copy processes (%s): %s",
                    copy or "<root>",
                    e,
                )

        def _run():
            existing = self._process_tasks.get(copy)
            if existing and not existing.done():
                existing.cancel()
            self._process_tasks[copy] = asyncio.ensure_future(_refresh())

        self.event_loop.call_soon_threadsafe(_run)

    def _schedule_automations_refresh(self, copy: str | None):
        """Debounced refresh + SSE broadcast for one copy's automation cache."""

        async def _refresh():
            await asyncio.sleep(0.5)
            try:
                svc = get_automation_service()
                if copy is None:
                    await svc.refresh_all()
                else:
                    if os.path.isdir(os.path.join(self.copies_root, copy)):
                        await svc.refresh(copy)
                    else:
                        svc.forget_copy(copy)
                await _broadcast_automations()
            except Exception as e:
                logger.warning(
                    "Failed to refresh copy automations (%s): %s",
                    copy or "<root>",
                    e,
                )

        def _run():
            existing = self._automation_tasks.get(copy)
            if existing and not existing.done():
                existing.cancel()
            self._automation_tasks[copy] = asyncio.ensure_future(_refresh())

        self.event_loop.call_soon_threadsafe(_run)

    def _handle(self, event):
        src = getattr(event, "src_path", "") or ""
        copy = self._copy_from_path(src) if src else None
        basename = os.path.basename(src)

        # 1. Copy-list ping: only on root events (add/remove) or git
        #    state changes (commit, index write, ref update) — NOT on every
        #    code edit inside a copy.
        if copy is None or self._is_git_state_change(src):
            self._schedule_copies_ping()

        # 2. Copy directory itself appearing / disappearing → full
        #    refresh of both pipelines so the new scope is picked up (or
        #    stale scope dropped).
        if copy is None:
            self._schedule_process_refresh(None)
            self._schedule_automations_refresh(None)
            return

        # 3. Targeted refresh by file basename. Skip everything else (code
        #    edits, asset writes, etc.) to keep noise off the SSE feed.
        if basename == "process.toml":
            self._schedule_process_refresh(copy)
        if basename == "automation.toml":
            self._schedule_automations_refresh(copy)
        if basename == "bitswan.yaml":
            # bitswan.yaml normally lives at the gitops root, not under a
            # copy, but treat any in-copy occurrence as a global
            # automation-state change.
            self._schedule_automations_refresh(None)

    def on_created(self, event):
        self._handle(event)

    def on_deleted(self, event):
        self._handle(event)

    def on_modified(self, event):
        self._handle(event)

    def on_moved(self, event):
        self._handle(event)


async def _broadcast_automations_after_delay():
    """Debounced broadcast of automation state after Docker events settle.

    Cache is unchanged here — `get_automations()` overlays live Docker state
    on the static cache on every call, so a Docker event just needs to
    trigger a re-broadcast.
    """
    await asyncio.sleep(0.5)
    await _broadcast_automations()


async def _watch_container_events() -> None:
    """Re-broadcast automation state whenever a workspace container comes up,
    goes away, or flips health — driven by the infra-driver's Docker event
    stream.

    After the infra-driver cut-over gitops has no Docker socket of its own, so
    this stream is its ONLY live signal of container-state changes. Without it
    the dashboard's automation / environment panels go stale until the next
    deploy or file edit (the bug where a freshly-deployed frontend's link never
    appears because the container finished starting *after* the deploy's
    refresh_all). The driver scopes the stream to this workspace.

    A single debouncer coalesces the burst of events a deploy produces into one
    re-broadcast; `get_automations()` reads live state fresh, so one delayed
    broadcast captures the settled state. Reconnects if the stream drops (driver
    restart / sidecar redeploy) — the backoff is connection recovery, not a
    state poll.
    """
    from app.services.infra_driver_client import (
        InfraDriverClient,
        WorkspaceContext,
    )

    workspace = os.environ.get("BITSWAN_WORKSPACE_NAME", "")
    client = InfraDriverClient()
    ctx = WorkspaceContext(
        workspace_name=workspace, domain="", gitops_dir="", secrets_dir=""
    )

    dirty = asyncio.Event()

    async def debouncer() -> None:
        while True:
            await dirty.wait()
            dirty.clear()
            await _broadcast_automations_after_delay()

    async def on_event(_ev: dict) -> None:
        dirty.set()

    debounce_task = asyncio.create_task(debouncer())
    backoff = 1.0
    try:
        while True:
            try:
                await client.container_events(ctx, on_event)
                # Clean end (server closed the stream) — reconnect promptly.
                backoff = 1.0
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(
                    "container-events stream dropped, reconnecting in %.0fs: %s",
                    backoff,
                    e,
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)
    finally:
        debounce_task.cancel()


def _start_profiling():
    """Start yappi async-aware profiler if BITSWAN_PROFILING is set.

    Returns a dump callable (also wired to SIGUSR1) or None when disabled.
    Re-evaluated on every lifespan startup so hot-reload picks up env changes.
    """
    enabled = os.environ.get("BITSWAN_PROFILING", "").lower() in ("1", "true", "yes")
    if not enabled:
        return None

    import yappi
    import datetime
    import signal

    workspace_dir = os.environ.get("BITSWAN_WORKSPACE_REPO_DIR", "/workspace-repo")
    profiling_dir = os.path.join(workspace_dir, "profiling")
    os.makedirs(profiling_dir, exist_ok=True)

    # Stop any leftover session from a previous reload before starting fresh.
    yappi.stop()
    prior_stats = yappi.get_func_stats()
    if not prior_stats.empty():
        ts = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        prior_path = os.path.join(profiling_dir, f"profile_{ts}.pstat")
        prior_stats.save(prior_path, type="pstat")
        logger.info("Saved previous profiling session to %s", prior_path)
    yappi.clear_stats()
    yappi.set_clock_type("wall")
    yappi.start(builtins=False)
    logger.info("=" * 60)
    logger.info("  PROFILING ACTIVE (yappi, wall-clock, asyncio-aware)")
    logger.info("  Output: %s", profiling_dir)
    logger.info("  Dump now: kill -USR1 %d", os.getpid())
    logger.info("=" * 60)

    def dump_profile(sig=None, frame=None):
        ts = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        path = os.path.join(profiling_dir, f"profile_{ts}.pstat")
        yappi.get_func_stats().save(path, type="pstat")
        logger.info("Profile written to %s", path)

    # SIGUSR1 → on-demand snapshot without stopping the server.
    signal.signal(signal.SIGUSR1, dump_profile)

    return dump_profile


@asynccontextmanager
async def lifespan(app: FastAPI):
    observer = None
    copy_observer = None
    dump_profile = _start_profiling()

    scheduler = AsyncIOScheduler(timezone="UTC")

    # Ensure the canonical bare repo exists and is fast-forward-only before the
    # smart-HTTP git server starts serving clones/pushes. Idempotent.
    try:
        from app.services.git_server import ensure_bare_repo

        await ensure_bare_repo()
    except Exception as e:
        logger.warning("Failed to ensure canonical bare repo: %s", e)

    # Warm the ProcessService cache so the first `_broadcast_processes`
    # (SSE) read finds it populated.
    process_service.refresh_all()

    # Warm the AutomationService scope-keyed cache. Cheap (filesystem
    # scan + bitswan.yaml read) and means the first GET /automations/
    # or SSE consumer doesn't pay for an inline `refresh_all()`.
    try:
        await get_automation_service().refresh_all()
    except Exception as e:
        logger.warning("Initial automations cache warm failed: %s", e)

    # Warm the copy-list cache so the first SSE consumer doesn't
    # pay the git-cost of an initial scan.
    try:
        await refresh_copies()
    except Exception as e:
        logger.warning("Initial copies cache warm failed: %s", e)

    # Set up file system watcher for workspace directory
    workspace_dir = os.environ.get("BITSWAN_WORKSPACE_REPO_DIR", "/workspace-repo")
    if os.path.exists(workspace_dir):
        event_handler = WorkspaceChangeHandler(asyncio.get_event_loop())
        observer = Observer()
        observer.schedule(event_handler, workspace_dir, recursive=True)
        observer.start()
        print(f"Started watching workspace directory: {workspace_dir}")

        # Watch the per-copy clones for file changes → SSE push.
        # Create the directory first so a fresh deployment (where the copies
        # dir doesn't exist yet) still gets a watcher attached. Without this
        # the first copy created has no listener, the cache stays empty, and
        # `GET /copies/` keeps returning [] until gitops restarts. The
        # recursive watcher on `workspace_dir` doesn't help —
        # `WorkspaceChangeHandler` only refreshes automations/processes, not
        # the copies list cache.
        # Guarded by the workspace-dir check: this used to live behind the
        # MQTT-connected branch, so it was skipped where there's no workspace
        # repo (e.g. tests); keep that behaviour now that MQTT is gone.
        copies_dir = _copies_dir()
        os.makedirs(copies_dir, exist_ok=True)
        copy_handler = CopyChangeHandler(asyncio.get_event_loop(), copies_dir)
        copy_observer = Observer()
        copy_observer.schedule(copy_handler, copies_dir, recursive=True)
        copy_observer.start()
        print(f"Started watching copies directory: {copies_dir}")
    else:
        print(f"Workspace directory does not exist: {workspace_dir}")

    # Clean up completed/failed deploy tasks every 10 minutes
    scheduler.add_job(
        deploy_manager.cleanup_old_tasks,
        trigger="interval",
        minutes=10,
        name="cleanup_deploy_tasks",
    )

    # Same for snapshot tasks
    scheduler.add_job(
        snapshot_manager.cleanup_old_tasks,
        trigger="interval",
        minutes=10,
        name="cleanup_snapshot_tasks",
    )

    # Daily backup at 2 AM UTC (if configured)
    async def _scheduled_backup():
        from app.services.backup_service import (
            get_backup_config,
            get_restic_key,
            run_backup,
        )

        config = get_backup_config()
        if not config or not get_restic_key():
            return  # Not configured, skip
        try:
            await run_backup(config)
            print("Scheduled backup completed successfully")
        except Exception as e:
            print(f"Scheduled backup failed: {e}")

    scheduler.add_job(
        _scheduled_backup,
        trigger="cron",
        hour=2,
        minute=0,
        name="daily_backup",
    )

    # Daily supply-chain re-scan at 3 AM UTC: refresh grype's vuln DB and re-run
    # it against every deployed image's cached SBOM so newly-disclosed CVEs against
    # unchanged images surface without a rebuild.
    async def _scheduled_supply_chain_scan():
        from app.dependencies import get_automation_service

        try:
            await get_automation_service().rescan_deployed_images()
        except Exception as e:
            print(f"Scheduled supply-chain scan failed: {e}")

    scheduler.add_job(
        _scheduled_supply_chain_scan,
        trigger="cron",
        hour=3,
        minute=0,
        name="daily_supply_chain_scan",
    )

    scheduler.start()

    # Warm the history cache in the background so first requests are fast
    _cache_task = asyncio.create_task(get_automation_service().warm_history_cache())
    _cache_task.add_done_callback(
        lambda t: (
            logger.warning("warm_history_cache failed: %s", t.exception())
            if not t.cancelled() and t.exception()
            else None
        )
    )

    # Pre-warm the grype vulnerability DB in the background. A fresh gitops image
    # ships without it (downloaded at runtime), so without this the FIRST
    # supply-chain scan after a deploy pays the multi-second DB download — the
    # main reason Checks used to sit "scanning" for a while. Doing it at startup
    # means the DB is usually ready before the first deploy's scan runs.
    from app.services import supply_chain_service

    _db_task = asyncio.create_task(supply_chain_service.ensure_vuln_db())
    _db_task.add_done_callback(
        lambda t: (
            logger.warning("grype DB pre-warm failed: %s", t.exception())
            if not t.cancelled() and t.exception()
            else None
        )
    )

    # React to container state changes (start / die / health) by re-broadcasting
    # automation state. This is gitops's live signal post-cut-over — it has no
    # Docker socket, so it watches the infra-driver's event stream instead.
    _events_task = asyncio.create_task(_watch_container_events())
    _events_task.add_done_callback(
        lambda t: (
            logger.warning("container-events watcher exited: %s", t.exception())
            if not t.cancelled() and t.exception()
            else None
        )
    )

    # Bridge the git task queue onto the SSE feed: forward every queue change to
    # the existing /events/stream as a `task_queue` event, so the dashboard's
    # activity log renders the queue on the connection it already holds.
    from app.task_queue import task_queue
    from app.event_broadcaster import event_broadcaster

    async def _relay_task_queue():
        q = task_queue.subscribe()
        try:
            while True:
                payload = await q.get()
                await event_broadcaster.broadcast("task_queue", payload)
        finally:
            task_queue.unsubscribe(q)

    queue_relay = asyncio.create_task(_relay_task_queue())

    # Container-state changes reach gitops two ways: explicit refresh_all() on
    # each deploy/stop/restart, and — because gitops has no Docker socket after
    # the cut-over — the infra-driver's Docker event stream (see
    # _watch_container_events above). The filesystem watcher covers bitswan.yaml
    # / automation.toml edits.
    try:
        yield
    finally:
        _events_task.cancel()
        queue_relay.cancel()
        if observer:
            observer.stop()
            # Run blocking join in executor to avoid blocking event loop
            await asyncio.to_thread(observer.join)
        if copy_observer:
            copy_observer.stop()
            await asyncio.to_thread(copy_observer.join)

        if dump_profile is not None:
            dump_profile()
