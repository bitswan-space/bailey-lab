"""Regression: the create-process route must materialize the requesting copy
under the BP's SLUG, not its human-readable display name.

The born-in-main flow creates the BP in main, then clones it into the requesting
copy via `clone_bp_into_copy(copy_path, copy, bp, …)` — whose `bp` argument keys
`bp_bare_repo_path(bp)` and the on-disk `copies/<copy>/<bp>` dir on the SLUG. A
regression passed the display name there, so for any BP whose name differs from
its slug (i.e. all of them, once #77 landed human-readable names) the copy was
never materialized under the slug: the BP's `copies` omitted the requesting copy,
`bpInWt` was false in the dashboard, and the Description tab rendered the
read-only README instead of the editable spec (no ProseMirror editor). That is
exactly what made the E2E walkthrough's `description` chapter hang.
"""

import asyncio

from app.routes import processes as proc
from app.routes.processes import CreateProcessRequest
from app.services import bp_git


def test_route_materializes_copy_by_slug_not_display_name(tmp_path, monkeypatch):
    copies = tmp_path / "copies"
    (copies / "u1").mkdir(parents=True)
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(copies))

    # create_business_process is main-scope and already unit-tested; stub it to
    # return the slug entry so this test isolates the ROUTE's copy wiring.
    async def fake_create(name, created_by=None):
        return {
            "id": "id1",
            "name": "invoice-processing",  # the slug
            "display_name": name,
            "in_main": True,
            "copies": [],
            "has_copies": False,
        }

    monkeypatch.setattr(proc.process_service, "create_business_process", fake_create)
    monkeypatch.setattr(proc.process_service, "get_all_processes", lambda *a, **k: {})

    async def fake_template(**kwargs):
        return {"created": []}

    monkeypatch.setattr(
        proc.template_service, "create_automation_from_template", fake_template
    )

    async def fake_spawn(**kwargs):
        return {}

    monkeypatch.setattr(proc, "spawn_set_deploy", fake_spawn)

    async def noop_broadcast(*a, **k):
        return None

    monkeypatch.setattr(proc.event_broadcaster, "broadcast", noop_broadcast)

    captured: dict = {}

    async def fake_clone(copy_path, copy, bp, base="main", allow_empty=False):
        captured["bp"] = bp
        captured["copy"] = copy
        return True

    # The route imports clone_bp_into_copy from this module inside the function,
    # so patching the module attribute is what the call resolves to.
    monkeypatch.setattr(bp_git, "clone_bp_into_copy", fake_clone)

    class FakeAuto:
        async def refresh(self, *a, **k):
            return None

        async def get_automations(self):
            return []

        def members_for_bp(self, *a, **k):
            return []

    entry = asyncio.run(
        proc.create_process(
            CreateProcessRequest(name="Invoice Processing", copy="u1"),
            automation_service=FakeAuto(),
        )
    )

    assert captured.get("bp") == "invoice-processing", (
        f"copy materialized under {captured.get('bp')!r}; must be the SLUG "
        "'invoice-processing', not the display name"
    )
    assert captured.get("copy") == "u1"
    assert entry["copies"] == ["u1"]
