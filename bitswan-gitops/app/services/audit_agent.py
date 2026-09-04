"""The temporary coding agent an auditor gets while staging is frozen.

The workspace's own coding agent works in a member's copy and can change it.
An audit needs the opposite: an agent that can read one pinned version and the
diff that promoting it would apply to production, and can write exactly one
thing — the report. So it is a second, temporary container, brought up when
staging is frozen and taken away when it is not, on the same isolated agent
bridge the workspace agent sits on.

The container itself is the daemon's to run (it owns docker), so this module is
the request: gitops asks over the trusted local socket. A daemon that does not
know the endpoint yet answers 404, and the state we report then says the
environment is there but the agent is not — which is the truth, and lets the
files/diff/report surface work regardless.
"""

import logging

from app.utils import _ingress_client_and_base

logger = logging.getLogger(__name__)


def container_name(workspace: str, bp: str, sha: str) -> str:
    return f"{workspace}-{bp}-audit-{(sha or '')[:8]}"


def _post(path: str, payload: dict) -> dict:
    client, base = _ingress_client_and_base()
    try:
        resp = client.post(f"{base}{path}", json=payload)
        if resp.status_code == 404:
            return {
                "running": False,
                "reason": "this daemon has no audit-agent endpoint",
            }
        resp.raise_for_status()
        return resp.json() or {}
    finally:
        client.close()


def _get(path: str, params: dict) -> dict:
    client, base = _ingress_client_and_base()
    try:
        resp = client.get(f"{base}{path}", params=params)
        if resp.status_code == 404:
            return {
                "running": False,
                "reason": "this daemon has no audit-agent endpoint",
            }
        resp.raise_for_status()
        return resp.json() or {}
    finally:
        client.close()


def start_audit_agent(workspace: str, bp: str, sha: str) -> dict:
    """Ask the daemon for the audit agent. Never raises: the audit environment
    is useful without it, and a caller mid-freeze must not fail on it."""
    if not workspace or not sha:
        return {"running": False, "reason": "no frozen image"}
    try:
        return _post(
            "/audit-agent/start",
            {"workspace": workspace, "bp": bp, "sha": sha},
        )
    except Exception as e:
        logger.warning("audit agent for %s@%s did not start: %s", bp, sha[:8], e)
        return {"running": False, "reason": str(e)[:200]}


def stop_audit_agent(workspace: str, bp: str, sha: str) -> dict:
    if not workspace or not sha:
        return {"running": False}
    try:
        return _post(
            "/audit-agent/stop", {"workspace": workspace, "bp": bp, "sha": sha}
        )
    except Exception as e:
        logger.warning("audit agent for %s@%s did not stop: %s", bp, sha[:8], e)
        return {"running": False, "reason": str(e)[:200]}


def audit_agent_state(workspace: str, bp: str, sha: str | None) -> dict:
    if not workspace or not sha:
        return {"running": False, "reason": "staging is not frozen"}
    try:
        state = _get("/audit-agent", {"workspace": workspace, "bp": bp, "sha": sha})
    except Exception as e:
        return {"running": False, "reason": str(e)[:200]}
    state.setdefault("name", container_name(workspace, bp, sha))
    return state
