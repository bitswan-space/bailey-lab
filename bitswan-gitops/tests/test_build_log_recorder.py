"""Tests for BuildLogRecorder — persisting deploy-path build logs.

Deploy-path image builds run on the infra driver and stream log lines back;
BuildLogRecorder writes them under images/<checksum>/ using the same file
conventions as ImageService.create_image so the dashboard's Build logs tab
can replay them. BITSWAN_GITOPS_DIR points at a tmp_path.
"""

import os

import pytest

from app.services.image_service import ImageService


CHECKSUM = "deadbeef"
TAG_ROOT = "internal/ws-bp-auto"


@pytest.fixture
def svc(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))
    return ImageService()


def _logs(svc):
    return svc._log_paths(CHECKSUM)


def test_success_promotes_building_to_build_log(svc):
    building, success, failed = _logs(svc)
    rec = svc.build_log_recorder(CHECKSUM, TAG_ROOT)
    rec.start()
    rec.write("Step 1/2 : FROM python:3.12")
    rec.write("Step 2/2 : COPY . /app")
    rec.finish_success()

    assert not os.path.exists(building)
    assert not os.path.exists(failed)
    content = open(success).read()
    assert "Build started at" in content
    assert "Step 1/2 : FROM python:3.12" in content
    assert "Build completed successfully" in content
    assert svc._get_build_status(CHECKSUM) == "ready"
    assert svc._read_metadata(CHECKSUM)["last_status"] == "success"


def test_failure_promotes_building_to_failedbuild_log(svc):
    building, success, failed = _logs(svc)
    rec = svc.build_log_recorder(CHECKSUM, TAG_ROOT)
    rec.start()
    rec.write("Step 1/2 : FROM python:3.12")
    rec.finish_failed("exit status 1")

    assert not os.path.exists(building)
    assert not os.path.exists(success)
    content = open(failed).read()
    assert "Build error: exit status 1" in content
    assert svc._get_build_status(CHECKSUM) == "failed"
    assert svc._read_metadata(CHECKSUM)["last_status"] == "failed"


def test_cache_hit_keeps_existing_real_log(svc):
    building, success, failed = _logs(svc)
    # A prior real build's log is on disk.
    rec = svc.build_log_recorder(CHECKSUM, TAG_ROOT)
    rec.start()
    rec.write("Step 1/2 : FROM python:3.12")
    rec.finish_success()
    original = open(success).read()

    # A rebuild is a driver cache hit ("cache hit: <tag>" is all that streams).
    rec2 = svc.build_log_recorder(CHECKSUM, TAG_ROOT)
    rec2.start()
    rec2.write("cache hit: internal/ws-bp-auto:shadeadbeef")
    rec2.finish_success(cache_hit=True)

    assert not os.path.exists(building)
    assert open(success).read() == original
    assert svc._get_build_status(CHECKSUM) == "ready"


def test_cache_hit_without_prior_log_still_writes_one(svc):
    building, success, failed = _logs(svc)
    rec = svc.build_log_recorder(CHECKSUM, TAG_ROOT)
    rec.start()
    rec.write("cache hit: internal/ws-bp-auto:shadeadbeef")
    rec.finish_success(cache_hit=True)

    assert not os.path.exists(building)
    content = open(success).read()
    assert "cache hit" in content
    assert "docker cache" in content


def test_success_supersedes_earlier_failure(svc):
    building, success, failed = _logs(svc)
    rec = svc.build_log_recorder(CHECKSUM, TAG_ROOT)
    rec.start()
    rec.finish_failed("exit status 1")
    assert svc._get_build_status(CHECKSUM) == "failed"

    rec2 = svc.build_log_recorder(CHECKSUM, TAG_ROOT)
    rec2.start()
    rec2.write("Step 1/1 : FROM python:3.12")
    rec2.finish_success()

    assert not os.path.exists(failed)
    assert os.path.exists(success)
    assert svc._get_build_status(CHECKSUM) == "ready"
