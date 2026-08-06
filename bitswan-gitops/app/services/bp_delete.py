"""Orchestrators for the two destructive delete flows: a whole business
process, and a whole copy.

Both run as `task_queue` tasks (fire-and-forget from the DELETE routes, which
answer 202 + task_id) so they serialize with every other git-mutating
operation and their progress/attribution rides the queue's event relay.

Design rules shared by both flows:

- **Containers stop before state**: nothing keeps serving mid-teardown.
- **Deploy state is emptied, not erased**: the BP's slice in
  ``gitops/bp/<bp>/bitswan.yaml`` is rewritten (empty for a BP delete) via
  ``_persist_bp_state`` and PUSHED so the driver's reconcile prunes routes and
  any surviving containers. The per-BP deploy repo and its git history are
  deliberately KEPT as the audit trail — same for snapshots and backups.
- **Best-effort continue**: each step records "ok" | "skipped: …" |
  "error: …" into a results dict; a failed step never aborts the rest (an
  aborted teardown leaves strictly more garbage than a continued one). The
  task fails when anything errored, and re-issuing the DELETE re-runs the
  whole sequence — every primitive tolerates "already gone", and the routes'
  remnant-based 404 rule means a half-deleted BP/copy is still deletable.
- **The bare repo (or copy branch) goes LAST** so no concurrent
  ensure/rebase/create can re-materialize the target mid-delete.
"""

import logging
import os

from app.services import bp_databases, bp_git, git_server
from app.services.bp_secrets import delete_bp_secret_files
from app.services.firewall_service import delete_bp_attempt_logs
from app.services.process_service import process_service
from app.utils import (
    deployment_bp,
    read_bitswan_yaml,
    sanitize_automation_name,
)

logger = logging.getLogger(__name__)

# Persisted stage "" means production (deploy_automation maps it).
PROTECTED_STAGES = ("staging", "production")


def _stage_of(conf: dict) -> str:
    return (conf or {}).get("stage") or "production"


def bp_deployments(bs_yaml: dict | None, slug: str) -> dict[str, dict]:
    """Every deployment entry belonging to a BP (main + all copies, all
    stages), keyed by deployment_id."""
    want = sanitize_automation_name(slug)
    return {
        did: (conf or {})
        for did, conf in ((bs_yaml or {}).get("deployments") or {}).items()
        if deployment_bp(conf or {}) == want
    }


def protected_deployments(bs_yaml: dict | None, slug: str) -> list[dict]:
    """The staging/production deployments that make a BP delete refuse (the
    guard): the user must tear those stages down explicitly first."""
    return [
        {"deployment_id": did, "stage": _stage_of(conf)}
        for did, conf in bp_deployments(bs_yaml, slug).items()
        if _stage_of(conf) in PROTECTED_STAGES
    ]


def copies_with_bp(slug: str) -> list[str]:
    """Copies (including "main") whose tree contains the BP's directory.
    A plain isdir test, not list_bp_clones — a half-deleted clone without a
    .git must still count as a remnant."""
    out: list[str] = []
    cd = bp_git.copies_dir()
    if not os.path.isdir(cd):
        return out
    for entry in sorted(os.listdir(cd)):
        if entry.startswith("."):
            continue
        if os.path.isdir(os.path.join(cd, entry, slug)):
            out.append(entry)
    return out


def bp_has_remnants(bs_yaml: dict | None, slug: str) -> bool:
    """Anything at all left of a BP? (Route 404 rule: only a fully-absent BP
    404s, so re-running a partially-failed delete finishes the job.)"""
    if bp_deployments(bs_yaml, slug):
        return True
    if copies_with_bp(slug):
        return True
    try:
        if os.path.isdir(git_server.bp_bare_repo_path(slug)):
            return True
    except ValueError:
        pass
    registry = bp_databases.load_registry()
    return (
        bp_databases.get_bp_entry(registry, sanitize_automation_name(slug)) is not None
    )


def copy_deployments(bs_yaml: dict | None, name: str) -> dict[str, dict]:
    """Every deployment entry living in a copy (its live-dev members)."""
    out: dict[str, dict] = {}
    for did, conf in ((bs_yaml or {}).get("deployments") or {}).items():
        conf = conf or {}
        _, copy = bp_databases.derive_bp_and_copy(conf.get("relative_path"))
        if copy == name:
            out[did] = conf
    return out


async def copy_has_remnants(bs_yaml: dict | None, name: str) -> bool:
    """Anything at all left of a copy? Dir, yaml entries, or a branch in any
    BP bare repo (branches outlive clones removed from the copy dir)."""
    if os.path.isdir(os.path.join(bp_git.copies_dir(), name)):
        return True
    if copy_deployments(bs_yaml, name):
        return True
    from app.utils import call_git_command_with_output

    for bp in git_server.list_bp_repos():
        _, _, rc = await call_git_command_with_output(
            "git",
            "-C",
            git_server.bp_bare_repo_path(bp),
            "show-ref",
            "--verify",
            "-q",
            f"refs/heads/{name}",
        )
        if rc == 0:
            return True
    return False


async def _remove_deployment_containers(service, deployment_id: str) -> None:
    """Remove a deployment's containers directly (delete flow). Not
    `_evict_instance_deployment`: that marks the entry inactive first, which
    is one extra per-member commit — and a KeyError when the entry is already
    gone on a delete re-run. Here the entries are popped + persisted in one
    commit right after, which excludes them from the compiler the same way."""
    ctx = service._workspace_ctx()
    for c in await service.get_container(deployment_id):
        cid = c.get("Id")
        if cid:
            await service.infra_driver.container_remove(ctx, cid)


async def _remove_gateways(service, bs_yaml_fresh: dict | None, groups) -> None:
    """Tear down the shared egress gateway/proxy of each (context, stage)
    group, guarded exactly like evict_deployments: only when no active member
    remains in the fresh yaml (defense against racing deploys)."""
    fresh = (bs_yaml_fresh or {}).get("deployments") or {}
    for context, stage in sorted(groups):
        if not context:
            continue
        if any(
            (c or {}).get("context") == context
            and ((c or {}).get("stage") or "") == stage
            and (c or {}).get("active") is not False
            for c in fresh.values()
        ):
            continue
        try:
            await service._remove_group_gateway(context, stage)
        except Exception as e:  # noqa: BLE001 — teardown is best-effort
            logger.warning("gateway teardown for %s/%s failed: %s", context, stage, e)


def _unlink_lru_markers(service, contexts) -> None:
    for context in contexts:
        if not context:
            continue
        try:
            os.unlink(
                os.path.join(
                    service._live_dev_access_dir(),
                    sanitize_automation_name(context),
                )
            )
        except OSError:
            pass


async def _broadcast_all(service, forget_copy: str | None = None) -> None:
    """Refresh every cache the delete touched and push fresh snapshots to the
    SSE stream — the dashboard's lists are SSE-driven, so this is what makes
    the deleted BP/copy disappear from the UI (the FS watcher would get there
    eventually; this makes it deterministic)."""
    from app.event_broadcaster import event_broadcaster

    # Lazy import: routes.copies imports service modules; importing it at
    # module scope from here would be circular once the routes import us.
    from app.routes.copies import refresh_copies

    if forget_copy:
        try:
            process_service.forget_copy(forget_copy)
        except Exception:
            logger.exception("process_service.forget_copy failed")
        try:
            service.forget_copy(forget_copy)
        except Exception:
            logger.exception("automation forget_copy failed")
    try:
        process_service.refresh_all()
        await event_broadcaster.broadcast(
            "processes", process_service.get_all_processes()
        )
    except Exception:
        logger.exception("processes broadcast after delete failed")
    try:
        await event_broadcaster.broadcast("copies", await refresh_copies())
    except Exception:
        logger.exception("copies broadcast after delete failed")
    try:
        await service.refresh_all()
        automations = await service.get_automations()
        data = [
            a.model_dump(mode="json") if hasattr(a, "model_dump") else a
            for a in automations
        ]
        await event_broadcaster.broadcast("automations", data)
    except Exception:
        logger.exception("automations broadcast after delete failed")


def _finish(kind: str, target: str, results: dict[str, str]) -> dict:
    errors = {k: v for k, v in results.items() if v.startswith("error")}
    logger.info("%s %s: %s", kind, target, results)
    if errors:
        raise RuntimeError(
            f"{kind} {target} finished with {len(errors)} error(s): {errors} — "
            f"re-issue the delete to retry the failed steps"
        )
    return {"status": "success", "results": results}


async def delete_business_process(slug: str, deleted_by: str | None, service) -> dict:
    """Tear a BP down completely (guard already checked by the route):
    containers → deploy state (emptied + pushed) → gateways → databases →
    secrets/firewall logs → clones in every copy → bare repo. Keeps
    snapshots, backups and the per-BP deploy repo's history."""
    results: dict[str, str] = {}
    bp_key = sanitize_automation_name(slug)
    bs_yaml = read_bitswan_yaml(service.gitops_dir) or {}
    entries = bp_deployments(bs_yaml, slug)
    groups = {
        ((conf or {}).get("context") or "", (conf or {}).get("stage") or "")
        for conf in entries.values()
    }
    copies = copies_with_bp(slug)

    # 1. Containers first — nothing keeps serving while state unwinds.
    for did in sorted(entries):
        try:
            await _remove_deployment_containers(service, did)
            results[f"containers:{did}"] = "ok"
        except Exception as e:  # noqa: BLE001
            results[f"containers:{did}"] = f"error: {e}"

    # 2. Empty the BP's slice: deployments + firewall/backups/secrets keys.
    #    One commit; gitops/bp/<bp> history is the audit trail and stays.
    try:
        deployments = bs_yaml.get("deployments") or {}
        for did in entries:
            deployments.pop(did, None)
        for key in ("firewall", "backups", "secrets"):
            (bs_yaml.get(key) or {}).pop(bp_key, None)
        await service._persist_bp_state(
            bs_yaml,
            {bp_key},
            slug,
            "delete-bp",
            deployed_by=deleted_by,
            message=f"Delete business process {slug}",
        )
        results["deploy-state"] = "ok"
    except Exception as e:  # noqa: BLE001
        results["deploy-state"] = f"error: {e}"

    # 3. Shared egress gateways (guarded on the fresh yaml, post-pop).
    await _remove_gateways(service, read_bitswan_yaml(service.gitops_dir), groups)
    _unlink_lru_markers(service, (ctx for ctx, _ in groups))

    # 4. Push the emptied slice so the driver reconcile prunes routes (and any
    #    container step 1 missed).
    try:
        await service.push_bp_state(
            bp_key, f"delete business process {slug}", deleted_by
        )
        results["reconcile-push"] = "ok"
    except Exception as e:  # noqa: BLE001
        results["reconcile-push"] = f"error: {e}"

    # 5. Databases: per-BP namespaces (all realms + blue-green), then the
    #    per-(copy, BP) live-dev namespaces of every copy that carried it.
    results.update(await bp_databases.drop_bp_databases(service.workspace_name, bp_key))
    non_main = [c for c in copies if c != "main"]
    if non_main:
        for copy in non_main:
            results.update(
                await bp_databases.drop_copy_bp_databases(
                    service.workspace_name, copy, [bp_key]
                )
            )

    # 6. Secrets env files + firewall attempt logs.
    try:
        delete_bp_secret_files(service.secrets_dir, slug)
        results["secrets"] = "ok"
    except Exception as e:  # noqa: BLE001
        results["secrets"] = f"error: {e}"
    try:
        delete_bp_attempt_logs(bp_key)
        results["firewall-logs"] = "ok"
    except Exception as e:  # noqa: BLE001
        results["firewall-logs"] = f"error: {e}"

    # 7. Clones out of every copy (root-rm: live-dev containers write files
    #    uid 1000 can't unlink), then 8. the bare repo LAST — and only when
    #    NOTHING errored: the bare repo is the retry token. Removing it after
    #    a failed step would make the re-issued DELETE 404 on the remnant
    #    rule while leaked state (e.g. unpruned routes) survives.
    for copy in copies:
        gone = await bp_git.remove_bp_clone(None if copy == "main" else copy, slug)
        results[f"clone:{copy}"] = "ok" if gone else "error: directory survives"
    if any(v.startswith("error") for v in results.values()):
        results["bare-repo"] = "skipped: kept as the retry marker (a step errored)"
    else:
        try:
            git_server.delete_bp_bare_repo(slug)
            results["bare-repo"] = "ok"
        except Exception as e:  # noqa: BLE001
            results["bare-repo"] = f"error: {e}"

    await _broadcast_all(service)
    return _finish("delete-bp", slug, results)


async def delete_copy(name: str, deleted_by: str | None, service) -> dict:
    """Tear a whole copy down: its live-dev containers + gateways, its
    deployment entries (persisted + pushed per affected BP), its per-copy
    databases, its branch in EVERY BP bare repo, and its directory tree."""
    results: dict[str, str] = {}
    bs_yaml = read_bitswan_yaml(service.gitops_dir) or {}
    entries = copy_deployments(bs_yaml, name)
    groups = {
        ((conf or {}).get("context") or "", (conf or {}).get("stage") or "")
        for conf in entries.values()
    }
    copy_path = os.path.join(bp_git.copies_dir(), name)
    # BPs whose deploy-state slice mentions this copy — the only ones the driver
    # has anything to prune for. An experiment that never deployed anything has
    # none, and pushing a slice per checked-out BP would be ~20 driver
    # round-trips of pure no-op (minutes of teardown for nothing).
    deployed_bps = sorted(
        {deployment_bp(conf) for conf in entries.values() if deployment_bp(conf)}
    )
    # Every BP the copy carried: per-(copy, BP) databases can outlive a
    # deployment entry, so those are dropped on the wider set.
    affected_bps = sorted(
        set(deployed_bps)
        | {sanitize_automation_name(bp) for bp in bp_git.list_bp_clones(copy_path)}
    )

    # 1. Containers.
    for did in sorted(entries):
        try:
            await _remove_deployment_containers(service, did)
            results[f"containers:{did}"] = "ok"
        except Exception as e:  # noqa: BLE001
            results[f"containers:{did}"] = f"error: {e}"

    # 2. Pop the copy's entries; one persist covering every affected BP slice.
    try:
        deployments = bs_yaml.get("deployments") or {}
        for did in entries:
            deployments.pop(did, None)
        if entries:
            await service._persist_bp_state(
                bs_yaml,
                set(affected_bps),
                name,
                "delete-copy",
                deployed_by=deleted_by,
                message=f"Delete copy {name}",
            )
        results["deploy-state"] = "ok"
    except Exception as e:  # noqa: BLE001
        results["deploy-state"] = f"error: {e}"

    # 3. Gateways (guarded) + LRU markers.
    await _remove_gateways(service, read_bitswan_yaml(service.gitops_dir), groups)
    _unlink_lru_markers(service, (ctx for ctx, _ in groups))

    # 4. Push the slice of each BP this copy actually deployed in, so the driver
    #    prunes the copy's routes and containers there.
    for bp in deployed_bps:
        try:
            await service.push_bp_state(bp, f"delete copy {name}", deleted_by)
            results[f"reconcile-push:{bp}"] = "ok"
        except Exception as e:  # noqa: BLE001
            results[f"reconcile-push:{bp}"] = f"error: {e}"

    # 5. Per-(copy, BP) databases.
    if affected_bps:
        results.update(
            await bp_databases.drop_copy_bp_databases(
                service.workspace_name, name, affected_bps
            )
        )

    # 6. The copy's branch in EVERY bare repo — not just the BPs cloned in the
    #    dir; clone_bp_into_copy pushes branches that outlive removed clones.
    for bp in git_server.list_bp_repos():
        try:
            await git_server.delete_copy_branch(bp, name)
            results[f"branch:{bp}"] = "ok"
        except Exception as e:  # noqa: BLE001
            results[f"branch:{bp}"] = f"error: {e}"

    # 7. The copy tree itself (root-rm) — only when nothing errored: the dir
    #    is the retry token that keeps a re-issued DELETE past the remnant-404
    #    rule (same rationale as the BP delete's bare repo).
    if any(v.startswith("error") for v in results.values()):
        results["copy-dir"] = "skipped: kept as the retry marker (a step errored)"
    else:
        gone = await bp_git.remove_tree(copy_path)
        results["copy-dir"] = "ok" if gone else "error: directory survives"

    await _broadcast_all(service, forget_copy=name)
    return _finish("delete-copy", name, results)
