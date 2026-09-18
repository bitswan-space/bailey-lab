"""Testable requirements: the per-BP contract the test runner executes.

A business process's requirements live in `<bp>/testable-requirements.toml`
as an array of tables:

    [[requirement]]
    id = "REQ-7QX4"
    parent = ""
    description = "/health returns OK"

The file is the CONTRACT ONLY — it deliberately carries no pass/fail state.
Verdicts come from actually running tests (`app.test_runner`) and are held in
memory for the current commit. A `status` key left behind by an older version
of this file is ignored on read and disappears the next time anything writes
the file; nothing migrates it, because a hand-editable verdict is exactly what
this design removes.

The schema is shared with `bitswan-coding-agent requirements …` and the
workspace dashboard, which both read and write the same file.
"""

import logging
import os
import re
import secrets

import toml

from app.services.bp_git import bp_clone_path

logger = logging.getLogger(__name__)

REQUIREMENTS_FILENAME = "testable-requirements.toml"

# Crockford base32 minus the letters it excludes (I, L, O, U) — no character
# pair a human can confuse when reading an id out of a test name.
_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_ID_LEN = 4

# Requirement ids as they may appear in a shell command and a test name.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


class Requirement:
    """One row of the contract.

    `automation` / `runner` are per-requirement overrides of the BP-wide
    `[testing]` defaults in process.toml — a BP with several automations can
    point individual requirements at different containers.
    """

    __slots__ = ("id", "parent", "description", "automation", "runner")

    def __init__(
        self,
        id: str,
        parent: str = "",
        description: str = "",
        automation: str = "",
        runner: str = "",
    ):
        self.id = id
        self.parent = parent
        self.description = description
        self.automation = automation
        self.runner = runner

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "parent": self.parent,
            "description": self.description,
            "automation": self.automation,
            "runner": self.runner,
        }

    def __eq__(self, other) -> bool:
        return isinstance(other, Requirement) and self.to_dict() == other.to_dict()

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Requirement({self.id!r}, parent={self.parent!r})"


class BpTestingConfig:
    """The optional `[testing]` section of a BP's process.toml.

    It lives there rather than in testable-requirements.toml because the
    requirements serialisers (here, the CLI's, and the dashboard's) rewrite
    that file wholesale and would drop a foreign section.
    """

    __slots__ = ("automation", "runner", "framework", "timeout")

    def __init__(
        self,
        automation: str = "",
        runner: str = "",
        framework: str = "",
        timeout: int | None = None,
    ):
        # Which automation's live-dev container runs the tests. Required for a
        # BP with more than one automation, where the deployment cannot be
        # derived from the BP name alone.
        self.automation = automation
        # Free-form runner template (must print a supported report to stdout).
        self.runner = runner
        # "go" | "pytest" — selects the built-in runner + report parser.
        self.framework = framework
        # Per-test timeout in seconds.
        self.timeout = timeout

    def to_dict(self) -> dict:
        return {
            "automation": self.automation,
            "runner": self.runner,
            "framework": self.framework,
            "timeout": self.timeout,
        }


def is_valid_requirement_id(value: str) -> bool:
    """Ids are interpolated into a shell command and matched against test
    names, so they stay strictly `[A-Za-z0-9_-]`."""
    return bool(value) and bool(_ID_RE.match(value))


def requirement_token(req_id: str) -> str:
    """The form an id takes inside a test name: `REQ-7QX4` -> `REQ_7QX4`.

    Hyphens are not legal in a Python or Go identifier, so the convention is
    that the test's NAME carries the id with hyphens turned into underscores.
    """
    return req_id.replace("-", "_")


def name_matches_requirement(req_id: str, test_name: str) -> bool:
    """Does `test_name` claim to be the test for `req_id`?

    The token must not be followed by another alphanumeric — otherwise
    `REQ_100` would be satisfied by a test for `REQ_1000`, and a requirement
    would go green on evidence belonging to a different one.

    There is deliberately NO matching boundary on the left: Go names tests
    `TestREQ_7QX4_Health`, where the token is preceded by the "Test" prefix
    with no separator, and demanding a boundary there would reject every
    idiomatic Go test.
    """
    token = requirement_token(req_id)
    pattern = re.escape(token) + r"(?![A-Za-z0-9])"
    return re.search(pattern, test_name) is not None


def parse_testable_requirements(content: str) -> list[Requirement]:
    """Parse the file's contents. Empty / missing `[[requirement]]` yields [].

    Tolerant per-key: a row is kept as long as it has an `id`, because losing
    a requirement silently is worse than showing one with a blank description.
    Raises ValueError on a syntax error, so a typo surfaces as a message
    rather than an empty list that looks like "no requirements yet".
    """
    if not content or not content.strip():
        return []
    try:
        data = toml.loads(content)
    except toml.TomlDecodeError as e:
        raise ValueError(f"Syntax error in {REQUIREMENTS_FILENAME}: {e}") from e

    rows = data.get("requirement")
    if not isinstance(rows, list):
        return []

    out: list[Requirement] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        req_id = row.get("id")
        if not isinstance(req_id, str) or not req_id:
            continue

        def _str(key: str) -> str:
            value = row.get(key)
            return value if isinstance(value, str) else ""

        # NOTE: `status` is read and discarded on purpose — see module docstring.
        out.append(
            Requirement(
                id=req_id,
                parent=_str("parent"),
                description=_str("description"),
                automation=_str("automation"),
                runner=_str("runner"),
            )
        )
    return out


def serialize_testable_requirements(requirements: list[Requirement]) -> str:
    """Render the array-of-tables form. Optional keys are omitted when empty
    so a file nobody has customised stays as small as it reads."""
    rows = []
    for req in requirements:
        row: dict = {
            "id": req.id,
            "parent": req.parent,
            "description": req.description,
        }
        if req.automation:
            row["automation"] = req.automation
        if req.runner:
            row["runner"] = req.runner
        rows.append(row)
    return toml.dumps({"requirement": rows})


def requirements_path(copy: str | None, bp: str) -> str:
    return os.path.join(bp_clone_path(copy, bp), REQUIREMENTS_FILENAME)


def read_requirements(copy: str | None, bp: str) -> list[Requirement]:
    """Requirements of a BP in a copy. A missing file is an empty contract —
    callers never need to distinguish missing from empty."""
    path = requirements_path(copy, bp)
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
    except FileNotFoundError:
        return []
    return parse_testable_requirements(content)


def write_requirements(
    copy: str | None, bp: str, requirements: list[Requirement]
) -> None:
    """Write the contract back atomically (sibling tmp + rename), so a crash
    mid-write cannot leave a half-parsed file where the contract used to be."""
    path = requirements_path(copy, bp)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(serialize_testable_requirements(requirements))
    os.replace(tmp, path)


def next_requirement_id(
    existing: list[Requirement], prefix: str = "REQ-", _attempts: int = 100
) -> str:
    """Mint an id that no other copy can mint at the same time.

    The old scheme was `max(numeric suffix) + 1`, which is deterministic and
    therefore collides by construction: two copies of the same BP both mint
    `REQ-004`, and merging them silently fuses two different requirements.
    A random suffix makes the ids independent of each other's history.
    """
    taken = {r.id for r in existing}
    for _ in range(_attempts):
        suffix = "".join(secrets.choice(_ID_ALPHABET) for _ in range(_ID_LEN))
        candidate = f"{prefix}{suffix}"
        if candidate not in taken:
            return candidate
    # 32^4 is ~1M; exhausting 100 draws means the file is implausibly large or
    # the RNG is broken. Fail loudly rather than return a duplicate id.
    raise RuntimeError("could not mint a unique requirement id")


def parse_testing_config(process_toml_content: str) -> BpTestingConfig:
    """Read `[testing]` out of a process.toml. A missing file or section is
    the zero value — a single-automation BP needs no configuration at all."""
    if not process_toml_content or not process_toml_content.strip():
        return BpTestingConfig()
    try:
        data = toml.loads(process_toml_content)
    except toml.TomlDecodeError as e:
        raise ValueError(f"Syntax error in process.toml: {e}") from e

    section = data.get("testing")
    if not isinstance(section, dict):
        return BpTestingConfig()

    def _str(key: str) -> str:
        value = section.get(key)
        return value if isinstance(value, str) else ""

    timeout = section.get("timeout")
    if not isinstance(timeout, int) or isinstance(timeout, bool) or timeout <= 0:
        timeout = None

    return BpTestingConfig(
        automation=_str("automation"),
        runner=_str("runner"),
        framework=_str("framework"),
        timeout=timeout,
    )


def read_testing_config(copy: str | None, bp: str) -> BpTestingConfig:
    path = os.path.join(bp_clone_path(copy, bp), "process.toml")
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
    except FileNotFoundError:
        return BpTestingConfig()
    return parse_testing_config(content)


def children_by_parent(requirements: list[Requirement]) -> dict[str, list[str]]:
    """parent id -> child ids, with `""` holding the roots.

    A requirement whose parent does not exist is treated as a root: an orphan
    must stay visible and testable, never vanish because its parent was
    removed.
    """
    known = {r.id for r in requirements}
    out: dict[str, list[str]] = {"": []}
    for req in requirements:
        parent = req.parent if req.parent in known else ""
        out.setdefault(parent, []).append(req.id)
    return out
