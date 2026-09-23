"""A scaffolded template must not carry requirement-named tests.

Requirement ids are minted per business process, so a template cannot know
them. Shipping a test named after one puts a phantom requirement in every BP
created from that template — and an agent asked to "write tests" reads those
files, finds tests for ids nothing declares, and registers requirements to
match. That happened: REQ-D3M0 and REQ-T0D0 were demo ids from the example
business process, scaffolded into every new BP's backend, and duly turned into
real requirements by an agent that had no way to know they were illustrative.

Only the files copied into a BP are checked. The group-root process.toml and
testable-requirements.toml are documentation and are never scaffolded.
"""

import os
import re

import pytest

EXAMPLES_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "examples"
)

# The token form a test name carries, plus the hyphenated form used in prose.
#
# NO leading \b: Go names its tests `TestREQ_D3M0_…`, where the token is
# preceded by "Test" with no separator — a word boundary there matches nothing
# and this guard would silently never fire. The trailing lookahead is what
# keeps it from matching a longer token. (The same asymmetry applies in
# `name_matches_requirement`, for the same reason.)
_REQ_TOKEN = re.compile(r"(REQ|AI)[_-][A-Z0-9]{3,}(?![A-Za-z0-9])")

_SKIP_DIRS = {".git", "node_modules", "__pycache__", "dist", "build", "vendor"}
_MAX_BYTES = 512 * 1024


def _scaffolded_files() -> list[str]:
    """Every file a template would copy into a business process.

    Templates are directories with a template.toml; a group's automations are
    the subdirectories beside its group.toml. In both cases what gets copied is
    the automation directory, never the files next to it.
    """
    out: list[str] = []
    for root, dirs, files in os.walk(EXAMPLES_DIR):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        is_group_root = "group.toml" in files
        for name in files:
            if is_group_root:
                # Files beside a group.toml are not part of any automation.
                continue
            out.append(os.path.join(root, name))
    return out


@pytest.mark.parametrize("path", _scaffolded_files())
def test_no_scaffolded_file_names_a_requirement_id(path):
    try:
        if os.path.getsize(path) > _MAX_BYTES:
            return
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
    except (OSError, UnicodeDecodeError):
        return  # binary or unreadable — nothing to name an id in

    found = sorted({m.group(0) for m in _REQ_TOKEN.finditer(content)})
    assert not found, (
        f"{os.path.relpath(path, EXAMPLES_DIR)} carries requirement id(s) "
        f"{found}. This file is scaffolded into every business process created "
        "from this template, where those ids mean nothing — put illustrative "
        "requirements in the group-root testable-requirements.toml, which is "
        "documentation and is never copied."
    )
