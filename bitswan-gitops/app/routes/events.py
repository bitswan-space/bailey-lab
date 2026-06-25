"""
SSE endpoint that pushes automation/image state changes to connected editors.
"""

import asyncio
import json

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from app.dependencies import get_automation_service, get_image_service
from app.deploy_manager import deploy_manager
from app.event_broadcaster import event_broadcaster
from app.task_queue import task_queue
from app.services.process_service import process_service
from app.routes.copies import get_cached_copies

router = APIRouter(tags=["events"])


@router.get("/events/stream")
async def stream_events():
    """SSE endpoint that pushes automation/image state changes."""

    async def event_generator():
        queue = event_broadcaster.subscribe()
        try:
            # Send current state immediately on connect
            automations = await get_automation_service().get_automations()
            data = [
                a.model_dump(mode="json") if hasattr(a, "model_dump") else a
                for a in automations
            ]
            yield f"event: automations\ndata: {json.dumps(data)}\n\n"

            images = await get_image_service().get_images()
            yield f"event: images\ndata: {json.dumps(images)}\n\n"

            # Current business-process snapshot — the dashboard reads this
            # straight off the SSE feed instead of walking the filesystem.
            processes = process_service.get_all_processes()
            yield f"event: processes\ndata: {json.dumps(processes)}\n\n"

            # Current copy list. Carried as data (not just a ping) so
            # the dashboard doesn't need a follow-up REST round-trip.
            try:
                copies = await get_cached_copies()
            except Exception:
                copies = []
            yield f"event: copies\ndata: {json.dumps(copies)}\n\n"

            # Send active deploy tasks so reconnecting clients pick up current state
            for task in deploy_manager.get_all_active_tasks():
                yield f"event: deploy_progress\ndata: {json.dumps(task.to_dict())}\n\n"

            # Current git task-queue snapshot so a (re)connecting dashboard renders
            # the queue panel immediately without a REST round-trip.
            yield f"event: task_queue_snapshot\ndata: {json.dumps(task_queue.snapshot())}\n\n"

            while True:
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=30)
                    yield f"event: {msg['event']}\ndata: {json.dumps(msg['data'])}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            event_broadcaster.unsubscribe(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
