"""The test runner: where a requirement's test runs, in what order, and what
happens when a parent fails.

The automation service and the infra-driver are faked — what is under test is
the orchestration (target resolution, parent gating, wake-before-exec, subset
re-runs), not docker.
"""

import json

import pytest

from app import test_runner
from app.services.testable_requirements import Requirement, BpTestingConfig
from app.test_run_manager import (
    RUN_COMPLETED,
    VERDICT_BLOCKED,
    VERDICT_FAIL,
    VERDICT_NO_TEST,
    VERDICT_PASS,
    test_run_manager,
)


def _go_report(test_name: str, action: str) -> str:
    return "\n".join(
        [
            json.dumps({"Action": "run", "Test": test_name, "Package": "backend"}),
            json.dumps({"Action": action, "Test": test_name, "Package": "backend"}),
        ]
    )


class FakeDriver:
    """Matches a command against canned reports by the token it carries."""

    def __init__(self, by_token: dict):
        self.by_token = by_token
        self.commands: list[str] = []

    async def exec(self, ctx, spec, stdin=None, on_stdout=None, on_stderr=None):
        command = spec.cmd[-1]
        self.commands.append(command)
        for token, output in self.by_token.items():
            if token in command:
                await on_stdout(output.encode())
                return 0
        # Nothing matched: what `go test -run <unknown>` really prints.
        await on_stdout(
            (
                json.dumps(
                    {
                        "Action": "output",
                        "Package": "backend",
                        "Output": "testing: warning: no tests to run\n",
                    }
                )
                + "\n"
                + json.dumps({"Action": "pass", "Package": "backend"})
            ).encode()
        )
        return 0


class FakeService:
    def __init__(self, members, driver):
        self.members = members
        self.infra_driver = driver
        self.woken: list[str] = []

    def members_for_bp(self, bp, copy=None, stage="dev"):
        return self.members

    async def wake_live_dev(self, context, stage=None):
        self.woken.append(context)
        return {}

    async def get_container(self, deployment_id):
        return [{"Id": f"container-{deployment_id}"}]

    def _workspace_ctx(self):
        return {}


def _member(name: str, copy: str = "dev1", bp: str = "shop") -> dict:
    return {
        "automation_name": name,
        "deployment_id": f"{name}-copy-{copy}-{bp}-live-dev",
        "context": f"copy-{copy}-{bp}",
    }


@pytest.fixture
def bp_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("BITSWAN_COPIES_DIR", str(tmp_path))
    path = tmp_path / "dev1" / "shop"
    path.mkdir(parents=True)
    return path


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    test_run_manager.forget("dev1", "shop")

    async def fake_git(*command, **kwargs):
        if "rev-parse" in command:
            return "abc123\n", "", 0
        if "log" in command:
            return "add health check\n", "", 0
        return "", "", 0

    monkeypatch.setattr(test_runner, "call_git_command_with_output", fake_git)
    yield
    test_run_manager.forget("dev1", "shop")


def _install(monkeypatch, members, driver):
    from app import dependencies

    svc = FakeService(members, driver)
    monkeypatch.setattr(dependencies, "get_automation_service", lambda: svc)
    return svc


def _write(bp_dir, requirements_toml: str, process_toml: str):
    (bp_dir / "testable-requirements.toml").write_text(requirements_toml)
    (bp_dir / "process.toml").write_text(process_toml)


_PROCESS_GO = (
    'process-id = "x"\n\n[testing]\nautomation = "backend"\nframework = "go"\n'
)


# ---- target resolution ------------------------------------------------------


def test_single_automation_needs_no_configuration():
    target = test_runner.resolve_target(
        Requirement(id="REQ-7QX4"),
        BpTestingConfig(framework="go"),
        [_member("backend")],
    )
    assert target.error == ""
    assert target.deployment_id == "backend-copy-dev1-shop-live-dev"


def test_several_automations_without_config_is_an_error_not_a_guess():
    target = test_runner.resolve_target(
        Requirement(id="REQ-7QX4"),
        BpTestingConfig(framework="go"),
        [_member("backend"), _member("frontend")],
    )
    assert "ambiguous" in target.error
    assert "backend" in target.error and "frontend" in target.error


def test_per_requirement_automation_overrides_the_bp_default():
    target = test_runner.resolve_target(
        Requirement(id="REQ-7QX4", automation="frontend"),
        BpTestingConfig(automation="backend", framework="pytest"),
        [_member("backend"), _member("frontend")],
    )
    assert target.deployment_id == "frontend-copy-dev1-shop-live-dev"


def test_unknown_automation_names_the_available_ones():
    target = test_runner.resolve_target(
        Requirement(id="REQ-7QX4"),
        BpTestingConfig(automation="api", framework="go"),
        [_member("backend")],
    )
    assert "does not match" in target.error and "backend" in target.error


def test_missing_framework_is_an_error():
    target = test_runner.resolve_target(
        Requirement(id="REQ-7QX4"), BpTestingConfig(), [_member("backend")]
    )
    assert "framework" in target.error


def test_framework_is_inferred_from_an_existing_custom_runner():
    assert test_runner.resolve_framework("go test -run {id} ./... -v", "") == "go"
    assert test_runner.resolve_framework("pytest -k {id}", "") == "pytest"


def test_runner_hint_names_the_missing_report_flag():
    hint = test_runner.runner_hint("go test -run {id} ./... -v", "go")
    assert "-json" in hint


def test_built_in_runners_cd_into_the_mounted_source():
    # The stock runtime image has no WORKDIR, so exec lands in /.
    for command in test_runner.DEFAULT_RUNNERS.values():
        assert command.startswith("cd /app &&")


def test_command_substitutes_the_token():
    command = test_runner.build_command("", "go", "REQ-7QX4")
    assert "REQ_7QX4" in command and "{id}" not in command


# ---- ordering ---------------------------------------------------------------


def test_levels_put_parents_before_children():
    reqs = [
        Requirement(id="C", parent="B"),
        Requirement(id="A"),
        Requirement(id="B", parent="A"),
    ]
    assert test_runner._levels(reqs) == [["A"], ["B"], ["C"]]


def test_levels_treat_a_cycle_as_a_root_instead_of_recursing_forever():
    reqs = [Requirement(id="A", parent="B"), Requirement(id="B", parent="A")]
    levels = test_runner._levels(reqs)
    assert sorted(i for level in levels for i in level) == ["A", "B"]


# ---- running ----------------------------------------------------------------


async def test_requirement_without_a_test_is_not_a_pass(bp_dir, monkeypatch):
    """The reported bug: go exits 0 saying "no tests to run"."""
    _write(
        bp_dir,
        '[[requirement]]\nid = "REQ-7QX4"\ndescription = "untested"\n',
        _PROCESS_GO,
    )
    _install(monkeypatch, [_member("backend")], FakeDriver({}))

    run = await test_runner.execute_run("dev1", "shop")

    assert run.status == RUN_COMPLETED
    assert run.results["REQ-7QX4"].verdict == VERDICT_NO_TEST
    # A requirement nobody has written a test for is an unfinished contract,
    # not a failing one, so it does not by itself block the deploy gate.
    assert run.is_green()


async def test_passing_and_failing_requirements(bp_dir, monkeypatch):
    _write(
        bp_dir,
        '[[requirement]]\nid = "REQ-AAAA"\n\n[[requirement]]\nid = "REQ-BBBB"\n',
        _PROCESS_GO,
    )
    driver = FakeDriver(
        {
            "REQ_AAAA": _go_report("TestREQ_AAAA_Health", "pass"),
            "REQ_BBBB": _go_report("TestREQ_BBBB_Count", "fail"),
        }
    )
    _install(monkeypatch, [_member("backend")], driver)

    run = await test_runner.execute_run("dev1", "shop")

    assert run.results["REQ-AAAA"].verdict == VERDICT_PASS
    assert run.results["REQ-BBBB"].verdict == VERDICT_FAIL
    assert run.is_green() is False


async def test_child_is_blocked_while_its_parent_fails(bp_dir, monkeypatch):
    _write(
        bp_dir,
        '[[requirement]]\nid = "REQ-PPPP"\n\n'
        '[[requirement]]\nid = "REQ-CCCC"\nparent = "REQ-PPPP"\n\n'
        '[[requirement]]\nid = "REQ-GGGG"\nparent = "REQ-CCCC"\n',
        _PROCESS_GO,
    )
    driver = FakeDriver(
        {
            "REQ_PPPP": _go_report("TestREQ_PPPP_Base", "fail"),
            "REQ_CCCC": _go_report("TestREQ_CCCC_Child", "pass"),
        }
    )
    _install(monkeypatch, [_member("backend")], driver)

    run = await test_runner.execute_run("dev1", "shop")

    assert run.results["REQ-PPPP"].verdict == VERDICT_FAIL
    assert run.results["REQ-CCCC"].verdict == VERDICT_BLOCKED
    # Blocking is transitive — a grandchild is not run either.
    assert run.results["REQ-GGGG"].verdict == VERDICT_BLOCKED
    # And the blocked child's test was never executed.
    assert not any("REQ_CCCC" in c for c in driver.commands)


async def test_live_dev_is_woken_before_any_exec(bp_dir, monkeypatch):
    _write(bp_dir, '[[requirement]]\nid = "REQ-AAAA"\n', _PROCESS_GO)
    svc = _install(monkeypatch, [_member("backend")], FakeDriver({}))

    await test_runner.execute_run("dev1", "shop")

    assert svc.woken == ["copy-dev1-shop"]


async def test_misconfiguration_fails_the_requirement_with_the_reason(
    bp_dir, monkeypatch
):
    _write(
        bp_dir,
        '[[requirement]]\nid = "REQ-AAAA"\n',
        'process-id = "x"\n\n[testing]\nframework = "go"\n',
    )
    _install(monkeypatch, [_member("backend"), _member("frontend")], FakeDriver({}))

    run = await test_runner.execute_run("dev1", "shop")

    result = run.results["REQ-AAAA"]
    assert result.verdict == VERDICT_FAIL
    assert "ambiguous" in result.output


async def test_bp_with_no_automations_has_nothing_to_run_in(bp_dir, monkeypatch):
    _write(bp_dir, '[[requirement]]\nid = "REQ-AAAA"\n', _PROCESS_GO)
    _install(monkeypatch, [], FakeDriver({}))

    run = await test_runner.execute_run("dev1", "shop")

    assert run.results["REQ-AAAA"].verdict == VERDICT_NO_TEST


async def test_rerun_failed_only_keeps_the_other_verdicts(bp_dir, monkeypatch):
    _write(
        bp_dir,
        '[[requirement]]\nid = "REQ-AAAA"\n\n[[requirement]]\nid = "REQ-BBBB"\n',
        _PROCESS_GO,
    )
    driver = FakeDriver(
        {
            "REQ_AAAA": _go_report("TestREQ_AAAA_Health", "pass"),
            "REQ_BBBB": _go_report("TestREQ_BBBB_Count", "fail"),
        }
    )
    _install(monkeypatch, [_member("backend")], driver)
    await test_runner.execute_run("dev1", "shop")

    # The failing test is fixed; only it is re-run.
    driver.by_token["REQ_BBBB"] = _go_report("TestREQ_BBBB_Count", "pass")
    driver.commands.clear()
    run = await test_runner.execute_run("dev1", "shop", failed_only=True)

    assert [c for c in driver.commands if "REQ_AAAA" in c] == []
    assert run.results["REQ-AAAA"].verdict == VERDICT_PASS  # carried forward
    assert run.results["REQ-BBBB"].verdict == VERDICT_PASS
    assert run.is_green()


async def test_previous_verdict_is_carried_while_the_new_run_is_pending(
    bp_dir, monkeypatch
):
    _write(bp_dir, '[[requirement]]\nid = "REQ-AAAA"\n', _PROCESS_GO)
    driver = FakeDriver({"REQ_AAAA": _go_report("TestREQ_AAAA_Health", "pass")})
    _install(monkeypatch, [_member("backend")], driver)
    await test_runner.execute_run("dev1", "shop")

    run = test_run_manager.start("dev1", "shop", "def456", "next commit", "tree2")

    assert run.results["REQ-AAAA"].previous_verdict == VERDICT_PASS
    assert run.results["REQ-AAAA"].previous_sha == "abc123"


async def test_a_broken_contract_fails_the_run_loudly(bp_dir, monkeypatch):
    _write(bp_dir, "[[requirement]\nid = ", _PROCESS_GO)
    _install(monkeypatch, [_member("backend")], FakeDriver({}))

    run = await test_runner.execute_run("dev1", "shop")

    assert run.status == "failed"
    assert "Syntax error" in (run.error or "")


# ---- a business process that mixes languages --------------------------------
#
# The case that forced a real user to hand-write a translator: a BP whose
# default is a Go backend, plus a Python worker. Before per-automation and
# per-requirement framework overrides existed, the BP-wide framework was
# applied to every automation, so the worker's pytest output was parsed as
# `go test -json` and its passing tests reported as "no test".


_PROCESS_MIXED = (
    'process-id = "x"\n\n'
    '[testing]\nautomation = "backend"\nframework = "go"\n\n'
    '[testing.new-worker]\nframework = "pytest"\n'
)


def test_per_automation_framework_beats_the_bp_default():
    from app.services.testable_requirements import parse_testing_config

    cfg = parse_testing_config(_PROCESS_MIXED)
    target = test_runner.resolve_target(
        Requirement(id="REQ-S96X", automation="new-worker"),
        cfg,
        [_member("backend"), _member("new-worker")],
    )
    assert target.error == ""
    assert target.framework == "pytest"
    assert "pytest" in target.command
    assert target.deployment_id == "new-worker-copy-dev1-shop-live-dev"


def test_the_bp_default_still_applies_to_its_own_automation():
    from app.services.testable_requirements import parse_testing_config

    cfg = parse_testing_config(_PROCESS_MIXED)
    target = test_runner.resolve_target(
        Requirement(id="REQ-AAAA", automation="backend"),
        cfg,
        [_member("backend"), _member("new-worker")],
    )
    assert target.framework == "go"
    assert "go test" in target.command


def test_a_requirement_can_name_its_own_framework():
    target = test_runner.resolve_target(
        Requirement(id="REQ-S96X", automation="new-worker", framework="pytest"),
        BpTestingConfig(automation="backend", framework="go"),
        [_member("backend"), _member("new-worker")],
    )
    assert target.framework == "pytest"


def test_naming_only_the_framework_gets_the_built_in_runner_for_it():
    # No runner spelled out anywhere for the worker — the built-in pytest one
    # is correct, and is what the requirement should not have to repeat.
    from app.services.testable_requirements import parse_testing_config

    cfg = parse_testing_config(_PROCESS_MIXED)
    target = test_runner.resolve_target(
        Requirement(id="REQ-S96X", automation="new-worker"),
        cfg,
        [_member("backend"), _member("new-worker")],
    )
    assert target.command == test_runner.DEFAULT_RUNNERS["pytest"].replace(
        "{id}", "REQ_S96X"
    )


def test_a_runner_from_the_wrong_framework_is_named_not_silently_misparsed():
    """The failure mode this guard exists for: pytest output parsed as go-test
    output yields no matching events, so a test that passed reads as 'no test'."""
    target = test_runner.resolve_target(
        Requirement(id="REQ-S96X", automation="new-worker", runner="pytest -k {id}"),
        BpTestingConfig(automation="backend", framework="go"),
        [_member("backend"), _member("new-worker")],
    )
    assert "looks like pytest" in target.error
    assert "framework" in target.error


def test_a_deliberate_translator_runner_is_not_flagged():
    # Emitting go-test JSON from something else is legitimate; only a runner
    # that plainly belongs to the other framework is called out.
    target = test_runner.resolve_target(
        Requirement(
            id="REQ-S96X",
            automation="new-worker",
            runner="python3 report_as_go_test_json.py",
        ),
        BpTestingConfig(automation="backend", framework="go"),
        [_member("backend"), _member("new-worker")],
    )
    assert target.error == ""


def test_the_pytest_runner_does_not_write_into_the_read_only_mount():
    # /app is mounted read-only; pytest's cache write lands there by default,
    # which otherwise forces every BP to carry a pytest.ini.
    assert "-p no:cacheprovider" in test_runner.DEFAULT_RUNNERS["pytest"]
    assert "/tmp/" in test_runner.DEFAULT_RUNNERS["pytest"]


async def test_a_mixed_bp_runs_each_requirement_in_its_own_container(
    bp_dir, monkeypatch
):
    _write(
        bp_dir,
        '[[requirement]]\nid = "REQ-AAAA"\nautomation = "backend"\n\n'
        '[[requirement]]\nid = "REQ-S96X"\nautomation = "new-worker"\n',
        _PROCESS_MIXED,
    )
    driver = FakeDriver(
        {
            "REQ_AAAA": _go_report("TestREQ_AAAA_Health", "pass"),
            "REQ_S96X": (
                "<testsuite><testcase name='test_REQ_S96X_health'/></testsuite>"
            ),
        }
    )
    _install(monkeypatch, [_member("backend"), _member("new-worker")], driver)

    run = await test_runner.execute_run("dev1", "shop")

    assert run.results["REQ-AAAA"].verdict == VERDICT_PASS
    # The Python worker's JUnit report is parsed as JUnit, not as go-test JSON.
    assert run.results["REQ-S96X"].verdict == VERDICT_PASS
    assert run.results["REQ-S96X"].automation == "new-worker"


# ---- vitest -----------------------------------------------------------------
#
# vitest needs no parser of its own: its built-in `junit` reporter emits the
# same JUnit XML pytest does, so the existing parser reads it unchanged. It is
# a distinct framework name only so a BP can say which runner to invoke.


def test_vitest_resolves_and_gets_its_built_in_runner():
    target = test_runner.resolve_target(
        Requirement(id="REQ-V1TE", framework="vitest"),
        BpTestingConfig(),
        [_member("frontend")],
    )
    assert target.error == ""
    assert target.framework == "vitest"
    assert "vitest run" in target.command
    assert "REQ_V1TE" in target.command


def test_the_vitest_runner_writes_its_report_outside_the_read_only_mount():
    command = test_runner.DEFAULT_RUNNERS["vitest"]
    assert "--outputFile=/tmp/" in command
    assert "--reporter=junit" in command
    # jsdom, or a component test cannot render at all.
    assert "--environment jsdom" in command


def test_vitest_is_inferred_from_a_custom_runner():
    assert test_runner.resolve_framework("npx vitest run -t {id}", "") == "vitest"


def test_a_vitest_runner_under_the_go_framework_is_named():
    target = test_runner.resolve_target(
        Requirement(id="REQ-V1TE", runner="npx vitest run -t {id}"),
        BpTestingConfig(framework="go"),
        [_member("frontend")],
    )
    assert "looks like vitest" in target.error


def test_vitest_output_is_read_by_the_junit_parser():
    from app.services.requirement_verdicts import (
        VERDICT_FAIL,
        VERDICT_NO_TEST,
        VERDICT_PASS,
        parse_report,
        verdict_for_requirement,
    )

    # Shape taken from a real `vitest run --reporter=junit`: the name carries
    # the describe-block prefix, and tests filtered out by -t are reported as
    # skipped rather than omitted.
    raw = (
        '<?xml version="1.0" encoding="UTF-8" ?>\n'
        '<testsuites name="vitest tests" tests="2">'
        '<testsuite name="App.test.tsx" tests="2">'
        '<testcase classname="App.test.tsx" '
        'name="greeting &gt; test_REQ_V1TE_shows_a_greeting" time="0.002"/>'
        '<testcase classname="App.test.tsx" '
        'name="greeting &gt; test_REQ_F41L_is_broken" time="0">'
        '<failure message="expected 500 to be 200">at App.test.tsx:9</failure>'
        "</testcase>"
        '<testcase classname="App.test.tsx" '
        'name="greeting &gt; test_REQ_SK1P_filtered_out" time="0">'
        "<skipped/></testcase>"
        "</testsuite></testsuites>"
    )
    result = parse_report("vitest", raw)
    # The describe prefix must not stop a name from matching its requirement.
    assert verdict_for_requirement("REQ-V1TE", result)[0] == VERDICT_PASS
    verdict, output = verdict_for_requirement("REQ-F41L", result)
    assert verdict == VERDICT_FAIL
    assert "expected 500 to be 200" in output
    # A test the -t filter skipped is evidence of nothing.
    assert verdict_for_requirement("REQ-SK1P", result)[0] == VERDICT_NO_TEST


# ---- every row knows which container it belongs to ---------------------------
#
# The UI shows the container per row and hides the column when no row has one.
# A row that is judged but carries no container makes that column vanish from a
# whole group, which is how "Passing" lost its Container column.


async def test_a_passing_row_keeps_its_container_after_a_subset_rerun(
    bp_dir, monkeypatch
):
    _write(
        bp_dir,
        '[[requirement]]\nid = "REQ-AAAA"\n\n[[requirement]]\nid = "REQ-BBBB"\n',
        _PROCESS_GO,
    )
    driver = FakeDriver(
        {
            "REQ_AAAA": _go_report("TestREQ_AAAA_Health", "pass"),
            "REQ_BBBB": _go_report("TestREQ_BBBB_Count", "fail"),
        }
    )
    _install(monkeypatch, [_member("backend")], driver)
    await test_runner.execute_run("dev1", "shop")

    # Re-run only what failed. The passing requirement is not executed again,
    # but it is still shown — and still belongs to a container.
    run = await test_runner.execute_run("dev1", "shop", failed_only=True)

    assert run.results["REQ-AAAA"].verdict == VERDICT_PASS
    assert run.results["REQ-AAAA"].automation == "backend"


async def test_a_blocked_row_names_the_container_its_test_would_run_in(
    bp_dir, monkeypatch
):
    _write(
        bp_dir,
        '[[requirement]]\nid = "REQ-PPPP"\n\n'
        '[[requirement]]\nid = "REQ-CCCC"\nparent = "REQ-PPPP"\n',
        _PROCESS_GO,
    )
    driver = FakeDriver({"REQ_PPPP": _go_report("TestREQ_PPPP_Base", "fail")})
    _install(monkeypatch, [_member("backend")], driver)

    run = await test_runner.execute_run("dev1", "shop")

    assert run.results["REQ-CCCC"].verdict == VERDICT_BLOCKED
    # It was not run, but its target resolved — the container is real
    # information, not a claim that something executed.
    assert run.results["REQ-CCCC"].automation == "backend"
