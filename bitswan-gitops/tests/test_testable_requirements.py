"""The requirements contract + the verdict rules that replace exit codes.

The headline case is `test_go_no_tests_to_run_is_not_a_pass`: `go test -run
REQ_999 ./...` exits 0 with "[no tests to run]", which used to record a PASS
for every requirement nobody had written a test for.
"""

import pytest

from app.services.requirement_verdicts import (
    VERDICT_FAIL,
    VERDICT_NO_TEST,
    VERDICT_PASS,
    parse_go_test_json,
    parse_junit_xml,
    parse_report,
    verdict_for_requirement,
)
from app.services.testable_requirements import (
    Requirement,
    children_by_parent,
    next_requirement_id,
    parse_testable_requirements,
    parse_testing_config,
    read_requirements,
    requirement_token,
    serialize_testable_requirements,
    name_matches_requirement,
    write_requirements,
)


# ---- contract file ----------------------------------------------------------


def test_parse_keeps_rows_and_drops_status():
    reqs = parse_testable_requirements(
        """
[[requirement]]
id = "REQ-001"
parent = ""
description = "/health returns OK"
status = "pass"

[[requirement]]
id = "REQ-002"
parent = "REQ-001"
description = "counter increments"
automation = "backend"
runner = "cd /app && go test -run {id} -json ./..."
"""
    )
    assert [r.id for r in reqs] == ["REQ-001", "REQ-002"]
    assert reqs[0].description == "/health returns OK"
    assert reqs[1].parent == "REQ-001"
    assert reqs[1].automation == "backend"
    # `status` is ignored, not migrated — a verdict is never read from the file.
    assert not hasattr(reqs[0], "status")


def test_serialize_round_trips_and_omits_empty_overrides():
    reqs = [
        Requirement(id="REQ-7QX4", description="a"),
        Requirement(id="REQ-8ABC", parent="REQ-7QX4", automation="backend"),
    ]
    text = serialize_testable_requirements(reqs)
    assert "status" not in text
    assert "runner" not in text  # omitted when unset
    assert parse_testable_requirements(text) == reqs


def test_parse_rejects_syntax_error_rather_than_returning_empty():
    with pytest.raises(ValueError):
        parse_testable_requirements("[[requirement]\nid = ")


def test_parse_skips_rows_without_an_id():
    reqs = parse_testable_requirements(
        '[[requirement]]\ndescription = "orphan"\n\n[[requirement]]\nid = "REQ-1"\n'
    )
    assert [r.id for r in reqs] == ["REQ-1"]


def test_read_missing_file_is_an_empty_contract(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(tmp_path))
    assert read_requirements("dev1", "shop") == []


def test_write_then_read_round_trips(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(tmp_path))
    (tmp_path / "dev1" / "shop").mkdir(parents=True)
    reqs = [Requirement(id="REQ-7QX4", description="x")]
    write_requirements("dev1", "shop", reqs)
    assert read_requirements("dev1", "shop") == reqs


def test_ids_are_random_so_two_copies_do_not_collide():
    # The old max+1 scheme made two copies mint REQ-004 independently.
    ids = {next_requirement_id([]) for _ in range(50)}
    assert len(ids) > 40
    assert all(i.startswith("REQ-") and len(i) == 8 for i in ids)


def test_next_id_avoids_ids_already_in_the_file():
    existing = [Requirement(id=next_requirement_id([])) for _ in range(5)]
    assert next_requirement_id(existing) not in {r.id for r in existing}


def test_orphans_are_treated_as_roots():
    reqs = [Requirement(id="A", parent="GONE"), Requirement(id="B")]
    assert set(children_by_parent(reqs)[""]) == {"A", "B"}


# ---- [testing] config -------------------------------------------------------


def test_parse_testing_config():
    cfg = parse_testing_config(
        'process-id = "x"\n\n[testing]\nautomation = "backend"\n'
        'framework = "go"\ntimeout = 60\n'
    )
    assert (cfg.automation, cfg.framework, cfg.timeout) == ("backend", "go", 60)


def test_missing_testing_section_is_the_zero_value():
    cfg = parse_testing_config('process-id = "x"\n')
    assert cfg.automation == "" and cfg.framework == "" and cfg.timeout is None


def test_bogus_timeout_is_ignored():
    assert parse_testing_config("[testing]\ntimeout = -5\n").timeout is None
    assert parse_testing_config("[testing]\ntimeout = true\n").timeout is None


# ---- id ↔ test-name matching ------------------------------------------------


def test_token_turns_hyphens_into_underscores():
    assert requirement_token("REQ-7QX4") == "REQ_7QX4"


@pytest.mark.parametrize(
    "name",
    [
        "test_REQ_7QX4_health",  # pytest
        "TestREQ_7QX4_Health",  # go, no separator before the token
        "test_REQ_7QX4",  # token at the end
    ],
)
def test_matching_names(name):
    assert name_matches_requirement("REQ-7QX4", name)


@pytest.mark.parametrize(
    "name",
    [
        "test_REQ_7QX41_health",  # a LONGER id must not satisfy a shorter one
        "test_REQ_7QX4A",
        "test_REQ_8ZZZ_health",
    ],
)
def test_non_matching_names(name):
    assert not name_matches_requirement("REQ-7QX4", name)


def test_legacy_numeric_ids_do_not_swallow_each_other():
    assert not name_matches_requirement("REQ-100", "test_REQ_1000_x")
    assert name_matches_requirement("REQ-100", "test_REQ_100_x")


# ---- go test -json ----------------------------------------------------------


def _go_line(action, test=None, output=None):
    import json

    event = {"Action": action, "Package": "backend"}
    if test:
        event["Test"] = test
    if output is not None:
        event["Output"] = output
    return json.dumps(event)


def test_go_no_tests_to_run_is_not_a_pass():
    """THE BUG: exit code 0 + "no tests to run" used to mean pass."""
    raw = "\n".join(
        [
            _go_line("output", output="testing: warning: no tests to run\n"),
            _go_line("output", output="ok  \tbackend\t0.007s [no tests to run]\n"),
            _go_line("pass"),
        ]
    )
    verdict, _ = verdict_for_requirement("REQ-999", parse_go_test_json(raw))
    assert verdict == VERDICT_NO_TEST


def test_go_passing_test_is_a_pass():
    raw = "\n".join(
        [
            _go_line("run", "TestREQ_7QX4_Health"),
            _go_line("pass", "TestREQ_7QX4_Health"),
        ]
    )
    assert (
        verdict_for_requirement("REQ-7QX4", parse_go_test_json(raw))[0] == VERDICT_PASS
    )


def test_go_failing_test_carries_its_output():
    raw = "\n".join(
        [
            _go_line("run", "TestREQ_7QX4_Health"),
            _go_line("output", "TestREQ_7QX4_Health", "    want 200, got 500\n"),
            _go_line("fail", "TestREQ_7QX4_Health"),
        ]
    )
    verdict, output = verdict_for_requirement("REQ-7QX4", parse_go_test_json(raw))
    assert verdict == VERDICT_FAIL
    assert "want 200, got 500" in output


def test_go_build_failure_is_a_suite_error_not_a_silent_pass():
    raw = "\n".join(
        [
            _go_line("output", output="./main.go:3:1: syntax error\n"),
            _go_line("fail"),
        ]
    )
    verdict, output = verdict_for_requirement("REQ-7QX4", parse_go_test_json(raw))
    assert verdict == VERDICT_FAIL
    assert "syntax error" in output


def test_go_non_json_noise_is_a_suite_error():
    result = parse_go_test_json("sh: 1: go: not found\n")
    assert result.suite_error and "not found" in result.suite_error


def test_go_skipped_test_counts_as_absent():
    raw = _go_line("skip", "TestREQ_7QX4_Demo")
    assert (
        verdict_for_requirement("REQ-7QX4", parse_go_test_json(raw))[0]
        == VERDICT_NO_TEST
    )


# ---- junit xml --------------------------------------------------------------


def test_junit_pass_after_pytest_preamble():
    raw = (
        "2 passed in 0.10s\n"
        '<?xml version="1.0"?><testsuites><testsuite name="pytest" tests="1">'
        '<testcase classname="t" name="test_REQ_7QX4_health" time="0.01"/>'
        "</testsuite></testsuites>"
    )
    assert verdict_for_requirement("REQ-7QX4", parse_junit_xml(raw))[0] == VERDICT_PASS


def test_junit_failure_carries_its_message():
    raw = (
        "<testsuite><testcase name='test_REQ_7QX4_health'>"
        "<failure message='assert 500 == 200'>full traceback</failure>"
        "</testcase></testsuite>"
    )
    verdict, output = verdict_for_requirement("REQ-7QX4", parse_junit_xml(raw))
    assert verdict == VERDICT_FAIL
    assert "assert 500 == 200" in output and "full traceback" in output


def test_junit_no_matching_test_is_no_test():
    raw = "<testsuite><testcase name='test_something_else'/></testsuite>"
    assert (
        verdict_for_requirement("REQ-7QX4", parse_junit_xml(raw))[0] == VERDICT_NO_TEST
    )


def test_junit_missing_report_is_a_suite_error():
    """pytest exiting 5 with no report must not read as 'no test' silently."""
    result = parse_junit_xml("ERROR: file or directory not found: /app\n")
    assert result.suite_error
    assert verdict_for_requirement("REQ-7QX4", result)[0] == VERDICT_FAIL


def test_junit_collection_error_is_a_suite_error():
    raw = (
        "<testsuite><error message='collection failure'>ImportError</error>"
        "</testsuite>"
    )
    assert parse_junit_xml(raw).suite_error


def test_unsupported_framework_fails_loudly():
    result = parse_report("mocha", "whatever")
    assert result.suite_error and "mocha" in result.suite_error
