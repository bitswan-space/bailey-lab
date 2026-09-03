import json
import os

import pytest

from app.services import deploy_outcome


@pytest.fixture(autouse=True)
def _gitops_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_GITOPS_DIR", str(tmp_path))
    return tmp_path


def test_no_recorded_outcome_reads_as_none_not_as_a_success():
    assert deploy_outcome.read("gradesta", "dev") is None


def test_a_failed_deploy_is_readable_after_the_task_is_gone():
    deploy_outcome.record(
        "gradesta",
        "dev",
        None,
        "failed",
        error=(
            "driver apply failed: ensure live postgres dbs: CREATE DATABASE "
            'bp_gradesta failed: ERROR:  could not create directory "base/16471": '
            "No space left on device"
        ),
        step="provisioning_services",
    )
    outcome = deploy_outcome.read("gradesta", "dev")
    assert outcome["status"] == "failed"
    assert outcome["cause"] == "disk_full"
    assert outcome["step"] == "provisioning_services"
    assert "No space left on device" in outcome["error"]
    assert outcome["at"]


def test_a_successful_redeploy_replaces_the_recorded_failure():
    deploy_outcome.record(
        "gradesta", "dev", None, "failed", error="No space left on device"
    )
    deploy_outcome.record("gradesta", "dev", None, "completed")
    outcome = deploy_outcome.read("gradesta", "dev")
    assert outcome["status"] == "completed"
    assert outcome["cause"] is None
    assert outcome["error"] is None


def test_a_copy_live_dev_outcome_is_separate_from_mains_dev_stage():
    deploy_outcome.record(
        "payroll", "live-dev", "tomas", "failed", error="No space left on device"
    )
    deploy_outcome.record("payroll", "dev", None, "completed")
    assert deploy_outcome.read("payroll", "live-dev", "tomas")["status"] == "failed"
    assert deploy_outcome.read("payroll", "dev")["status"] == "completed"
    assert deploy_outcome.read("payroll", "live-dev") is None


def test_clear_forgets_the_outcome_so_a_namesake_does_not_inherit_it():
    deploy_outcome.record("gradesta", "dev", None, "failed", error="boom")
    deploy_outcome.clear("gradesta", "dev")
    assert deploy_outcome.read("gradesta", "dev") is None
    deploy_outcome.clear("gradesta", "dev")


@pytest.mark.parametrize(
    "error",
    [
        'could not create directory "base/16471": No space left on device',
        'could not extend file "base/16413/2757": No space left on device',
        "could not write to file: Disk quota exceeded",
    ],
)
def test_every_shape_of_a_full_filesystem_classifies_as_disk_full(error):
    assert deploy_outcome.classify_failure(error) == "disk_full"


@pytest.mark.parametrize(
    "error", [None, "", "connection refused", "image build failed"]
)
def test_an_unrecognised_failure_is_left_unclassified(error):
    assert deploy_outcome.classify_failure(error) is None


def test_a_bp_name_never_escapes_the_outcome_directory(_gitops_dir):
    deploy_outcome.record("../../etc/passwd", "dev", None, "failed", error="boom")
    written = os.listdir(os.path.join(_gitops_dir, "gitops", ".deploy-outcome"))
    assert written == [".._.._etc_passwd__dev"]


def test_the_marker_lands_beside_the_other_runtime_markers_where_the_app_can_write(
    _gitops_dir,
):
    deploy_outcome.record("gradesta", "dev", None, "completed")
    directory = os.path.join(_gitops_dir, "gitops", ".deploy-outcome")
    assert sorted(os.listdir(directory)) == ["gradesta__dev"]
    with open(os.path.join(directory, "gradesta__dev")) as f:
        assert json.load(f)["status"] == "completed"
