import logging

logger = logging.getLogger(__name__)


def request_workspace_mirror_push(trigger: str, requester: str | None) -> None:
    try:
        from app.services import workspace_mirror

        workspace_mirror.request_push(trigger, requester)
    except Exception:
        logger.warning("could not schedule the workspace mirror push", exc_info=True)
