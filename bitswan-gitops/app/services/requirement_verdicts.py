"""Parsing test-runner reports into per-requirement verdicts.

WHY THIS EXISTS: the exit code of a test runner does not mean what it looks
like it means. `go test -run REQ_999 ./...` prints "[no tests to run]" and
exits **0**, so every requirement nobody has written a test for records as a
PASS. pytest gets the same situation the opposite way round and exits 5, so
the same requirements record as FAIL. Neither answer is true, and no amount of
guessing at exit codes can tell "ran and passed" apart from "matched nothing".

So the verdict is never taken from the exit code. The runner is asked to emit
a machine-readable report, and a requirement passes only when that report
contains a test whose NAME carries the requirement's id and which actually
ran and passed. "No such test" is its own outcome, and a suite that failed to
build or collect is a failure of every requirement pointed at it — never a
silent pass.
"""

import json
import logging
import re
from xml.etree import ElementTree

from app.services.testable_requirements import name_matches_requirement

logger = logging.getLogger(__name__)

# Per-requirement captured output. Enough for a failing assertion with context,
# small enough that a chatty suite cannot grow the in-memory state without
# bound (one of these per requirement, per BP, per copy).
MAX_OUTPUT_CHARS = 8 * 1024

PASS = "pass"
FAIL = "fail"
SKIP = "skip"

# Verdicts this module hands back for one requirement.
VERDICT_PASS = "pass"
VERDICT_FAIL = "fail"
VERDICT_NO_TEST = "no_test"

FRAMEWORK_GO = "go"
FRAMEWORK_PYTEST = "pytest"
SUPPORTED_FRAMEWORKS = (FRAMEWORK_GO, FRAMEWORK_PYTEST)


def _truncate(text: str) -> str:
    text = text.strip()
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return text[:MAX_OUTPUT_CHARS] + "\n…(output truncated)"


class TestOutcome:
    """One test the report says actually ran."""

    __slots__ = ("name", "status", "output")

    def __init__(self, name: str, status: str, output: str = ""):
        self.name = name
        self.status = status
        self.output = output

    def to_dict(self) -> dict:
        return {"name": self.name, "status": self.status, "output": self.output}

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"TestOutcome({self.name!r}, {self.status!r})"


class ReportResult:
    """What one runner invocation told us.

    `suite_error` is set when the suite could not be built, collected or
    parsed. It is deliberately NOT the same as "no tests matched": a broken
    suite is a real failure and must block a deploy, whereas a missing test is
    an honest "nobody has written this yet".
    """

    __slots__ = ("outcomes", "suite_error")

    def __init__(self, outcomes: list[TestOutcome], suite_error: str | None = None):
        self.outcomes = outcomes
        self.suite_error = suite_error


def parse_go_test_json(raw: str) -> ReportResult:
    """Parse `go test -json` output.

    The stream is one JSON object per line: {"Action": "run|output|pass|fail|
    skip", "Package": ..., "Test": ..., "Output": ...}. Events without a
    `Test` are package-level; a package-level `fail` with no test outcomes is
    how a compile error arrives, and that is a suite error.
    """
    outcomes: dict[str, TestOutcome] = {}
    output_by_test: dict[str, list[str]] = {}
    package_failed = False
    non_json: list[str] = []

    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        if not line.startswith("{"):
            # Build errors and shell noise ("go: command not found") arrive as
            # plain text alongside the stream.
            non_json.append(line)
            continue
        try:
            event = json.loads(line)
        except ValueError:
            non_json.append(line)
            continue
        if not isinstance(event, dict):
            continue

        action = event.get("Action")
        test = event.get("Test")

        if not test:
            if action == FAIL:
                package_failed = True
            elif action == "output":
                text = event.get("Output")
                if isinstance(text, str):
                    non_json.append(text.rstrip("\n"))
            continue

        if action == "output":
            text = event.get("Output")
            if isinstance(text, str):
                output_by_test.setdefault(test, []).append(text)
        elif action in (PASS, FAIL, SKIP):
            outcomes[test] = TestOutcome(name=test, status=action)

    for name, outcome in outcomes.items():
        if outcome.status == FAIL:
            outcome.output = _truncate("".join(output_by_test.get(name, [])))

    results = list(outcomes.values())
    if package_failed and not any(o.status == FAIL for o in results):
        # The package failed but no individual test did — the suite did not
        # build or a TestMain bailed out. Report it as a suite error.
        return ReportResult(
            results,
            suite_error=_truncate("\n".join(non_json) or "go test failed to run"),
        )
    if not results and non_json:
        joined = "\n".join(non_json)
        # "no tests to run" is the honest empty case, not a broken suite.
        if not re.search(r"no tests to run|no test files", joined, re.IGNORECASE):
            return ReportResult(results, suite_error=_truncate(joined))
    return ReportResult(results)


def parse_junit_xml(raw: str) -> ReportResult:
    """Parse a JUnit XML report (pytest `--junitxml`).

    The runner prints its own output before `cat`-ing the report, so the XML
    is sliced out of the combined stream rather than assumed to start at
    byte 0.
    """
    start = raw.find("<testsuite")
    if start < 0:
        start = raw.find("<?xml")
    if start < 0:
        return ReportResult(
            [],
            suite_error=_truncate(raw or "test runner produced no JUnit report"),
        )

    try:
        root = ElementTree.fromstring(raw[start:])
    except ElementTree.ParseError as e:
        return ReportResult([], suite_error=_truncate(f"unparseable JUnit report: {e}"))

    outcomes: list[TestOutcome] = []
    suite_errors: list[str] = []
    for case in root.iter("testcase"):
        name = case.get("name") or ""
        if not name:
            continue
        failure = case.find("failure")
        if failure is None:
            failure = case.find("error")
        if failure is not None:
            detail = (failure.get("message") or "") + "\n" + (failure.text or "")
            outcomes.append(TestOutcome(name, FAIL, _truncate(detail)))
        elif case.find("skipped") is not None:
            outcomes.append(TestOutcome(name, SKIP))
        else:
            outcomes.append(TestOutcome(name, PASS))

    # A collection error is reported on the suite, not on any test case.
    for suite in root.iter("testsuite"):
        for err in suite.findall("error"):
            detail = (err.get("message") or "") + "\n" + (err.text or "")
            suite_errors.append(detail)

    if suite_errors and not outcomes:
        return ReportResult(outcomes, suite_error=_truncate("\n".join(suite_errors)))
    return ReportResult(outcomes)


def parse_report(framework: str, raw: str) -> ReportResult:
    if framework == FRAMEWORK_GO:
        return parse_go_test_json(raw)
    if framework == FRAMEWORK_PYTEST:
        return parse_junit_xml(raw)
    return ReportResult([], suite_error=f"unsupported test framework {framework!r}")


def verdict_for_requirement(req_id: str, result: ReportResult) -> tuple[str, str]:
    """(verdict, output) for one requirement, given a parsed report.

    Skipped tests are treated as absent: a skipped test is not evidence that
    the requirement holds, and calling it a failure would punish a suite for
    guarding a test behind a flag.
    """
    if result.suite_error:
        return VERDICT_FAIL, result.suite_error

    matching = [o for o in result.outcomes if name_matches_requirement(req_id, o.name)]
    ran = [o for o in matching if o.status != SKIP]
    if not ran:
        return VERDICT_NO_TEST, ""

    failures = [o for o in ran if o.status == FAIL]
    if failures:
        detail = "\n\n".join(
            f"{o.name}\n{o.output}".strip() for o in failures if o.name or o.output
        )
        return VERDICT_FAIL, _truncate(detail)
    return VERDICT_PASS, ""
