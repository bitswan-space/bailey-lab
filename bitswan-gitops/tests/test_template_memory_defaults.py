"""Scaffolded automations must carry the memory-governance fields so the author
sees + tunes them (memory-reservation is required to promote). _ensure_memory_defaults
injects them if a template omits them, and never overrides an authored value."""

import os

from app.services.template_service import _ensure_memory_defaults
from app.utils import read_automation_config


def _write(tmp_path, content):
    p = tmp_path / "automation.toml"
    p.write_text(content)
    return str(tmp_path)


def test_injects_when_missing(tmp_path):
    d = _write(tmp_path, "[deployment]\nexpose = true\n")
    _ensure_memory_defaults(d)
    c = read_automation_config(d)
    assert c.memory_reservation == 128
    assert c.memory_reservation_policy == "on-demand"
    assert c.expose is True  # existing content preserved


def test_does_not_override_authored(tmp_path):
    d = _write(
        tmp_path,
        '[deployment]\nmemory-reservation = 512\nmemory_reservation_policy = "always-on"\n',
    )
    _ensure_memory_defaults(d)
    c = read_automation_config(d)
    assert c.memory_reservation == 512
    assert c.memory_reservation_policy == "always-on"


def test_no_deployment_section_appends(tmp_path):
    d = _write(tmp_path, "# just a comment\n")
    _ensure_memory_defaults(d)
    c = read_automation_config(d)
    assert c.memory_reservation == 128


def test_missing_file_creates(tmp_path):
    _ensure_memory_defaults(str(tmp_path))
    assert os.path.exists(tmp_path / "automation.toml")
    c = read_automation_config(str(tmp_path))
    assert c.memory_reservation == 128
    assert c.memory_reservation_policy == "on-demand"


def test_shipped_bp_templates_declare_memory():
    # The static business-process templates a new BP scaffolds from must declare
    # the fields directly (not only via the injector).
    for t in (
        "examples/business-process/backend",
        "examples/business-process/frontend",
    ):
        c = read_automation_config(t)
        assert c.memory_reservation is not None, t
        assert c.memory_reservation_policy in ("on-demand", "always-on"), t
