"""GET /processes/ — the REST mirror of the `processes` SSE event.

Added for #319: the automation-server daemon fetches this to label a BP's
endpoints with the human-readable display name in the Bailey console. The
route must return the `get_all_processes()` entries verbatim (the daemon
reads `name` (slug) + `display_name`), wrapped in a `processes` key.
"""

import asyncio

from app.routes import processes as proc


def test_list_processes_returns_all_entries(monkeypatch):
    entries = [
        {
            "id": "id1",
            "name": "fio",
            "display_name": "Fio Invoicing",
            "in_main": True,
            "copies": [],
            "has_copies": False,
        },
        {
            "id": "id2",
            "name": "legacy-bp",
            "display_name": "legacy-bp",  # pre-#77 BP: slug is the name
            "in_main": True,
            "copies": ["alice"],
            "has_copies": True,
        },
    ]
    monkeypatch.setattr(proc.process_service, "get_all_processes", lambda: entries)
    assert asyncio.run(proc.list_processes()) == {"processes": entries}
