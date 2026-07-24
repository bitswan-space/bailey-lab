"""Issue #180 / BSY-01: the per-deployment `POST /automations/{id}/deploy`
route must never promote to staging or production — those transitions go only
through the gated `/promote-bp` path (freeze + N sign-offs + admin/auditor).

Before the fix this route accepted `stage=staging|production` (and a missing
stage, which maps to production) with no `_assert_promotable`, so an
authenticated member could bypass the freeze/audit gate. The route now accepts
only `dev` / `live-dev`; everything else is rejected 400 *before* a deploy task
is created.
"""

import pytest
from fastapi import HTTPException

from app.routes import automations as auto_routes
from app.services.automation_service import AutomationService


@pytest.mark.parametrize("stage", ["staging", "production", None, "prod"])
async def test_deploy_route_rejects_gated_stages(stage):
    """staging / production / missing / unknown → 400, and no task spawned."""
    deployment_id = f"app-{stage}-180test"
    with pytest.raises(HTTPException) as ei:
        await auto_routes.deploy_automation(
            deployment_id=deployment_id,
            checksum="deadbeef",
            stage=stage,
            relative_path=None,
            services=None,
            replicas=None,
            deployed_by=None,
            automation_name_field=None,
            context_field=None,
            automation_service=AutomationService(),
        )
    assert ei.value.status_code == 400
    # Point the caller at the gated path, not just a generic rejection.
    assert "promote-bp" in ei.value.detail
    # The rejection happens before any deploy task is registered.
    assert not auto_routes.deploy_manager.is_deploying(deployment_id)
