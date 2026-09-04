"""The audit environment for a frozen staging image.

Freezing staging pins one image for review. An auditor then needs three things
that the running workspace cannot give them: the source *as deployed to
staging*, the diff between that and what production is serving right now, and
somewhere to write their findings. All three are materialized here, under
``audits/<bp>/<content-sha>/``, at freeze time:

    source/            the audited commit, extracted from the BP's own repo
    production.diff    production..audited, or a note when production is empty
    AUDIT.md           the brief the audit agent is pointed at
    report.md          the report, written by the agent or the auditor

The directory is keyed by the image content hash — the same key the sign-off
store uses — so the evidence and the sign-offs it justifies always refer to the
same image. Unfreezing takes the extracted source away again (it is a copy, and
re-derivable) but keeps the diff and the report: those are the evidence.
"""

import os
import re
import tarfile
from typing import Any

from app.utils import call_git_command_with_output

MAX_REPORT_BYTES = 1024 * 1024
MAX_SEARCH_MATCHES = 200
MAX_SEARCHED_FILE_BYTES = 2 * 1024 * 1024
SKIPPED_DIRS = {".git", "node_modules", "__pycache__", ".venv", "dist", "build"}


def audits_dir() -> str:
    return os.environ.get("BITSWAN_AUDITS_DIR", "/gitops/audits")


def _safe_key(value: str, what: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", value or ""):
        raise ValueError(f"invalid {what}")
    if value in (".", ".."):
        raise ValueError(f"invalid {what}")
    return value


def audit_dir(bp: str, sha: str) -> str:
    return os.path.join(audits_dir(), _safe_key(bp, "bp"), _safe_key(sha, "sha"))


def source_dir(bp: str, sha: str) -> str:
    return os.path.join(audit_dir(bp, sha), "source")


def diff_path(bp: str, sha: str) -> str:
    return os.path.join(audit_dir(bp, sha), "production.diff")


def brief_path(bp: str, sha: str) -> str:
    return os.path.join(audit_dir(bp, sha), "AUDIT.md")


def report_path(bp: str, sha: str) -> str:
    return os.path.join(audit_dir(bp, sha), "report.md")


def _brief(
    bp: str,
    sha: str,
    audited_commit: str,
    production_commit: str | None,
    skipped: list[str] | None = None,
) -> str:
    against = (
        f"`{production_commit[:12]}`, the version production is serving"
        if production_commit
        else "nothing — production has never been deployed"
    )
    left_out = ""
    if skipped:
        listed = "\n".join(f"- `{name}`" for name in sorted(skipped)[:20])
        more = "" if len(skipped) <= 20 else f"\n- …and {len(skipped) - 20} more"
        left_out = (
            "\n## Left out of this copy\n\n"
            "These entries could not be copied — links that point outside the "
            "repository (the scaffold's build-time module links do this). "
            "Say so in the report if any of them matter:\n\n" + listed + more + "\n"
        )
    return f"""# Audit brief — {bp} @ {sha[:12]}

Staging is frozen on this image and cannot be promoted to production until the
audit sign-offs its policy requires are recorded.

- The source you are auditing is in `source/`, extracted at commit
  `{audited_commit[:12]}`. It is a copy: nothing you do here changes what is
  deployed anywhere.
- `production.diff` is the diff against {against}. It is what promoting this
  image would change in production.
- Write your findings to `report.md` in this directory. That file *is* the audit
  report the workspace shows the auditor; there is nowhere else to put it.

A useful report states what changed, what risk each change carries, what you
verified, and what you could not verify.
{left_out}"""


def _member_stays_inside(root: str, name: str) -> bool:
    target = os.path.realpath(os.path.join(root, name))
    return target == root or target.startswith(root + os.sep)


def _extract_within(tar_path: str, dest: str) -> list[str]:
    """Extract an archive into dest, and return what was left out.

    Two kinds of member are left out rather than extracted, and neither is a
    reason to abandon the audit:

    - Anything whose path would land outside dest. `git archive` output is ours,
      not user input, but a report that turns out to be a path-traversal sink is
      a poor kind of evidence.
    - A link the stdlib's `data` filter refuses — most often a symlink to an
      absolute path outside the repository. The business-process scaffold ships
      one (`backend/go.mod` → `/deps/go.mod`, resolved inside the build image),
      and refusing to build an audit environment because a build-time link
      cannot be followed would take the whole audit away over a file the
      auditor does not need.

    The caller names what was skipped in the brief, so the auditor knows the
    copy is not quite the tree.
    """
    os.makedirs(dest, exist_ok=True)
    root = os.path.realpath(dest)
    skipped: list[str] = []
    with tarfile.open(tar_path) as tf:
        for member in tf.getmembers():
            if not _member_stays_inside(root, member.name):
                skipped.append(member.name)
                continue
            try:
                tf.extract(member, dest, filter="data")
            except TypeError:
                # A Python without extraction filters: keep the containment
                # check above and refuse links outright rather than guess.
                if member.issym() or member.islnk():
                    skipped.append(member.name)
                    continue
                tf.extract(member, dest)
            except Exception:
                skipped.append(member.name)
    return skipped


async def prepare(
    bp: str,
    sha: str,
    audited_commit: str,
    production_commit: str | None,
    clone: str,
) -> dict[str, Any]:
    """Materialize the audit environment. Idempotent: re-freezing the same
    image rebuilds the source and the diff and leaves an existing report alone."""
    if not re.fullmatch(r"[0-9a-fA-F]{4,64}", audited_commit or ""):
        raise ValueError("invalid audited commit")
    if production_commit and not re.fullmatch(r"[0-9a-fA-F]{4,64}", production_commit):
        raise ValueError("invalid production commit")
    base = audit_dir(bp, sha)
    os.makedirs(base, exist_ok=True)

    src = source_dir(bp, sha)
    if os.path.isdir(src):
        _rmtree(src)
    tar_path = os.path.join(base, "source.tar")
    _, err, rc = await call_git_command_with_output(
        "git", "archive", "--format=tar", "-o", tar_path, audited_commit, cwd=clone
    )
    if rc != 0:
        raise ValueError(
            f"could not read {bp}@{audited_commit[:12]}: {err.strip()[:200]}"
        )
    try:
        skipped = _extract_within(tar_path, src)
    finally:
        if os.path.exists(tar_path):
            os.remove(tar_path)

    if production_commit:
        out, _, drc = await call_git_command_with_output(
            "git",
            "diff",
            "--no-color",
            f"{production_commit}..{audited_commit}",
            cwd=clone,
        )
        diff = out if drc == 0 else ""
    else:
        diff = ""
    if diff:
        written = diff
    elif not production_commit:
        written = "# No diff: production has nothing deployed for this business process yet.\n"
    else:
        written = "# No differences between the audited version and production.\n"
    with open(diff_path(bp, sha), "w", encoding="utf-8") as fh:
        fh.write(written)

    with open(brief_path(bp, sha), "w", encoding="utf-8") as fh:
        fh.write(_brief(bp, sha, audited_commit, production_commit, skipped))
    if not os.path.exists(report_path(bp, sha)):
        with open(report_path(bp, sha), "w", encoding="utf-8") as fh:
            fh.write("")
    return describe(bp, sha, audited_commit, production_commit)


def _rmtree(path: str) -> None:
    import shutil

    shutil.rmtree(path, ignore_errors=True)


def teardown(bp: str, sha: str) -> None:
    """Drop the extracted source; keep the diff, the brief and the report."""
    _rmtree(source_dir(bp, sha))


def describe(
    bp: str,
    sha: str | None,
    audited_commit: str | None = None,
    production_commit: str | None = None,
) -> dict[str, Any]:
    if not sha:
        return {"ready": False, "sha": None, "reason": "staging is not frozen"}
    base = audit_dir(bp, sha)
    report = report_path(bp, sha)
    src = source_dir(bp, sha)
    # An empty source directory is not an audit environment: the extraction
    # created it and then failed, and calling that ready sends the auditor to
    # a tree with nothing in it.
    ready = os.path.isdir(src) and any(os.scandir(src))
    return {
        "ready": ready,
        "sha": sha,
        "audited_commit": audited_commit,
        "production_commit": production_commit,
        "audit_dir": base,
        "source_dir": source_dir(bp, sha),
        "diff_path": diff_path(bp, sha),
        "report_path": report,
        "report_bytes": os.path.getsize(report) if os.path.exists(report) else 0,
    }


def read_report(bp: str, sha: str) -> dict[str, Any]:
    path = report_path(bp, sha)
    if not os.path.exists(path):
        return {"content": "", "exists": False}
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return {"content": fh.read(MAX_REPORT_BYTES), "exists": True}


def write_report(bp: str, sha: str, content: str) -> dict[str, Any]:
    if len(content.encode("utf-8")) > MAX_REPORT_BYTES:
        raise ValueError("report exceeds 1 MiB")
    base = audit_dir(bp, sha)
    os.makedirs(base, exist_ok=True)
    path = report_path(bp, sha)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(content)
    os.replace(tmp, path)
    return {"ok": True, "bytes": len(content.encode("utf-8"))}


def read_diff(bp: str, sha: str) -> dict[str, Any]:
    path = diff_path(bp, sha)
    if not os.path.exists(path):
        return {"diff": "", "exists": False}
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return {"diff": fh.read(), "exists": True}


def search(
    bp: str, sha: str, query: str, limit: int = MAX_SEARCH_MATCHES
) -> dict[str, Any]:
    """Case-insensitive substring search over the audited source."""
    q = (query or "").strip()
    if not q:
        return {"matches": [], "truncated": False}
    root = source_dir(bp, sha)
    if not os.path.isdir(root):
        return {"matches": [], "truncated": False}
    needle = q.lower()
    matches: list[dict[str, Any]] = []
    truncated = False
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIPPED_DIRS)
        for name in sorted(filenames):
            abs_path = os.path.join(dirpath, name)
            try:
                if os.path.getsize(abs_path) > MAX_SEARCHED_FILE_BYTES:
                    continue
                with open(abs_path, "r", encoding="utf-8") as fh:
                    lines = fh.readlines()
            except (OSError, UnicodeDecodeError):
                continue
            rel = os.path.relpath(abs_path, root)
            for number, line in enumerate(lines, start=1):
                if needle not in line.lower():
                    continue
                if len(matches) >= limit:
                    return {"matches": matches, "truncated": True}
                matches.append(
                    {"path": rel, "line": number, "text": line.rstrip("\n")[:400]}
                )
    return {"matches": matches, "truncated": truncated}
