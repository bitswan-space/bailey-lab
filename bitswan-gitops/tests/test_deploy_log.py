"""Append-only deploy log: the single scalar `message` is overwritten on every
progress line (worsened by BP members building concurrently into one field), so
the build log — image steps, build.sh output (vite/go build), per-member
"Prepared N/M" — was invisible. `DeployTask.log` retains every line for the UI.
"""

from app.deploy_manager import DeployManager, DeployStatus, _MAX_LOG_LINES


async def _new_task(dm: DeployManager):
    task = await dm.create_task("wraptest-abcd-frontend-dev")
    assert task is not None
    return task


async def test_every_message_is_appended_to_log():
    dm = DeployManager()
    task = await _new_task(dm)
    lines = [
        "Deploying memory7...",
        "Building image for frontend: Step 2/3 : COPY . /app/",
        "Building image for frontend: Step 3/3 : RUN if [ -f /app/build.sh ]; then cd /app && sh ./build.sh; fi",
        "Building image for frontend: transforming...",
        "Prepared 1/2: frontend",
        "Prepared 2/2: backend",
        "Updating deployment configuration...",
    ]
    for line in lines:
        await dm.update_task(task.task_id, message=line)

    assert task.log == lines, "every progress line must survive in the log"
    # The scalar is only ever the latest line — this is exactly why the log exists.
    assert task.message == lines[-1]
    assert dm.get_task(task.task_id).to_dict()["log"] == lines


async def test_consecutive_duplicate_lines_are_deduped():
    dm = DeployManager()
    task = await _new_task(dm)
    await dm.update_task(task.task_id, message="compose_up")
    await dm.update_task(task.task_id, message="compose_up")  # dup — dropped
    await dm.update_task(task.task_id, message="ingress")
    await dm.update_task(task.task_id, message="compose_up")  # not consecutive — kept

    assert task.log == ["compose_up", "ingress", "compose_up"]


async def test_status_only_update_does_not_grow_log():
    dm = DeployManager()
    task = await _new_task(dm)
    await dm.update_task(task.task_id, message="building")
    # A status/step transition without a message must not append a blank line.
    await dm.update_task(task.task_id, status=DeployStatus.IN_PROGRESS)
    assert task.log == ["building"]


async def test_log_is_bounded_dropping_oldest():
    dm = DeployManager()
    task = await _new_task(dm)
    total = _MAX_LOG_LINES + 50
    for i in range(total):
        await dm.update_task(task.task_id, message=f"line {i}")

    assert len(task.log) == _MAX_LOG_LINES
    # Oldest dropped, newest kept.
    assert task.log[0] == f"line {total - _MAX_LOG_LINES}"
    assert task.log[-1] == f"line {total - 1}"
