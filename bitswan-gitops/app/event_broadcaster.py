"""
Event broadcaster for SSE push updates.
Manages connected SSE clients and broadcasts Docker/image events.
"""

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)


class EventBroadcaster:
    def __init__(self):
        self._subscribers: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        # Generous headroom: a deploy/promote fires a burst (one automations
        # snapshot per container that comes up, plus task_queue + processes +
        # copies events), and each automations payload is sizeable. 32 was small
        # enough that a single promote could overrun a consumer mid-burst.
        queue: asyncio.Queue = asyncio.Queue(maxsize=512)
        self._subscribers.add(queue)
        logger.info("SSE client subscribed (total: %d)", len(self._subscribers))
        return queue

    def unsubscribe(self, queue: asyncio.Queue):
        self._subscribers.discard(queue)
        logger.info("SSE client unsubscribed (total: %d)", len(self._subscribers))

    async def broadcast(self, event_type: str, data: Any):
        msg = {"event": event_type, "data": data}
        for queue in self._subscribers:
            # NEVER drop a subscriber on a momentary burst — severing the feed
            # strands the dashboard on a stale snapshot until it reconnects (the
            # cause of "promoted but the stage still shows Not deployed": the
            # consumer was dropped at the exact moment the new containers came
            # up). If a consumer has fallen behind, evict its OLDEST queued
            # message to make room for the newest. Our events are full snapshots
            # (automations/processes/copies) and task_queue updates the dashboard
            # re-syncs on (re)connect, so the freshest state is what matters —
            # keeping the connection alive beats delivering every intermediate.
            while True:
                try:
                    queue.put_nowait(msg)
                    break
                except asyncio.QueueFull:
                    try:
                        queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break


# Singleton
event_broadcaster = EventBroadcaster()
