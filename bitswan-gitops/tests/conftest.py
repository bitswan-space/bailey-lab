"""Shared test fixtures."""

import pytest

from app.task_queue import current_requester


@pytest.fixture(autouse=True)
def _isolate_current_requester():
    """Give every test a clean requester identity and undo whatever it set.

    ``current_requester`` is a contextvar and pytest runs tests in one thread,
    so a bare ``current_requester.set(...)`` in a test would otherwise leak
    into every later test in the session — an ordering-dependent flake. Tests
    that need an identity still just call ``set()``; this fixture rolls it
    back afterwards.
    """
    token = current_requester.set(None)
    yield
    current_requester.reset(token)
