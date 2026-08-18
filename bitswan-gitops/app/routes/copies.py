"""Copy management.

A "copy" is a user's working environment: a plain directory at
``${BITSWAN_COPIES_DIR}/<name>`` whose business-process subdirectories are each
an independent ``git clone`` of that BP's own canonical bare repo
(``<bp>.git`` — see ``app.services.git_server``), checked out on branch
``<name>``. The ``main`` copy is the default-branch scope: each of its BP dirs
is a checkout of that repo's ``main``.

**THE LOAD-BEARING RULE OF THE COPY TREE.** A ``user`` copy is a PERSON'S
environment and is WORKSPACE-WIDE: it carries every business process. An
``experiment`` is a side branch of ONE BUSINESS PROCESS, recorded as ``bp`` in
its ``.copy.json``, and it can never hold a second one. That follows from the
storage: each business process is its OWN git repo, so "an experiment" that
spanned several would be several unrelated branches in several unrelated
repos, merged back and discarded together for no reason other than that one
directory happens to contain them. ``ensure_bp_in_copy`` therefore REFUSES any
business process but the experiment's own (409), and every copy-wide operation
on an experiment (merge-back, pull, status, divergence, history, diff) is
scoped to that single ``bp`` rather than to whatever clones the directory
happens to contain — see :func:`copy_scope_bps`.

**"BEHIND MAIN" IS A PER-BUSINESS-PROCESS FACT, NOT A COPY FACT.** It follows
from the same storage: each business process is its own repo with its own
main, so a copy is never simply "21 commits behind" — it is behind *on
`test33`* and level *on `e2eflow1`*. Treating it as a copy-wide aggregate put
a Sync step in front of a user working on `e2eflow1` and then listed 21
`test33` commits as what would arrive (live-seen, user-reported). So the Sync
step and the Deploy gate read ONE endpoint, ``GET /{name}/divergence?bp=``,
for the business process on screen — the same number, so they cannot
contradict each other. There is deliberately no copy-wide "behind" endpoint:
a second definition of the word is how the two screens disagreed in the first
place.

Experiments created BEFORE this rule carry no ``bp``. They are not guessed at:
:func:`copy_scope_bps` keeps their historical whole-directory behaviour, the
listing reports ``bp_legacy: true`` so the dashboard can group and label them
honestly, and gitops logs each one once (:func:`_note_legacy_experiment`).

Because every BP has its own repo, syncing one BP is a plain push +
fast-forward of that repo's main — it can never entangle another BP's
changes. Copy-level endpoints aggregate over the copy's BP clones so the API
shapes are unchanged from the single-repo era.

Each clone's ``origin`` points at the embedded smart-HTTP git server so agents
push/pull with normal git (fast-forward only; main is deploy-only).
The router is served under ``/copies``.

**The listing carries no git state.** ``_copy_facts`` — what the ``copies`` SSE
event and its cache are built from — is filesystem metadata only: name, branch,
``.copy.json`` (kind/owner/parent/title), whether requirements exist. It
deliberately runs NO git commands, and a test enforces that.

Divergence is answered ON DEMAND, for the one copy (and usually the one
business process) the user is actually looking at:

* ``GET /{name}/divergence``    — ONE business process vs main. This single
  reading gates BOTH the Sync step and the Deploy button (see below)
* ``GET /{name}/divergence-all``— per-business-process breakdown for a copy,
  for the questions that really are copy-wide (what a discard would lose)
* ``GET /{name}/merge-preview`` — an experiment vs its parent (merge-back gate)
* ``GET /{name}/status``        — per-file changes, including uncommitted

Computing any of it eagerly means a ``git fetch`` per (copy, business process)
pair on every git event: on a real workspace that was 75 seconds per pass, and
because the scan's own fetches wrote inside the copy trees it kept retriggering
itself. Please keep new state out of the listing and behind an endpoint.
"""

import asyncio
import datetime
import json
import logging
import os
import re

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.deploy_runner import spawn_set_deploy
from app.services.automation_service import scan_workspace_sources
from app.services.bp_databases import copy_bp_resource_names
from app.services.bp_git import (
    copies_dir as _copies_dir,
)
from app.services.bp_git import (
    clone_bp_into_copy as _clone_bp_into_copy,
)
from app.services.bp_git import (
    MAIN_REF,
    _rm_rf_as_root_in_container,
    fetch_main,
    ff_branch_to_ref,
    ff_main_to_ref,
    list_bp_clones,
    refresh_main_bp_checkout,
)
from app.services.git_server import (
    bp_bare_repo_path,
    bp_main_has_content,
    list_bp_repos,
)
from app.utils import (
    call_git_command,
    call_git_command_with_output,
    read_bitswan_yaml,
)


logger = logging.getLogger(__name__)

# No prefix here — main.py includes this router under /copies.
router = APIRouter(tags=["copies"])


# Copy names are filesystem path segments AND git branch names AND positional
# git args. Rule out path traversal (no `/`, `.`), leading `-` (option
# injection), and empty strings.
_COPY_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9\-]*$")


def _validate_copy_name(name: str) -> None:
    if not name or not _COPY_NAME_RE.match(name):
        raise HTTPException(
            status_code=400,
            detail=(
                "Invalid copy name: must be alphanumeric with hyphens only "
                "and must not start with a hyphen."
            ),
        )


# Looser ref-name check for an optional client-supplied base branch.
_REF_NAME_RE = re.compile(r"^[A-Za-z0-9._/\-]+$")


def _validate_ref_name(name: str) -> None:
    if (
        not name
        or name.startswith("-")
        or not _REF_NAME_RE.match(name)
        or ".." in name
        or "@{" in name
        or name.startswith(("/", "."))
        or name.endswith(("/", ".", ".lock"))
        or "//" in name
    ):
        raise HTTPException(status_code=400, detail="Invalid ref name")


def _resolve_copy_path(name: str) -> str:
    """Validate `name` and return the realpath to the copy directory."""
    _validate_copy_name(name)
    base = os.path.realpath(_copies_dir())
    candidate = os.path.realpath(os.path.join(base, name))
    if candidate != base and not candidate.startswith(base + os.sep):
        raise HTTPException(status_code=400, detail="Invalid copy name")
    return candidate


def _validate_bp_dir(bp: str) -> None:
    if bp in (".", "..") or not re.fullmatch(r"[A-Za-z0-9._-]+", bp or ""):
        raise HTTPException(status_code=400, detail="invalid business process name")


# ── copy metadata (.copy.json) ──────────────────────────────────────────────
# A copy's kind/ownership/parentage is EXPLICIT stored data, never inferred
# from its name. The sidecar is a dot-file, so it is invisible to
# `list_bp_clones` (bp_git) and to the copy scan in `_compute_copies`.

COPY_META_FILE = ".copy.json"
COPY_META_VERSION = 1

# The two kinds of copy that carry metadata. A copy without a sidecar is a
# LEGACY copy: operator-created, unowned, and never an experiment.
COPY_KIND_USER = "user"
COPY_KIND_EXPERIMENT = "experiment"
COPY_KINDS = (COPY_KIND_USER, COPY_KIND_EXPERIMENT)


def _copy_meta_path(copy_path: str) -> str:
    """Path of a copy's metadata sidecar."""
    return os.path.join(copy_path, COPY_META_FILE)


def read_copy_meta(copy_path: str) -> dict | None:
    """Read a copy's `.copy.json`, or None when the copy has no metadata
    (legacy copies predate it). A file that exists but cannot be parsed is a
    hard error — silently treating a corrupt sidecar as "legacy" would demote
    an experiment to an ordinary copy and let the delete/merge guards through
    for the wrong reason."""
    path = _copy_meta_path(copy_path)
    if not os.path.exists(path):
        return None
    with open(path) as f:
        raw = f.read()
    try:
        data = json.loads(raw)
    except ValueError as e:
        raise HTTPException(
            status_code=500, detail=f"Corrupt copy metadata at {path}: {e}"
        ) from e
    if not isinstance(data, dict):
        raise HTTPException(
            status_code=500, detail=f"Corrupt copy metadata at {path}: not an object"
        )
    return data


def experiment_bp(meta: dict | None) -> str | None:
    """The ONE business process an experiment belongs to, from its stored
    metadata — or None when the copy is not an experiment, or is an experiment
    that predates the per-business-process rule.

    Explicit data only. There is deliberately no fallback to "the only clone in
    the directory" or to the copy's name: a legacy experiment whose directory
    grew three clones has no recoverable answer, and inventing one would pick a
    business process the user never chose."""
    if not meta or meta.get("kind") != COPY_KIND_EXPERIMENT:
        return None
    bp = (meta.get("bp") or "").strip()
    return bp or None


# Legacy experiments (no `bp`) are reported once each, not on every scan: the
# copies listing is recomputed on every git event, and a per-event line would
# bury the log for a condition that is static until somebody deletes the copy.
_legacy_experiments_logged: set[str] = set()


def _note_legacy_experiment(name: str) -> None:
    """Log ONCE that an experiment predates the per-business-process rule."""
    if name in _legacy_experiments_logged:
        return
    _legacy_experiments_logged.add(name)
    logger.warning(
        "Experiment '%s' has no 'bp' in its .copy.json: it was started before "
        "experiments were per-business-process, so which process it is about "
        "is not recorded. It is listed as legacy and cannot take on another "
        "business process; discard it and start a new experiment.",
        name,
    )


def copy_scope_bps(copy_path: str, meta: dict | None = None) -> list[str]:
    """The business processes a COPY-WIDE operation covers.

    For an experiment that is exactly the one business process it is about (and
    nothing, if that clone is somehow missing) — never "every clone in the
    directory". Before the per-process rule an experiment could accumulate
    clones through the business-process switcher, and every copy-wide
    operation then silently spanned them: a merge-back carried three unrelated
    repos into the parent, and the divergence figures summed processes the user
    had never opted into.

    For a user copy — a person's whole environment — and for a LEGACY
    experiment with no recorded ``bp``, it is the clones on disk. The legacy
    case is not a guess: it is the behaviour those copies were created under,
    kept unchanged so their contents stay reachable until they are discarded.
    """
    if meta is None:
        meta = read_copy_meta(copy_path)
    bp = experiment_bp(meta)
    if not bp:
        return list_bp_clones(copy_path)
    return [bp] if os.path.isdir(os.path.join(copy_path, bp, ".git")) else []


def assert_copy_can_hold_bp(
    name: str,
    bp: str,
    copy_path: str | None = None,
    meta: dict | None = None,
) -> None:
    """Raise 409 unless copy `name` may carry business process `bp`.

    A person's copy may carry anything — it IS the workspace. An experiment is
    a side branch of exactly one business process and may carry only that one:
    every route that can add a clone to a copy (materialize on switch, create a
    new business process into a copy) goes through here, because an experiment
    that grows a second clone stops being an experiment ON something and
    becomes a whole-workspace copy that merely started from one process.

    The message is actionable rather than a bare refusal: the place to do that
    work is the person's own copy, so it names it.
    """
    if copy_path is None:
        copy_path = _resolve_copy_path(name)
    if meta is None:
        meta = read_copy_meta(copy_path)
    if not meta or meta.get("kind") != COPY_KIND_EXPERIMENT:
        return
    own = experiment_bp(meta)
    title = meta.get("title") or name
    parent = meta.get("parent") or "your own copy"
    if own is None:
        # A legacy experiment: which process it is about was never recorded, so
        # there is no honest answer to "is this its own?". It keeps what it has
        # and gains nothing — no guessing in either direction.
        _note_legacy_experiment(name)
        raise HTTPException(
            status_code=409,
            detail=(
                f"'{title}' is an experiment from before experiments were "
                f"per-business-process, so it cannot take on '{bp}'. Switch "
                f"back to '{parent}' to work on '{bp}'."
            ),
        )
    if bp != own:
        raise HTTPException(
            status_code=409,
            detail=(
                f"'{title}' is an experiment on '{own}'; switch back to "
                f"'{parent}' to work on '{bp}'."
            ),
        )


def write_copy_meta(copy_path: str, meta: dict) -> None:
    """Write a copy's `.copy.json` atomically (temp file + rename), so a reader
    never sees a half-written sidecar."""
    path = _copy_meta_path(copy_path)
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(meta, f, indent=2, sort_keys=True)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# Deployment ids embed the copy name as `<automation>-copy-<copy>-<bp>-<stage>`
# and automation_service classifies/prunes entries by testing for this
# separator (automation_service: `"-copy-" in deployment_id`). A copy whose own
# name contains it would make that parsing ambiguous.
_DEPLOYMENT_ID_COPY_SEPARATOR = "-copy-"

# Per-(copy, BP) live-dev resource names are truncated at 63 chars by
# `copy_bp_resource_names`; a truncated name can collide with another copy's.
# The overhead is measured from that very function (single source of truth)
# against the BPs that exist NOW. Deliberately no speculative reserve for
# future BPs: email-derived user-copy names are routinely ~30 chars, so any
# fixed reserve either rejects real users' copies (a reserve of 32 capped
# names at ~22 chars and broke every /api/me copy create) or is too small to
# guarantee anything. A BP created later that would overflow gets the same
# pre-existing truncation behaviour user copies have always had.


def _copy_name_budget(bp_slug: str) -> int:
    """Longest copy name whose `copy_<name>_bp_<bp>` postgres db name survives
    `copy_bp_resource_names`' 63-char truncation, measured from that function
    rather than re-deriving its format."""
    probe = copy_bp_resource_names("x", bp_slug)["postgres_db"]
    overhead = len(probe) - 1  # everything except the 1-char copy name
    return 63 - overhead


def copy_name_budget() -> int | None:
    """Longest name a NEW copy may have right now, or None when nothing
    constrains it yet (no business processes).

    It depends on the LONGEST business-process slug in the workspace, because
    the limit comes from `copy_<name>_bp_<bp>` being truncated at 63 characters
    — so it shrinks when someone creates a business process with a long name,
    and a caller that hard-codes a number is wrong on some workspaces and right
    on others. Exposed over the API (`GET /copies/name-budget`) so name
    generators ask instead of guessing.
    """
    slugs = list_bp_repos()
    if not slugs:
        return None
    return min(_copy_name_budget(s) for s in slugs)


def _validate_new_copy_name(name: str) -> None:
    """Extra rules applied when a copy is CREATED (existing copies keep
    working): no deployment-id separator, and a length that keeps the
    per-(copy, BP) resource names collision-free."""
    _validate_copy_name(name)
    if _DEPLOYMENT_ID_COPY_SEPARATOR in name:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Invalid copy name: must not contain "
                f"'{_DEPLOYMENT_ID_COPY_SEPARATOR}' (it would make deployment "
                "ids ambiguous)."
            ),
        )
    budget = copy_name_budget()
    if budget is None:
        return  # no BPs yet — nothing to collide with
    if len(name) > budget:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Invalid copy name: at most {budget} characters (longer names "
                "collide once truncated into per-copy database names)."
            ),
        )


def _require_experiment_owner(
    name: str, copy_path: str, not_experiment_detail: str
) -> dict:
    """Guard for the destructive experiment operations (merge-back, discard):
    the copy must carry `kind == "experiment"` metadata and the gate-verified
    requester must be its recorded owner. Fails closed — no metadata, no
    owner recorded, or no forwarded identity all deny."""
    from app.task_queue import current_requester

    meta = read_copy_meta(copy_path)
    if not meta or meta.get("kind") != COPY_KIND_EXPERIMENT:
        raise HTTPException(status_code=400, detail=not_experiment_detail)
    owner = (meta.get("owner") or "").strip()
    requester = (current_requester.get() or "").strip()
    if not owner or not requester or owner != requester:
        raise HTTPException(
            status_code=403,
            detail=f"Only the owner of experiment '{name}' can do this.",
        )
    return meta


class CreateCopyRequest(BaseModel):
    branch_name: str
    base_branch: str = None  # defaults to main
    # Explicit copy metadata (written to `.copy.json`). Omitted entirely =>
    # a legacy, metadata-less copy (the operator-only surface).
    kind: str | None = None  # "user" | "experiment"
    parent: str | None = None  # experiments only: the user copy they branch off
    owner: str | None = None  # email; defaults to the gate-verified requester
    title: str | None = None  # human label (experiments display this, not the name)
    # EXPERIMENTS ONLY, and EXACTLY ONE: the business process the experiment is
    # about — the one the user is looking at when they start it. It is recorded
    # as `bp` in the sidecar and is the only process the experiment will ever
    # hold (`ensure_bp_in_copy` refuses the rest). A list rather than a scalar
    # only because that is the wire shape callers already send; more than one
    # element is a 400, not a silent truncation.
    #
    # Ignored for user copies: a person's copy is their whole working
    # environment and carries every business process.
    bps: list[str] | None = None


# Every business process is its own bare repo and its own clone directory, so
# per-BP git work is independent and runs concurrently. Bounded so a workspace
# with dozens of business processes doesn't fork dozens of git processes at
# once. Sequentially, creating a copy in a 20-BP workspace took two minutes —
# past the ingress timeout, so the user saw "failed" for a copy that was in
# fact being created.
_BP_FANOUT = 8


async def _map_each_bp(bps: list[str], run) -> list:
    """Run `run(bp)` for every BP concurrently, at most `_BP_FANOUT` at a time,
    and return the results IN THE ORDER OF `bps`. The first failure propagates
    — nothing here is best-effort."""
    sem = asyncio.Semaphore(_BP_FANOUT)

    async def _one(bp):
        async with sem:
            return await run(bp)

    return list(await asyncio.gather(*(_one(bp) for bp in bps)))


async def _for_each_bp(bps: list[str], run) -> None:
    """`_map_each_bp` for callers that don't need the results."""
    await _map_each_bp(bps, run)


async def _publish_copy_bp_tip(
    copy_path: str, name: str, bp: str, author: str | None
) -> None:
    """Commit ONE BP clone's working-tree state in copy `name` and push its
    branch to the bare repo, so the copy's CURRENT state for that business
    process is what other clones branch from.

    This is what makes an experiment start from what its parent looks like right
    now, including edits the dashboard wrote straight to disk without
    committing. It runs per business process because an experiment materialises
    per business process (see `ensure_bp_in_copy`) — publishing all of them up
    front meant a commit + push for every BP in the parent whether or not the
    experiment would ever touch it.
    """
    clone = os.path.join(copy_path, bp)
    await _wip_commit(
        clone,
        author,
        ["-A"],
        bp,
        f"Commit work in progress before branching an experiment ({bp})",
    )
    # NOT a plain push: pulling main into a copy REBASES it, which rewrites the
    # copy's history, so its clone is routinely not a fast-forward of the branch
    # the bare still holds — a plain push is then rejected non-fast-forward and
    # starting an experiment fails on exactly the copies that are most up to
    # date (live-seen). A copy's clone is the sole authority for its own branch
    # (nobody else writes refs/heads/<copy>), so publish it the way the rebase
    # route already does: objects travel via a temp ref, then the branch is
    # moved server-side with update-ref, which the ff-only push hook doesn't
    # gate.
    bare = bp_bare_repo_path(bp)
    tip_out, _, _ = await call_git_command_with_output(
        "git", "rev-parse", "HEAD", cwd=clone
    )
    tip = tip_out.strip()
    tmp_ref = f"refs/publish-tmp/{name}"
    p_out, p_err, p_rc = await call_git_command_with_output(
        "git", "push", bare, f"HEAD:{tmp_ref}", cwd=clone
    )
    if p_rc != 0:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Failed to publish '{bp}' branch '{name}': {(p_err or p_out).strip()}"
            ),
        )
    u_out, u_err, u_rc = await call_git_command_with_output(
        "git", "-C", bare, "update-ref", f"refs/heads/{name}", tip
    )
    await call_git_command_with_output("git", "-C", bare, "update-ref", "-d", tmp_ref)
    if u_rc != 0:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Failed to publish '{bp}' branch '{name}': {(u_err or u_out).strip()}"
            ),
        )


@router.get("/name-budget")
async def get_copy_name_budget():
    """`{max_length: N|null}` — the longest name a new copy may have.

    Registered before the `/{name}/…` routes so the literal path wins.

    Name GENERATORS (the dashboard turns an experiment's title into a slug) must
    read this rather than carry their own number: the limit is derived from the
    longest business-process slug in the workspace, so it differs per workspace
    and shrinks when a long-named business process is created. A hard-coded
    budget made "Start a new experiment" fail with a 400 on exactly those
    workspaces, which is what "creating an experiment sometimes fails" was.
    `null` means nothing constrains it yet (no business processes).
    """
    return {"max_length": copy_name_budget()}


@router.post("/create")
async def create_copy(body: CreateCopyRequest):
    """Create a new copy: a directory of per-BP clones, each on a new branch
    named after the copy, with origins set to the smart-HTTP git server.

    Eagerly clones every BP whose main has content (matching the old
    "a new copy starts from main" semantics); BPs that exist only in other
    copies appear here after they are synced into main (or via a pull).

    With ``kind`` (and friends) the copy records explicit metadata in
    `.copy.json`. ``kind="experiment"`` requires ``parent`` — an existing,
    non-experiment copy (the tree is single-level): the base branch is forced
    to the parent's, and the parent's current work is committed + published
    first so the experiment starts from what its owner sees right now.

    An experiment also requires ``bps`` naming EXACTLY ONE business process —
    the one it is about. It is recorded as ``bp`` in the sidecar and is the only
    process the experiment will ever hold.
    """
    from app.task_queue import current_requester

    name = body.branch_name
    _validate_new_copy_name(name)

    kind = body.kind
    if kind is not None and kind not in COPY_KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid copy kind '{kind}': expected one of {', '.join(COPY_KINDS)}",
        )
    if body.parent and kind != COPY_KIND_EXPERIMENT:
        raise HTTPException(
            status_code=400, detail="Only experiments can have a parent copy"
        )

    copy_path = os.path.join(_copies_dir(), name)
    if os.path.exists(copy_path):
        raise HTTPException(status_code=409, detail=f"Copy '{name}' already exists")

    base = "main"
    if body.base_branch:
        _validate_ref_name(body.base_branch)
        base = body.base_branch

    owner = (body.owner or "").strip() or (current_requester.get() or "").strip()
    parent = None
    # The one business process an experiment is about. None for a user copy,
    # which carries every business process by definition.
    exp_bp = None
    if kind == COPY_KIND_EXPERIMENT:
        # WHICH business process is not optional and not plural: each one is its
        # own git repo, so an experiment spanning two would be two unrelated
        # branches merged back and thrown away together. Reject rather than
        # default — an experiment with no process is a real but empty copy the
        # user can do nothing in, and one with several is the workspace-wide
        # copy this rule exists to stop.
        requested = body.bps or []
        if len(requested) == 0:
            raise HTTPException(
                status_code=400,
                detail=(
                    "An experiment is started on a business process: name "
                    "exactly one in 'bps'."
                ),
            )
        if len(requested) > 1:
            raise HTTPException(
                status_code=400,
                detail=(
                    "An experiment belongs to exactly one business process "
                    f"(got {len(requested)}: {', '.join(requested)}). Each "
                    "business process is its own repository, so start one "
                    "experiment per process."
                ),
            )
        exp_bp = requested[0]
        _validate_bp_dir(exp_bp)

        parent = (body.parent or "").strip()
        if not parent:
            raise HTTPException(
                status_code=400, detail="An experiment needs a parent copy"
            )
        parent_path = _resolve_copy_path(parent)
        if not os.path.isdir(parent_path):
            raise HTTPException(
                status_code=400, detail=f"Parent copy '{parent}' not found"
            )
        parent_meta = read_copy_meta(parent_path)
        if parent_meta and parent_meta.get("kind") == COPY_KIND_EXPERIMENT:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"'{parent}' is itself an experiment — experiments branch "
                    "off a person's copy, not off another experiment."
                ),
            )
        base = parent

    os.makedirs(copy_path, exist_ok=True)

    try:
        if kind is not None or body.owner or body.title:
            meta = {
                "version": COPY_META_VERSION,
                "kind": kind or COPY_KIND_USER,
                "owner": owner or None,
                "parent": parent,
                "title": body.title or name,
                "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            }
            # The business process an experiment belongs to, recorded EXPLICITLY
            # — every later guard (ensure, merge-back, divergence) reads it from
            # here rather than inspecting what the directory happens to hold.
            if exp_bp:
                meta["bp"] = exp_bp
            write_copy_meta(copy_path, meta)
        if kind == COPY_KIND_EXPERIMENT:
            # Exactly the one business process the experiment is about — a full
            # git clone + working tree each, so cloning all of them cost over
            # two minutes on a 20-BP workspace for work the user never asked
            # for. There is no "everything else, later": the rest of the
            # workspace belongs to the parent copy, and `ensure_bp_in_copy`
            # refuses to bring it in here.
            if not os.path.isdir(os.path.join(parent_path, exp_bp, ".git")):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"'{exp_bp}' is not in '{parent}', so an experiment on "
                        "it has nothing to branch from"
                    ),
                )
            await _publish_copy_bp_tip(parent_path, parent, exp_bp, owner or None)
            await _clone_bp_into_copy(copy_path, name, exp_bp, base)
        else:
            await _for_each_bp(
                list_bp_repos(),
                lambda bp: _clone_bp_into_copy(copy_path, name, bp, base),
            )
    except HTTPException:
        await _rm_rf_as_root_in_container(copy_path)
        raise

    result = {"name": name, "path": copy_path}

    # Auto-start live-dev for every automation in the new copy (best-effort).
    # A person's copy is their whole working environment, so everything in it
    # comes up front. An EXPERIMENT is a side branch off ONE business process:
    # standing up a live-dev for all of them would run dozens of containers
    # nobody asked for and tear them all down again on discard. The BP the user
    # actually opens is deployed lazily by the wake-on-access path instead.
    if kind != COPY_KIND_EXPERIMENT:
        try:
            members = scan_workspace_sources(_copies_dir(), copy=name)
            res = await spawn_set_deploy(
                label=f"copy:{name}",
                members=members,
                stage="live-dev",
                copy=name,
            )
            if res.get("deploy"):
                result["deploy_task_id"] = res["deploy"]["task_id"]
            elif res.get("error"):
                result["deploy_error"] = res["error"]
        except Exception as e:
            logger.warning("Copy auto-deploy spawn failed for '%s': %s", name, e)
            result["deploy_error"] = str(e)

    return result


# In-memory cache for the copy list, refreshed by the filesystem watcher in
# lifespan.py and broadcast over SSE. None = never computed yet.
_copies_cache: list[dict] | None = None


# Where a clone keeps its view of ANOTHER copy's branch (the parent copy, or an
# experiment) while comparing against or merging it. The same reasoning as
# `MAIN_REF` in bp_git: FETCH_HEAD is one mutable file every concurrent fetch
# in the clone rewrites, so a comparison against it can silently answer about
# somebody else's fetch — or, mid-write, about nothing at all.
PEER_REF = "refs/bitswan/peer"


async def _fetch_peer_branch(clone_path: str, bp: str, branch: str) -> str | None:
    """Fetch copy branch `branch` of `bp` into :data:`PEER_REF` in `clone_path`
    and return its sha, or None when that copy has no branch for this business
    process (the caller decides what that means — usually "the parent doesn't
    carry it yet")."""
    if not await call_git_command(
        "git",
        "fetch",
        "--no-tags",
        bp_bare_repo_path(bp),
        f"+refs/heads/{branch}:{PEER_REF}",
        cwd=clone_path,
    ):
        return None
    out, _, rc = await call_git_command_with_output(
        "git", "rev-parse", PEER_REF, cwd=clone_path
    )
    return out.strip() if rc == 0 else None


async def _bp_clone_parent_divergence(
    clone_path: str, bp: str, parent: str
) -> tuple[int, int]:
    """(ahead, behind) of one experiment clone vs its PARENT copy's branch in
    the bare repo. (0, 0) when the parent has no branch for this BP (the BP
    exists only in the experiment) — a merge-back publishes it instead.

    On-demand only: this is what `/{name}/merge-preview` reads for the ONE
    experiment being looked at. It is deliberately NOT part of the copies
    listing (see `_copy_facts`).
    """
    if await _fetch_peer_branch(clone_path, bp, parent) is None:
        return 0, 0

    async def _count(rng: str) -> int:
        out, _, rc = await call_git_command_with_output(
            "git", "rev-list", "--count", rng, cwd=clone_path
        )
        return int(out.strip()) if rc == 0 and out.strip().isdigit() else 0

    return await _count(f"{PEER_REF}..HEAD"), await _count(f"HEAD..{PEER_REF}")


def _copy_facts(copy_path: str, name: str) -> dict:
    """What a copy IS: its identity and its stored metadata. No git.

    Deliberately excludes every divergence figure (ahead / behind / synced /
    parent_ahead / parent_behind) and the working-tree state (has_changes,
    last commit). Those used to be computed here, for EVERY copy and every
    business process inside it, on every git event — a `git fetch` per
    (copy, BP) pair. On a workspace with 13 copies of ~21 business processes
    that one scan took 75 seconds, and while it ran the `behind` counter the
    Sync step is gated on stayed wrong.

    The UI only ever asks about ONE copy and ONE business process: the copy the
    user is in. So divergence is answered on demand, scoped to what is on
    screen, by endpoints that already exist for exactly that
    (`/{name}/divergence`, `/{name}/divergence-all`, `/{name}/merge-preview`)
    — never eagerly for everything.
    """
    facts = {
        "name": name,
        "branch": name,
        "has_requirements": os.path.exists(
            os.path.join(copy_path, ".requirements.json")
        ),
    }
    meta = read_copy_meta(copy_path)
    if meta:
        facts["kind"] = meta.get("kind")
        facts["owner"] = meta.get("owner")
        facts["parent"] = meta.get("parent")
        facts["title"] = meta.get("title")
        if meta.get("kind") == COPY_KIND_EXPERIMENT:
            bp = experiment_bp(meta)
            if bp:
                facts["bp"] = bp
            else:
                # An experiment from before experiments were per-business
                # process. Reported as such rather than omitted: the dashboard
                # filters experiments by `bp`, and one silently missing from
                # every list is a copy the user can neither find nor discard.
                facts["bp_legacy"] = True
                _note_legacy_experiment(name)
    return facts


async def _compute_copies() -> list[dict]:
    """Enumerate the copies directory and assemble the listing.

    A copy is any non-hidden directory except `main` (the default scope, not a
    user-managed copy). The copy root is a plain directory — its git state
    lives in the per-BP clones inside it.
    """
    copies_base = _copies_dir()
    if not os.path.isdir(copies_base):
        return []

    return [
        _copy_facts(os.path.join(copies_base, entry), entry)
        for entry in sorted(os.listdir(copies_base))
        if not entry.startswith(".")
        and entry != "main"
        and os.path.isdir(os.path.join(copies_base, entry))
    ]


async def get_cached_copies() -> list[dict]:
    """Return the cached copy list, computing on first call."""
    global _copies_cache
    if _copies_cache is None:
        _copies_cache = await _compute_copies()
    return _copies_cache


async def refresh_copies() -> list[dict]:
    """Re-run the copy scan and update the cache (called by the watcher)."""
    global _copies_cache
    _copies_cache = await _compute_copies()
    return _copies_cache


async def refresh_one_copy(name: str) -> list[dict]:
    """Refresh ONE copy's entry in the cache and broadcast the list.

    The targeted counterpart to :func:`refresh_copies`. Both are now cheap —
    the listing is filesystem metadata only (see :func:`_copy_facts`) — but a
    single copy's entry is all that changes when one copy's git state moves, and
    keeping the write narrow keeps the broadcast honest about what happened.
    """
    global _copies_cache
    from app.event_broadcaster import event_broadcaster

    copy_path = _resolve_copy_path(name)
    if not os.path.isdir(copy_path):
        return await get_cached_copies()
    cache = [c for c in await get_cached_copies() if c.get("name") != name]
    cache.append(_copy_facts(copy_path, name))
    cache.sort(key=lambda c: c.get("name") or "")
    _copies_cache = cache
    await event_broadcaster.broadcast("copies", cache)
    return cache


class SyncCopyResponse(BaseModel):
    status: str  # "success" | "needs_rebase"
    method: str | None = None  # "fast-forward" when synced server-side
    message: str
    # Task id of the dev-stage redeploy spawned after a successful sync, so the
    # deployed dev stage tracks main (matches live-dev). None when nothing was
    # deployed (no change, or no deployable members).
    deploy_task_id: str | None = None
    # Per-BP outcomes (additive; one entry per BP the sync touched):
    # [{bp, status, method, deploy_task_id, message}]
    bp_results: list[dict] = []


class SyncCopyRequest(BaseModel):
    # Email of the user who pressed Sync & Deploy, recorded on the deploy tag.
    deployer: str | None = None
    # When set, sync/rebase ONLY this business process. Each BP is its own
    # repo, so the operation is naturally scoped — other BPs are untouched.
    bp: str | None = None


def _ident_args(deployer: str | None) -> list[str]:
    """`-c user.name/email` so commits are attributed to the deployer, not gitops."""
    who = (deployer or "").strip()
    return ["-c", f"user.name={who}", "-c", f"user.email={who}"] if who else []


# How many changed filenames to name in an auto-commit subject before summarizing
# the rest as "(+N more)" — enough to be useful, short enough to stay one line.
_WIP_SUMMARY_MAX = 3


async def _staged_change_summary(clone_path: str) -> str:
    """A short, human-readable phrase describing the staged changes, e.g.
    ``edit config.yaml, main.py`` or ``add handler.py; delete old.py (+2 more)``.

    Derived from ``git diff --cached --name-status`` so the history view shows
    what actually changed rather than a boilerplate "work in progress" line
    (#83). Returns "" when nothing is staged or the diff can't be read, so the
    caller can fall back to a static message."""
    out, _, rc = await call_git_command_with_output(
        "git", "diff", "--cached", "--name-status", cwd=clone_path
    )
    if rc != 0:
        return ""
    # Status letter → verb. Rename/copy report the destination path last.
    verbs = {
        "A": "add",
        "M": "edit",
        "D": "delete",
        "R": "rename",
        "C": "add",
        "T": "edit",
    }
    order = ["edit", "add", "delete", "rename"]
    groups: dict[str, list[str]] = {}
    total = 0
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        verb = verbs.get(parts[0][0], "edit")
        groups.setdefault(verb, []).append(os.path.basename(parts[-1]))
        total += 1
    if total == 0:
        return ""
    shown = 0
    phrases: list[str] = []
    for verb in order:
        names = groups.get(verb)
        if not names or shown >= _WIP_SUMMARY_MAX:
            continue
        take = sorted(names)[: _WIP_SUMMARY_MAX - shown]
        shown += len(take)
        phrases.append(f"{verb} {', '.join(take)}")
    summary = "; ".join(phrases)
    remaining = total - shown
    if remaining > 0:
        summary += f" (+{remaining} more)"
    return summary


async def _wip_commit(
    clone_path: str, deployer: str | None, add_args: list[str], bp: str, fallback: str
) -> None:
    """Stage ``add_args`` and commit if anything was staged (no-op otherwise).

    The commit subject names what changed (``edit config.yaml (bp)``) so the
    history view is readable (#83); ``fallback`` is used only if the staged
    diff can't be summarized."""
    await call_git_command("git", "add", *add_args, cwd=clone_path)
    _, _, clean_rc = await call_git_command_with_output(
        "git", "diff", "--cached", "--quiet", cwd=clone_path
    )
    if clean_rc == 0:
        return  # nothing staged
    summary = await _staged_change_summary(clone_path)
    message = f"{summary} ({bp})" if summary else fallback
    _, c_err, c_rc = await call_git_command_with_output(
        "git", *_ident_args(deployer), "commit", "-m", message, cwd=clone_path
    )
    if c_rc != 0:
        raise HTTPException(
            status_code=500, detail=f"Failed to commit: {c_err.strip()}"
        )


async def _bp_dev_stage_stale(bp: str, service) -> bool:
    """True when the BP's dev stage needs (re)deploying to match its repo's
    main: never deployed, the recorded commit is unknown (e.g. it predates the
    per-BP-repo migration), or the source differs between the deployed commit
    and main's HEAD. Returns False only when dev already reflects main — so
    "Sync & Deploy" is a genuine no-op only when there's truly nothing to do."""
    dev_commit = service.bp_stage_commit(bp, "dev")
    if not dev_commit:
        return True  # never deployed to dev
    main_dir = os.path.join(_copies_dir(), "main", bp)
    if not os.path.isdir(os.path.join(main_dir, ".git")):
        return True  # no main checkout to compare against → let the deploy run
    head_out, _, hrc = await call_git_command_with_output(
        "git", "rev-parse", "HEAD", cwd=main_dir
    )
    if hrc != 0:
        return True  # can't tell → deploy
    main_head = head_out.strip()
    if dev_commit == main_head:
        return False
    # A commit recorded before the per-BP-repo migration doesn't exist in this
    # repo — treat as stale so the first deploy re-records a real commit.
    _, _, known_rc = await call_git_command_with_output(
        "git", "cat-file", "-e", f"{dev_commit}^{{commit}}", cwd=main_dir
    )
    if known_rc != 0:
        return True
    _, _, drc = await call_git_command_with_output(
        "git", "diff", "--quiet", f"{dev_commit}..{main_head}", cwd=main_dir
    )
    return drc != 0  # non-zero exit = there are differences = stale


async def _spawn_dev_deploy(bp: str, deployer: str | None) -> str | None:
    """(Re)deploy a business process's dev stage from main so the deployed dev
    stage tracks main — i.e. once a copy is "fully synced", the dev stage shows
    the same thing as live-dev. Called on every successful sync AND on a no-op
    sync (nothing to merge), since the dev stage can still be behind main.

    Skips when dev already reflects main for this BP (no spurious redeploy).
    Best-effort and non-blocking: bakes/deploys in a background task (mirrors
    the copy-creation auto-deploy) and returns the deploy task id, or None when
    there's nothing to do. Never raises — a sync must not fail because the
    follow-up deploy couldn't start."""
    try:
        from app.dependencies import get_automation_service

        service = get_automation_service()
        members = service.members_for_bp(bp, copy=None, stage="dev")
        if not members:
            return None
        if not await _bp_dev_stage_stale(bp, service):
            logger.info("Dev stage for '%s' already matches main; no redeploy", bp)
            return None
        res = await spawn_set_deploy(
            label=f"sync-deploy:{bp}",
            members=members,
            stage="dev",
            commit_subject=(f"{deployer} synced {bp}" if deployer else None),
            service=service,
            deployed_by=deployer,
            # `members_for_bp` is the BP's whole dev stage, and making dev track
            # main means dropping what main no longer has (#378).
            prune_scope=True,
        )
        deploy = res.get("deploy")
        if res.get("error"):
            logger.warning(
                "Auto dev-deploy after sync failed for '%s': %s", bp, res["error"]
            )
        return deploy["task_id"] if deploy else None
    except Exception as e:
        logger.warning("Auto dev-deploy after sync errored for '%s': %s", bp, e)
        return None


async def _tag_deploy(bp: str, deployer: str | None) -> None:
    """Tag the BP repo's new main tip to record a deploy: an annotated tag
    whose subject is "<email> deployed <date> <time> UTC". These tags are what
    the history view shows as deploy markers on main."""
    bare = bp_bare_repo_path(bp)
    # Annotated tags need a tagger identity; set a mechanical one on the bare
    # repo (idempotent). The human + time live in the tag subject.
    await call_git_command_with_output(
        "git", "-C", bare, "config", "user.email", "bailey@bitswan"
    )
    await call_git_command_with_output(
        "git", "-C", bare, "config", "user.name", "Bailey"
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    who = (deployer or "someone").strip() or "someone"
    subject = f"{who} deployed {now.strftime('%Y-%m-%d %H:%M UTC')}"
    tag = f"deploy/{int(now.timestamp())}"
    await call_git_command_with_output(
        "git", "-C", bare, "tag", "-a", "-f", tag, "-m", subject, "refs/heads/main"
    )


async def _sync_one_bp(
    name: str, copy_path: str, bp: str, deployer: str | None
) -> dict:
    """Sync one BP of a copy into that BP repo's main.

    Commits WIP in the clone (only this BP's files — it's this BP's repo),
    then, IF the clone is a pure fast-forward of main, pushes the branch and
    fast-forwards main server-side. When main HAS advanced, nothing is touched
    and the result is ``needs_rebase`` (the coding agent rebases just this BP).
    Returns {bp, status, method, deploy_task_id, message}.
    """
    clone = os.path.join(copy_path, bp)
    if not os.path.isdir(os.path.join(clone, ".git")):
        raise HTTPException(
            status_code=404, detail=f"'{bp}' is not checked out in copy '{name}'"
        )

    await _wip_commit(
        clone, deployer, ["-A"], bp, f"Sync: commit work in progress ({bp})"
    )
    await fetch_main(clone, bp)

    ahead_out, _, _ = await call_git_command_with_output(
        "git", "rev-list", "--count", f"{MAIN_REF}..HEAD", cwd=clone
    )
    if ahead_out.strip() == "0":
        # Nothing to merge — but the deployed dev stage can still be behind
        # main (e.g. synced from another copy). Bring dev up when it's stale.
        task_id = await _spawn_dev_deploy(bp, deployer)
        return {
            "bp": bp,
            "status": "success",
            "method": "noop",
            "deploy_task_id": task_id,
            "message": f"No changes to '{bp}' to sync into main.",
        }

    _, _, ff_rc = await call_git_command_with_output(
        "git", "merge-base", "--is-ancestor", MAIN_REF, "HEAD", cwd=clone
    )
    if ff_rc != 0:
        return {
            "bp": bp,
            "status": "needs_rebase",
            "method": None,
            "deploy_task_id": None,
            "message": (
                f"'{bp}' has advanced on main since this copy branched; a "
                "rebase is required. Hand off to the coding agent."
            ),
        }

    # Push directly to the local bare repo path (not the smart-HTTP `origin`):
    # gitops has no git credentials for its own HTTP server, and a local push
    # still runs the pre-receive hook (this is a copy branch, so a fast-forward
    # is allowed). This transfers the new commit objects; ff_main_to_ref then
    # advances main with a compare-and-swap update-ref.
    p_out, p_err, p_rc = await call_git_command_with_output(
        "git", "push", bp_bare_repo_path(bp), f"HEAD:refs/heads/{name}", cwd=clone
    )
    if p_rc != 0:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to push '{bp}' branch '{name}': "
            f"{(p_err or p_out).strip()}",
        )

    try:
        await ff_main_to_ref(bp, f"refs/heads/{name}")
    except HTTPException as e:
        if e.status_code == 409:
            # main moved between our fetch and the ref update — same handoff
            # as an ordinary divergence: rebase and retry.
            return {
                "bp": bp,
                "status": "needs_rebase",
                "method": None,
                "deploy_task_id": None,
                "message": f"'{bp}': {e.detail}",
            }
        raise

    await _tag_deploy(bp, deployer)
    await refresh_main_bp_checkout(bp)
    task_id = await _spawn_dev_deploy(bp, deployer)
    return {
        "bp": bp,
        "status": "success",
        "method": "fast-forward",
        "deploy_task_id": task_id,
        "message": f"Synced '{bp}' into main (fast-forward).",
    }


@router.post("/{name}/sync")
async def sync_copy(name: str, body: SyncCopyRequest | None = None):
    """Sync a copy into main, per business process.

    Every BP is its own repo, so a sync is a plain push + server-side
    fast-forward of that repo's main — never a cherry-pick, never entangled
    with other BPs' changes. With ``bp`` set, exactly that BP syncs; without,
    every BP checked out in the copy syncs independently and the response
    aggregates the outcomes (any ``needs_rebase`` surfaces as the overall
    status, naming the BPs that need the coding agent).
    """
    _validate_copy_name(name)
    if name == "main":
        raise HTTPException(
            status_code=400, detail="the main copy cannot be synced with itself"
        )
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    # Defense in depth behind the hidden Deploy tab: an experiment never
    # publishes to main — its work travels through its parent copy.
    meta = read_copy_meta(copy_path)
    if meta and meta.get("kind") == COPY_KIND_EXPERIMENT:
        raise HTTPException(
            status_code=400,
            detail="Experiments merge back into their parent copy",
        )

    deployer = body.deployer if body else None
    bp = body.bp if body else None

    if bp:
        _validate_bp_dir(bp)
        results = [await _sync_one_bp(name, copy_path, bp, deployer)]
    else:
        clones = list_bp_clones(copy_path)
        if not clones:
            return SyncCopyResponse(
                status="success",
                method="noop",
                message="This copy has no business processes to sync.",
            )
        results = [await _sync_one_bp(name, copy_path, b, deployer) for b in clones]

    needs = [r for r in results if r["status"] == "needs_rebase"]
    synced = [r for r in results if r["method"] == "fast-forward"]
    first_task = next(
        (r["deploy_task_id"] for r in results if r["deploy_task_id"]), None
    )

    if needs:
        parts = []
        if synced:
            parts.append(f"synced: {', '.join(r['bp'] for r in synced)}")
        parts.append(f"needs rebase: {', '.join(r['bp'] for r in needs)}")
        return SyncCopyResponse(
            status="needs_rebase",
            message=(
                f"{'; '.join(parts)}. Hand off to the coding agent to rebase "
                "and resolve."
            ),
            deploy_task_id=first_task,
            bp_results=results,
        )
    return SyncCopyResponse(
        status="success",
        method="fast-forward" if synced else "noop",
        message=(
            f"Synced {', '.join(r['bp'] for r in synced)} into main (fast-forward)."
            if synced
            else "Nothing to sync — already up to date with main."
        ),
        deploy_task_id=first_task,
        bp_results=results,
    )


class RebaseCopyResponse(BaseModel):
    status: str  # "success" | "needs_rebase" | "noop"
    message: str
    # BPs whose image dir changed in the pull and were therefore redeployed.
    redeployed_bps: list[str] = []
    # Task ids of the live-dev redeploys spawned for those BPs.
    deploy_task_ids: list[str] = []


async def _spawn_live_dev_deploy(
    members: list[dict], bp: str, copy: str, deployer: str | None
) -> str | None:
    """(Re)deploy the given already-running live-dev members of a BP in a copy
    after a pull changed its image dir. ``members`` is the caller's pre-filtered
    set (only members with an existing live-dev deployment entry). Best-effort,
    non-blocking, never raises — a pull must not fail because the follow-up
    deploy couldn't start."""
    try:
        from app.dependencies import get_automation_service

        service = get_automation_service()
        res = await spawn_set_deploy(
            label=f"pull-redeploy:{copy}:{bp}",
            members=members,
            stage="live-dev",
            commit_subject=(
                f"{deployer} pulled main into {copy}" if deployer else None
            ),
            service=service,
            deployed_by=deployer,
        )
        deploy = res.get("deploy")
        if res.get("error"):
            logger.warning(
                "Live-dev redeploy after pull failed for '%s' in '%s': %s",
                bp,
                copy,
                res["error"],
            )
        return deploy["task_id"] if deploy else None
    except Exception as e:
        logger.warning(
            "Live-dev redeploy after pull errored for '%s' in '%s': %s", bp, copy, e
        )
        return None


def _image_changed_bps(changed_paths: list[str]) -> list[str]:
    """Business processes whose *image dir* changed, from copy-root-relative
    changed paths. An automation's image is built from ``<bp>/<automation>/image/``
    (automation_service checksums exactly that dir), so a pulled change forces a
    rebuild only when it lands inside an ``image/`` directory. Returns the
    top-level BP dirs of such paths. This mirrors the builder's on-disk layout —
    not a guess from names."""
    bps: set[str] = set()
    for p in changed_paths:
        segs = p.split("/")
        # Need <bp>/…/image/<file>: an "image" segment that is neither the first
        # (the BP dir) nor the last (the changed file) component.
        if "image" in segs[1:-1]:
            bps.add(segs[0])
    return sorted(bps)


async def _redeploy_changed_live_dev(
    copy: str, changed_paths: list[str], deployer: str | None
) -> tuple[list[str], list[str]]:
    """Redeploy live-dev in `copy` for the BPs whose image dir changed.

    We never spin up a NEW deployment — only members that already have a
    live-dev deployment entry (matched by deployment_id against bitswan.yaml)
    are refreshed. Shared by "pull main into a copy" and "merge an experiment
    back into its parent"; both change files under the copy and must leave the
    running live-dev serving the new code. Returns (redeployed_bps, task_ids).
    """
    changed_bps = _image_changed_bps(changed_paths)
    if not changed_bps:
        return [], []
    from app.dependencies import get_automation_service

    service = get_automation_service()
    bs = read_bitswan_yaml(service.gitops_dir) or {}
    deployed_ids = set((bs.get("deployments") or {}).keys())
    redeployed: list[str] = []
    task_ids: list[str] = []
    for bp in changed_bps:
        members = [
            m
            for m in service.members_for_bp(bp, copy=copy, stage="live-dev")
            if m.get("deployment_id") in deployed_ids
        ]
        if not members:
            continue  # this BP isn't running live-dev in the copy — nothing to do
        tid = await _spawn_live_dev_deploy(members, bp, copy, deployer)
        redeployed.append(bp)
        if tid:
            task_ids.append(tid)
    return redeployed, task_ids


async def _rebase_one_bp(
    name: str, copy_path: str, bp: str, deployer: str | None
) -> dict:
    """Pull the BP repo's main INTO this copy's clone (rebase the copy branch
    onto main). Clean rebase → the branch is advanced server-side (the rebase
    rewrites history, which the ff-only push hook rejects, so objects travel
    via a temp ref + update-ref). A conflict touches NOTHING and returns
    ``needs_rebase``. Returns {bp, status, pulled, changed_paths} where
    changed_paths are copy-root-relative (``<bp>/…``)."""
    clone = os.path.join(copy_path, bp)
    bare = bp_bare_repo_path(bp)

    await _wip_commit(
        clone,
        deployer,
        ["-A"],
        bp,
        f"Pull: commit work in progress before rebasing {bp} onto main",
    )
    await fetch_main(clone, bp)

    orig_out, _, _ = await call_git_command_with_output(
        "git", "rev-parse", "HEAD", cwd=clone
    )
    orig_head = orig_out.strip()

    behind_out, _, _ = await call_git_command_with_output(
        "git", "rev-list", "--count", f"HEAD..{MAIN_REF}", cwd=clone
    )
    behind = int(behind_out.strip()) if behind_out.strip().isdigit() else 0
    if behind == 0:
        return {"bp": bp, "status": "noop", "pulled": 0, "changed_paths": []}

    _, rb_err, rb_rc = await call_git_command_with_output(
        "git", *_ident_args(deployer), "rebase", MAIN_REF, cwd=clone
    )
    if rb_rc != 0:
        # A non-zero rebase is NOT automatically a conflict. Git leaves a
        # rebase-in-progress directory behind only when it actually started and
        # stopped on one; anything else (it never started — a lock, a bad ref, a
        # dirty tree) exits non-zero with no rebase in progress. Reporting those
        # as `needs_rebase` sent the user to the coding agent to "resolve
        # conflicts" that did not exist, and the abort below then logged
        # `fatal: No rebase in progress?` — the tell that nothing had started.
        # Ask git which happened instead of guessing.
        conflicted = any(
            os.path.isdir(os.path.join(clone, ".git", d))
            for d in ("rebase-merge", "rebase-apply")
        )
        if conflicted:
            await call_git_command("git", "rebase", "--abort", cwd=clone)
        await call_git_command_with_output(
            "git", "reset", "--hard", orig_head, cwd=clone
        )
        if conflicted:
            return {
                "bp": bp,
                "status": "needs_rebase",
                "pulled": 0,
                "changed_paths": [],
            }
        why = rb_err.strip() or f"git rebase exited {rb_rc} with no output"
        raise HTTPException(
            status_code=500,
            detail=(
                f"Pulling main into '{bp}' failed before any rebase started "
                f"(nothing was changed): {why}"
            ),
        )

    new_out, _, _ = await call_git_command_with_output(
        "git", "rev-parse", "HEAD", cwd=clone
    )
    new_tip = new_out.strip()

    tmp_ref = f"refs/pull-tmp/{name}"
    _, tp_err, tp_rc = await call_git_command_with_output(
        "git", "push", bare, f"HEAD:{tmp_ref}", cwd=clone
    )
    if tp_rc != 0:
        await call_git_command_with_output(
            "git", "reset", "--hard", orig_head, cwd=clone
        )
        raise HTTPException(
            status_code=500,
            detail=f"Failed to publish rebased '{bp}': {tp_err.strip()}",
        )
    await call_git_command_with_output(
        "git", "-C", bare, "update-ref", f"refs/heads/{name}", new_tip
    )
    await call_git_command_with_output("git", "-C", bare, "update-ref", "-d", tmp_ref)

    diff_out, _, _ = await call_git_command_with_output(
        "git", "diff", "--name-only", f"{orig_head}..{new_tip}", cwd=clone
    )
    changed_paths = [f"{bp}/{p}" for p in diff_out.splitlines() if p.strip()]
    return {
        "bp": bp,
        "status": "success",
        "pulled": behind,
        "changed_paths": changed_paths,
    }


@router.post("/{name}/bp/{bp}/ensure")
async def ensure_bp_in_copy(name: str, bp: str):
    """Make business process `bp` exist in copy `name`, cloning it fresh from the
    BP repo's main when the copy doesn't carry it yet. Idempotent — a no-op
    (``already: True``) when the clone is already there. This is what lets the
    copy switcher offer EVERY copy for a BP: selecting a copy that lacks the BP
    materializes it here instead of the copy being hidden. 404 only when the BP
    has no repo content on main to clone from.

    AN EXPERIMENT REFUSES EVERY BUSINESS PROCESS BUT ITS OWN (409). An
    experiment is a side branch of the ONE process recorded in its
    `.copy.json`; materializing another here is what turned experiments into
    whole-workspace copies that merely started from one process (live-seen: an
    experiment started on one business process ended up holding three clones,
    because the process switcher called this endpoint inside it). The work
    belongs in the person's own copy, and the message says so."""
    from app.task_queue import current_requester

    _validate_copy_name(name)
    _validate_bp_dir(bp)
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")
    meta = read_copy_meta(copy_path)
    assert_copy_can_hold_bp(name, bp, copy_path=copy_path, meta=meta)
    if os.path.isdir(os.path.join(copy_path, bp, ".git")):
        return {"ok": True, "already": True, "copy": name, "bp": bp}
    base = "main"
    if meta and meta.get("kind") == COPY_KIND_EXPERIMENT and meta.get("parent"):
        base = meta["parent"]
        parent_clone = os.path.join(_resolve_copy_path(base), bp)
        if os.path.isdir(os.path.join(parent_clone, ".git")):
            await _publish_copy_bp_tip(
                _resolve_copy_path(base),
                base,
                bp,
                (meta.get("owner") or current_requester.get() or "").strip() or None,
            )
    if not await _clone_bp_into_copy(copy_path, name, bp, base):
        raise HTTPException(
            status_code=404,
            detail=f"'{bp}' has no repo content on main to clone into '{name}'",
        )
    await refresh_copies()  # the copy now carries the BP — refresh the cache
    return {"ok": True, "already": False, "copy": name, "bp": bp}


@router.post("/{name}/rebase")
async def rebase_copy(name: str, body: SyncCopyRequest | None = None):
    """Pull main's new commits INTO a copy — per business process. This is the
    opposite direction from ``/sync`` (which publishes the copy's commits TO
    main).

    With ``bp`` set only that BP is pulled; without, every BP is pulled — and
    main-carrying BPs the copy doesn't have yet are materialized as fresh
    clones (that's how a copy gains a BP another copy created). Any business
    process whose *image dir* changed in the pull gets its live-dev stage
    redeployed (a config-only change needs no rebuild). A conflict in a BP
    touches nothing in that BP and reports ``needs_rebase`` so the caller hands
    off to the coding agent.

    In an EXPERIMENT this is scoped to the one business process the experiment
    is about, and materializes nothing: "gain every business process main
    carries" is what a person's copy is for."""
    _validate_copy_name(name)
    if name == "main":
        raise HTTPException(
            status_code=400, detail="the main copy has nothing to pull into"
        )
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    deployer = body.deployer if body else None
    only_bp = body.bp if body else None
    meta = read_copy_meta(copy_path)
    own_bp = experiment_bp(meta)

    if only_bp:
        _validate_bp_dir(only_bp)
        if own_bp and only_bp != own_bp:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"'{meta.get('title') or name}' is an experiment on "
                    f"'{own_bp}'; it has no '{only_bp}' to pull into."
                ),
            )
        if not os.path.isdir(os.path.join(copy_path, only_bp, ".git")):
            if not await _clone_bp_into_copy(copy_path, name, only_bp):
                raise HTTPException(
                    status_code=404,
                    detail=f"'{only_bp}' has no repo content to pull",
                )
        bps = [only_bp]
    elif own_bp:
        bps = copy_scope_bps(copy_path, meta)
    else:
        existing = set(list_bp_clones(copy_path))
        for candidate in list_bp_repos():
            if candidate not in existing and await bp_main_has_content(candidate):
                await _clone_bp_into_copy(copy_path, name, candidate)
        bps = list_bp_clones(copy_path)

    results = await _map_each_bp(
        bps, lambda b: _rebase_one_bp(name, copy_path, b, deployer)
    )

    conflicts = [r["bp"] for r in results if r["status"] == "needs_rebase"]
    pulled_total = sum(r["pulled"] for r in results)
    changed_paths = [p for r in results for p in r["changed_paths"]]

    # The copy's ahead/behind just changed. Recompute and broadcast THIS copy
    # now instead of waiting for the watcher's full rescan: the Sync step lives
    # or dies on `behind`, and a stale counter leaves the user on a tab whose
    # button does nothing.
    await refresh_one_copy(name)

    # Redeploy live-dev ONLY for BPs whose image dir changed in the pull AND
    # that already run live-dev in THIS copy.
    redeployed, task_ids = await _redeploy_changed_live_dev(
        name, changed_paths, deployer
    )

    if conflicts:
        return RebaseCopyResponse(
            status="needs_rebase",
            message=(
                f"Main couldn't be pulled in automatically for: "
                f"{', '.join(conflicts)} (conflict) — hand off to the coding "
                "agent to rebase and resolve."
            ),
            redeployed_bps=redeployed,
            deploy_task_ids=task_ids,
        )
    if pulled_total == 0:
        return RebaseCopyResponse(
            status="noop", message="Already up to date with main."
        )
    msg = f"Pulled {pulled_total} change(s) from main into '{name}'."
    if redeployed:
        msg += f" Redeploying live-dev for: {', '.join(redeployed)}."
    return RebaseCopyResponse(
        status="success",
        message=msg,
        redeployed_bps=redeployed,
        deploy_task_ids=task_ids,
    )


class MergeToParentResponse(BaseModel):
    status: str  # "success" | "needs_rebase" | "noop"
    message: str
    # Per-BP outcomes: [{bp, status, method, message}]
    bp_results: list[dict] = []
    # BPs whose image dir changed in the parent and were therefore redeployed.
    redeployed_bps: list[str] = []
    # Task ids of the parent's live-dev redeploys.
    deploy_task_ids: list[str] = []


async def _rebase_experiment_onto_parent(
    exp_clone: str, bare: str, bp: str, name: str, parent: str, deployer: str | None
) -> bool:
    """Rebase an experiment's clone onto the parent copy's branch tip.

    True on a clean rebase — the rewritten branch is published to the bare (a
    rewrite is not a fast-forward, so the objects travel via a temp ref and the
    branch is moved server-side, exactly as ``_rebase_one_bp`` does for main).
    False on a conflict: the rebase is aborted, the clone reset to where it
    was, nothing is published and the PARENT is not touched at all — the caller
    turns that into ``needs_rebase`` and hands off to the coding agent.
    """
    if await _fetch_peer_branch(exp_clone, bp, parent) is None:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to fetch '{parent}' into the experiment clone",
        )
    orig_out, _, _ = await call_git_command_with_output(
        "git", "rev-parse", "HEAD", cwd=exp_clone
    )
    orig_head = orig_out.strip()

    _, _, rb_rc = await call_git_command_with_output(
        "git", *_ident_args(deployer), "rebase", PEER_REF, cwd=exp_clone
    )
    if rb_rc != 0:
        await call_git_command("git", "rebase", "--abort", cwd=exp_clone)
        await call_git_command_with_output(
            "git", "reset", "--hard", orig_head, cwd=exp_clone
        )
        return False

    new_out, _, _ = await call_git_command_with_output(
        "git", "rev-parse", "HEAD", cwd=exp_clone
    )
    new_tip = new_out.strip()
    tmp_ref = f"refs/merge-tmp/{name}"
    _, tp_err, tp_rc = await call_git_command_with_output(
        "git", "push", bare, f"HEAD:{tmp_ref}", cwd=exp_clone
    )
    if tp_rc != 0:
        await call_git_command_with_output(
            "git", "reset", "--hard", orig_head, cwd=exp_clone
        )
        raise HTTPException(
            status_code=500,
            detail=f"Failed to publish the rebased experiment branch: {tp_err.strip()}",
        )
    await call_git_command_with_output(
        "git", "-C", bare, "update-ref", f"refs/heads/{name}", new_tip
    )
    await call_git_command_with_output("git", "-C", bare, "update-ref", "-d", tmp_ref)
    return True


async def _merge_one_bp_to_parent(
    name: str,
    copy_path: str,
    parent: str,
    parent_path: str,
    bp: str,
    deployer: str | None,
    title: str,
) -> dict:
    """Merge ONE business process of an experiment back into its parent copy.

    The merge happens in the PARENT'S CLONE (wip-commit the parent → merge →
    push): the parent is somebody's live working tree, so its uncommitted work
    is captured first and never reset away. Main is not involved — no deploy
    tags, no dev-stage deploy: this is copy → copy.

    Returns {bp, status, method, message, changed_paths} with changed_paths
    copy-root-relative (``<bp>/…``) for the parent's live-dev redeploy.
    """
    exp_clone = os.path.join(copy_path, bp)
    bare = bp_bare_repo_path(bp)

    await _wip_commit(
        exp_clone,
        deployer,
        ["-A"],
        bp,
        f"Merge: commit work in progress in experiment {title} ({bp})",
    )

    async def _publish_experiment_branch() -> None:
        p_out, p_err, p_rc = await call_git_command_with_output(
            "git", "push", bare, f"HEAD:refs/heads/{name}", cwd=exp_clone
        )
        if p_rc != 0:
            raise HTTPException(
                status_code=500,
                detail=(
                    f"Failed to push '{bp}' branch '{name}': "
                    f"{(p_err or p_out).strip()}"
                ),
            )

    await _publish_experiment_branch()

    parent_clone = os.path.join(parent_path, bp)
    if not os.path.isdir(os.path.join(parent_clone, ".git")):
        # A BP born inside the experiment: the parent gains it wholesale — the
        # experiment's tip BECOMES the parent's branch, then the parent's
        # working clone is materialized from it.
        head_out, _, hrc = await call_git_command_with_output(
            "git", "rev-parse", "HEAD", cwd=exp_clone
        )
        if hrc != 0:
            raise HTTPException(
                status_code=500, detail=f"cannot resolve HEAD in {exp_clone}"
            )
        # Create-only compare-and-swap: the empty <oldvalue> makes update-ref
        # fail if the parent branch appeared meanwhile.
        u_out, u_err, u_rc = await call_git_command_with_output(
            "git",
            "-C",
            bare,
            "update-ref",
            f"refs/heads/{parent}",
            head_out.strip(),
            "",
        )
        if u_rc != 0:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"'{parent}' gained a branch for '{bp}' during the merge — "
                    f"retry: {(u_err or u_out).strip()}"
                ),
            )
        if not await _clone_bp_into_copy(parent_path, parent, bp, name):
            raise HTTPException(
                status_code=500,
                detail=f"Failed to materialize '{bp}' in copy '{parent}'",
            )
        return {
            "bp": bp,
            "status": "success",
            "method": "published",
            "message": f"'{bp}' was created in this experiment and now exists in '{parent}'.",
            # A BP the parent never had cannot be running live-dev there.
            "changed_paths": [],
        }

    await _wip_commit(
        parent_clone,
        deployer,
        ["-A"],
        bp,
        f"WIP before merging experiment {title} ({bp})",
    )
    pp_out, pp_err, pp_rc = await call_git_command_with_output(
        "git", "push", bare, f"HEAD:refs/heads/{parent}", cwd=parent_clone
    )
    if pp_rc != 0:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Failed to push '{bp}' branch '{parent}': "
                f"{(pp_err or pp_out).strip()}"
            ),
        )

    before_out, _, _ = await call_git_command_with_output(
        "git", "rev-parse", "HEAD", cwd=parent_clone
    )
    before = before_out.strip()

    async def _fetch_experiment() -> None:
        if await _fetch_peer_branch(parent_clone, bp, name) is None:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to fetch '{name}' into the '{parent}' clone",
            )

    await _fetch_experiment()

    async def _ahead() -> int:
        out, _, rc = await call_git_command_with_output(
            "git", "rev-list", "--count", f"HEAD..{PEER_REF}", cwd=parent_clone
        )
        return int(out.strip()) if rc == 0 and out.strip().isdigit() else 0

    if await _ahead() == 0:
        return {
            "bp": bp,
            "status": "noop",
            "method": "noop",
            "message": f"No changes to '{bp}' to merge into '{parent}'.",
            "changed_paths": [],
        }

    async def _parent_is_ancestor() -> bool:
        _, _, rc = await call_git_command_with_output(
            "git", "merge-base", "--is-ancestor", "HEAD", PEER_REF, cwd=parent_clone
        )
        return rc == 0

    if not await _parent_is_ancestor():
        # The parent moved on since the experiment branched: replay the
        # experiment on top of the parent first, so the merge stays a
        # fast-forward and the parent's history is never rewritten.
        if not await _rebase_experiment_onto_parent(
            exp_clone, bare, bp, name, parent, deployer
        ):
            return {
                "bp": bp,
                "status": "needs_rebase",
                "method": None,
                "message": (
                    f"'{bp}' conflicts with '{parent}'; a rebase is required. "
                    "Hand off to the coding agent."
                ),
                "changed_paths": [],
            }
        await _fetch_experiment()
        if not await _parent_is_ancestor():
            return {
                "bp": bp,
                "status": "needs_rebase",
                "method": None,
                "message": (
                    f"'{parent}' moved while '{bp}' was being rebased — retry the "
                    "merge."
                ),
                "changed_paths": [],
            }

    m_out, m_err, m_rc = await call_git_command_with_output(
        "git", "merge", "--ff-only", PEER_REF, cwd=parent_clone
    )
    if m_rc != 0:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to merge '{bp}' into '{parent}': {(m_err or m_out).strip()}",
        )
    mp_out, mp_err, mp_rc = await call_git_command_with_output(
        "git", "push", bare, f"HEAD:refs/heads/{parent}", cwd=parent_clone
    )
    if mp_rc != 0:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Failed to publish '{parent}' for '{bp}': "
                f"{(mp_err or mp_out).strip()}"
            ),
        )
    # Server-side compare-and-swap: the sanctioned way a branch advances in a
    # bare repo (idempotent after the push above, which sent the objects).
    await ff_branch_to_ref(bp, parent, f"refs/heads/{name}")

    after_out, _, _ = await call_git_command_with_output(
        "git", "rev-parse", "HEAD", cwd=parent_clone
    )
    after = after_out.strip()
    diff_out, _, _ = await call_git_command_with_output(
        "git", "diff", "--name-only", f"{before}..{after}", cwd=parent_clone
    )
    return {
        "bp": bp,
        "status": "success",
        "method": "fast-forward",
        "message": f"Merged '{bp}' into '{parent}' (fast-forward).",
        "changed_paths": [f"{bp}/{p}" for p in diff_out.splitlines() if p.strip()],
    }


@router.post("/{name}/merge-to-parent")
async def merge_copy_to_parent(name: str, body: SyncCopyRequest | None = None):
    """Merge an EXPERIMENT back into the copy it branched from.

    Experiments never publish to main: their work travels back into their
    parent copy, and the parent's owner deploys it from there. So this endpoint
    writes nothing on main, tags no deploy and touches no dev stage — it is a
    copy → copy fast-forward performed inside the parent's own clone (its
    uncommitted work is committed first, never reset away).

    Guards: the copy must be an experiment (`.copy.json` kind) and the
    gate-verified requester must be its owner. Per BP: nothing to merge →
    ``noop``; the parent has moved on → the EXPERIMENT is rebased onto it
    first, and a conflict there leaves the parent byte-identical and reports
    ``needs_rebase`` (hand off to the coding agent, on the experiment); a BP
    that exists only in the experiment is published into the parent. After the
    merge, the PARENT's live-dev is redeployed for every BP whose image dir
    changed.
    """
    from app.task_queue import current_requester

    _validate_copy_name(name)
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    meta = _require_experiment_owner(
        name, copy_path, "Only experiments can be merged into a parent copy"
    )
    parent = meta.get("parent") or ""
    _validate_copy_name(parent)
    parent_path = _resolve_copy_path(parent)
    if not os.path.isdir(parent_path):
        raise HTTPException(status_code=404, detail=f"Parent copy '{parent}' not found")
    title = meta.get("title") or name

    deployer = (body.deployer if body else None) or current_requester.get()
    only_bp = body.bp if body else None

    # An experiment merges back exactly what it is about. Not `list_bp_clones`:
    # a legacy experiment's directory can hold clones of processes it was never
    # started on, and carrying those into the parent is the whole-workspace
    # merge this rule exists to stop. `copy_scope_bps` keeps the historical
    # behaviour for legacy experiments (nothing else can be honest about them)
    # and is the single recorded process for every experiment made since.
    if only_bp:
        _validate_bp_dir(only_bp)
        own_bp = experiment_bp(meta)
        if own_bp and only_bp != own_bp:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"'{title}' is an experiment on '{own_bp}'; it has no "
                    f"'{only_bp}' to merge."
                ),
            )
        if not os.path.isdir(os.path.join(copy_path, only_bp, ".git")):
            raise HTTPException(
                status_code=404,
                detail=f"'{only_bp}' is not checked out in copy '{name}'",
            )
        bps = [only_bp]
    else:
        bps = copy_scope_bps(copy_path, meta)

    if not bps:
        return MergeToParentResponse(
            status="noop", message="This experiment has no business processes to merge."
        )

    results = await _map_each_bp(
        bps,
        lambda bp: _merge_one_bp_to_parent(
            name, copy_path, parent, parent_path, bp, deployer, title
        ),
    )

    changed_paths = [p for r in results for p in r["changed_paths"]]
    redeployed, task_ids = await _redeploy_changed_live_dev(
        parent, changed_paths, deployer
    )

    wire = [{k: v for k, v in r.items() if k != "changed_paths"} for r in results]
    needs = [r for r in results if r["status"] == "needs_rebase"]
    merged = [r for r in results if r["status"] == "success"]

    if needs:
        parts = []
        if merged:
            parts.append(f"merged: {', '.join(r['bp'] for r in merged)}")
        parts.append(f"needs rebase: {', '.join(r['bp'] for r in needs)}")
        return MergeToParentResponse(
            status="needs_rebase",
            message=(
                f"{'; '.join(parts)}. Hand off to the coding agent to rebase the "
                f"experiment onto '{parent}' and resolve."
            ),
            bp_results=wire,
            redeployed_bps=redeployed,
            deploy_task_ids=task_ids,
        )
    if not merged:
        return MergeToParentResponse(
            status="noop",
            message=f"Nothing to merge — '{parent}' already has this experiment's work.",
            bp_results=wire,
        )
    msg = f"Merged {', '.join(r['bp'] for r in merged)} into '{parent}'."
    if redeployed:
        msg += f" Redeploying live-dev for: {', '.join(redeployed)}."
    return MergeToParentResponse(
        status="success",
        message=msg,
        bp_results=wire,
        redeployed_bps=redeployed,
        deploy_task_ids=task_ids,
    )


@router.get("/{name}/merge-preview")
async def get_merge_to_parent_preview(name: str):
    """What "Merge back into my copy" would actually carry into the parent.

    Read live, and measured against the PARENT copy — never against main. An
    experiment inherits its parent's whole divergence from main, so a
    main-based signal (``/status``) reports changes forever, even for an
    experiment whose work is already in the parent: the merge button would
    stay lit and every press would come back ``noop``.

    ``ahead`` counts commits the parent's branch lacks, ``uncommitted`` lists
    the working-tree edits the merge commits first, and ``new_bps`` names the
    business processes born in this experiment (the merge publishes those into
    the parent wholesale). All three empty means the merge is a no-op.
    """
    _validate_copy_name(name)
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    meta = read_copy_meta(copy_path)
    if not meta or meta.get("kind") != COPY_KIND_EXPERIMENT:
        raise HTTPException(
            status_code=400,
            detail=f"Copy '{name}' is not an experiment — it has no parent to merge into",
        )
    parent = meta.get("parent") or ""
    _validate_copy_name(parent)

    async def _preview_one(bp: str) -> dict:
        clone_path = os.path.join(copy_path, bp)
        _, _, ref_rc = await call_git_command_with_output(
            "git",
            "-C",
            bp_bare_repo_path(bp),
            "rev-parse",
            "--verify",
            "--quiet",
            f"refs/heads/{parent}",
        )
        if ref_rc != 0:
            # The parent has no branch for this BP: it was created inside the
            # experiment and the merge publishes it.
            one = {"bp": bp, "new": True, "ahead": 0, "behind": 0}
        else:
            a, b = await _bp_clone_parent_divergence(clone_path, bp, parent)
            one = {"bp": bp, "new": False, "ahead": a, "behind": b}
        st_out, _, _ = await call_git_command_with_output(
            "git", "status", "--porcelain", cwd=clone_path
        )
        one["uncommitted"] = [
            f"{bp}/{line[3:].strip()}"
            for line in st_out.splitlines()
            if line[3:].strip()
        ]
        return one

    per_bp = await _map_each_bp(copy_scope_bps(copy_path, meta), _preview_one)
    ahead = sum(o["ahead"] for o in per_bp)
    behind = sum(o["behind"] for o in per_bp)
    new_bps = [o["bp"] for o in per_bp if o["new"]]
    uncommitted = [p for o in per_bp for p in o["uncommitted"]]

    return {
        "parent": parent,
        "ahead": ahead,
        "behind": behind,
        "uncommitted": uncommitted,
        "new_bps": new_bps,
    }


def _is_safe_relative_path(p: str) -> bool:
    if not p:
        return False
    if p.startswith("/") or p.startswith("\\"):
        return False
    parts = re.split(r"[\\/]", p)
    return not any(seg in ("", "..") for seg in parts)


_NAME_STATUS_KIND = {
    "A": "added",
    "M": "modified",
    "D": "deleted",
    "R": "renamed",
    "C": "copied",
    "T": "modified",
}


async def _clone_status_of(clone_path: str, bp: str) -> dict:
    """One BP clone's change list, keyed by path and prefixed ``<bp>/…`` so the
    paths stay copy-root-relative (the wire shape of the single-repo era)."""
    by_path: dict[str, dict] = {}
    await fetch_main(clone_path, bp)

    # Tracked delta vs main (commits ahead of main + staged/unstaged edits).
    # --no-renames so paths stay real (a rename becomes delete + add) — the UI
    # uses each path to fetch its per-file diff.
    num_out, _, _ = await call_git_command_with_output(
        "git", "diff", "--no-renames", "--numstat", MAIN_REF, cwd=clone_path
    )
    for line in num_out.splitlines():
        parts = line.split("\t", 2)
        if len(parts) != 3:
            continue
        adds_str, dels_str, p = parts
        full = f"{bp}/{p}"
        by_path[full] = {
            "path": full,
            "kind": "modified",
            "adds": int(adds_str) if adds_str.isdigit() else 0,
            "dels": int(dels_str) if dels_str.isdigit() else 0,
        }
    ns_out, _, _ = await call_git_command_with_output(
        "git", "diff", "--no-renames", "--name-status", MAIN_REF, cwd=clone_path
    )
    for line in ns_out.splitlines():
        cols = line.split("\t")
        if len(cols) < 2:
            continue
        kind = _NAME_STATUS_KIND.get(cols[0][:1], "modified")
        full = f"{bp}/{cols[-1]}"  # for renames, the new path
        if full in by_path:
            by_path[full]["kind"] = kind
        else:
            by_path[full] = {"path": full, "kind": kind, "adds": 0, "dels": 0}

    # New untracked files (not in main and not yet committed) — the whole file
    # becomes main, so surface it as added.
    others_out, _, _ = await call_git_command_with_output(
        "git", "ls-files", "--others", "--exclude-standard", cwd=clone_path
    )
    for p in others_out.splitlines():
        p = p.strip()
        if not p:
            continue
        full = f"{bp}/{p}"
        if full not in by_path:
            by_path[full] = {"path": full, "kind": "added", "adds": 0, "dels": 0}
    return by_path


class DeleteCopyRequest(BaseModel):
    # Injected by the dashboard proxy from the validated token. ATTRIBUTION
    # only — authorization comes from the gate-forwarded identity header
    # (`current_requester`) matched against the experiment's recorded owner.
    deleted_by: str | None = None


@router.delete("/{name}", status_code=202)
async def delete_copy_route(name: str, body: DeleteCopyRequest | None = None) -> dict:
    """Discard an EXPERIMENT — asynchronous, idempotent.

    Only experiments are deletable, and only by their owner: a person's own
    copy (and a legacy, metadata-less copy) is their working environment and
    has no delete affordance at all — 400. `main` likewise. The requester is
    the gate-verified identity (`X-Forwarded-Email`), compared against the
    `owner` recorded in the experiment's `.copy.json`; anything else is 403.

    Removes the copy's live-dev deployments + containers + gateways, its
    per-(copy, BP) databases, its branch in every BP bare repo (server-side
    `update-ref -d`; push-deletes stay forbidden) and its directory tree.
    Unmerged-work warnings are a CLIENT concern (the dialog shows divergence
    and requires confirmation) — the server never blocks on divergence.
    404 only when nothing of the copy remains (dir, yaml entries, branches),
    so re-issuing after a partial failure finishes the teardown. 202 +
    task_queue task id otherwise; the teardown itself runs ON THE GIT TASK
    QUEUE, serialized with every other git-mutating operation.
    """
    from app.dependencies import get_automation_service
    from app.services import bp_delete
    from app.task_queue import task_queue

    _validate_copy_name(name)
    if name == "main":
        raise HTTPException(status_code=400, detail="The main copy cannot be deleted")
    copy_path = _resolve_copy_path(name)
    deleted_by = (body.deleted_by or None) if body else None

    service = get_automation_service()
    bs_yaml = read_bitswan_yaml(service.gitops_dir) or {}
    if not await bp_delete.copy_has_remnants(bs_yaml, name):
        raise HTTPException(status_code=404, detail=f"No copy '{name}' found")

    # Kind + ownership come from stored metadata, never from the name. No
    # sidecar => a user or legacy copy => not deletable through the API.
    _require_experiment_owner(name, copy_path, "Only experiments can be deleted")

    async def _run() -> dict:
        return await bp_delete.delete_copy(name, deleted_by, service)

    task_id = task_queue.submit(
        "delete-copy", _run, requester_email=deleted_by, label=name
    )
    return {"task_id": task_id, "copy": name, "status": "pending"}


@router.get("/{name}/status")
async def get_copy_status(name: str, bp: str | None = None):
    """Per-file change list for a copy: everything that pressing Sync & Deploy
    will make the new main — commits ahead of main, plus uncommitted edits,
    plus new untracked files. Paths are copy-root-relative (``<bp>/…``).
    Optional ``?bp=`` scopes the list to one business process; in an experiment
    the unscoped list is its own business process, never the whole directory."""
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    if bp:
        _validate_bp_dir(bp)
        if not os.path.isdir(os.path.join(copy_path, bp, ".git")):
            return {"changed": []}
        bps = [bp]
    else:
        bps = copy_scope_bps(copy_path)

    per_bp = await _map_each_bp(
        bps, lambda b: _clone_status_of(os.path.join(copy_path, b), b)
    )
    by_path: dict[str, dict] = {}
    for one in per_bp:
        by_path.update(one)
    return {"changed": list(by_path.values())}


async def _clone_divergence(clone_path: str, bp: str) -> tuple[int, int]:
    """(ahead, behind) of one BP clone vs its repo's main."""
    await fetch_main(clone_path, bp)

    async def _count(rng: str) -> int:
        out, _, rc = await call_git_command_with_output(
            "git", "rev-list", "--count", rng, cwd=clone_path
        )
        return int(out.strip()) if rc == 0 and out.strip().isdigit() else 0

    return await _count(f"{MAIN_REF}..HEAD"), await _count(f"HEAD..{MAIN_REF}")


async def _missing_clone_behind(bp: str) -> int:
    """How far behind a copy is on a BP it hasn't checked out at all: every
    commit on that repo's main (including the seed) — a nonzero signal that a
    pull will materialize the BP."""
    out, _, rc = await call_git_command_with_output(
        "git", "-C", bp_bare_repo_path(bp), "rev-list", "--count", "main"
    )
    return int(out.strip()) if rc == 0 and out.strip().isdigit() else 0


@router.get("/{name}/divergence")
async def get_bp_divergence(name: str, bp: str = Query(...)):
    """Divergence from main for THIS business process vs every OTHER business
    process in the copy.

    THE one divergence reading. Both the Sync step ("does this business
    process's main carry work my copy lacks?", ``behind_bp``) and the Deploy
    gate ("is publishing this business process a fast-forward?", ``ahead_bp``
    with ``behind_bp == 0``) come from here, for the business process on
    screen. They are the same fact asked twice, so they are answered once.

    Each BP is its own repo, so "this BP" is simply its clone's ahead/behind;
    the ``_other`` fields sum the remaining clones so the screen can say "other
    business processes have unsynced work" without mixing it into this BP's
    counts. An experiment HAS no other business processes, so there the
    ``_other`` figures are always zero.

    A business process the copy hasn't checked out at all reports behind-only
    (every commit on its main): pulling it materialises the clone, which is how
    a person's copy gains a process somebody else created."""
    _validate_bp_dir(bp)
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    clones = copy_scope_bps(copy_path)

    if bp in clones:
        ahead_bp, behind_bp = await _clone_divergence(os.path.join(copy_path, bp), bp)
    elif await bp_main_has_content(bp):
        ahead_bp, behind_bp = 0, await _missing_clone_behind(bp)
    else:
        ahead_bp = behind_bp = 0

    others = [o for o in clones if o != bp]
    pairs = await _map_each_bp(
        others, lambda o: _clone_divergence(os.path.join(copy_path, o), o)
    )
    ahead_other = sum(a for a, _ in pairs)
    behind_other = sum(b for _, b in pairs)

    return {
        "bp": bp,
        "ahead_bp": ahead_bp,
        "ahead_other": ahead_other,
        "behind_bp": behind_bp,
        "behind_other": behind_other,
    }


@router.get("/{name}/divergence-all")
async def get_all_bp_divergence(name: str):
    """Per-business-process ahead/behind counts vs main for a WHOLE copy — so
    the switcher can show ↑/↓ on each BP at a glance.

    Each BP clone is compared against its own repo's main; a main-carrying BP
    the copy hasn't checked out reports behind-only (a pull materializes it).
    Only BPs that actually diverge appear in the result; the caller treats a
    missing BP as "in step with main"."""
    _validate_copy_name(name)
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    meta = read_copy_meta(copy_path)
    result: dict[str, dict] = {}
    clones = copy_scope_bps(copy_path, meta)
    pairs = await _map_each_bp(
        clones, lambda bp: _clone_divergence(os.path.join(copy_path, bp), bp)
    )
    for bp, (ahead, behind) in zip(clones, pairs):
        if ahead or behind:
            result[bp] = {"ahead": ahead, "behind": behind}
    # Only a person's copy is workspace-wide, so only there is a business
    # process it lacks a thing it is behind on. An experiment is ONE process.
    if not experiment_bp(meta):
        for bp in list_bp_repos():
            if bp in clones:
                continue
            if await bp_main_has_content(bp):
                behind = await _missing_clone_behind(bp)
                if behind:
                    result[bp] = {"ahead": 0, "behind": behind}
    return result


async def _git_log(ref: str, cwd: str, limit: int = 50) -> list[dict]:
    """Recent commits on `ref` as structured rows. Fields are unit-separated so
    subjects with tabs/spaces survive intact."""
    out, _, rc = await call_git_command_with_output(
        "git",
        "log",
        f"-{limit}",
        "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s",
        ref,
        cwd=cwd,
    )
    commits: list[dict] = []
    if rc == 0:
        for line in out.splitlines():
            f = line.split("\x1f")
            if len(f) == 6:
                commits.append(
                    {
                        "sha": f[0],
                        "short": f[1],
                        "author_name": f[2],
                        "author_email": f[3],
                        "date": f[4],
                        "subject": f[5],
                    }
                )
    return commits


async def _deploy_tags(bp: str) -> dict[str, list[str]]:
    """Map main-commit sha → deploy-tag subjects for one BP repo. Annotated
    tags expose the tagged commit via %(*objectname); fall back to
    %(objectname) just in case. NB: for-each-ref does NOT interpret git-log's
    %x1f escape, so use a plain separator; the two object ids are hex (no "|")
    and the subject is last, so maxsplit=2 keeps a subject containing "|"
    intact."""
    deploys: dict[str, list[str]] = {}
    tags_out, _, _ = await call_git_command_with_output(
        "git",
        "-C",
        bp_bare_repo_path(bp),
        "for-each-ref",
        "refs/tags/deploy",
        "--format=%(*objectname)|%(objectname)|%(contents:subject)",
    )
    for line in tags_out.splitlines():
        f = line.split("|", 2)
        if len(f) == 3:
            commit_sha = f[0] or f[1]
            deploys.setdefault(commit_sha, []).append(f[2])
    return deploys


@router.get("/{name}/history")
async def get_copy_history(name: str, bp: str | None = None):
    """Commit history for the Sync & Deploy history view: the copy's commits
    and main's commits, with deploy markers (`<email> deployed <date>`)
    attached to the main commits each Sync & Deploy tagged.

    With ``?bp=`` (the normal, BP-scoped view) the logs come from that BP's
    repo alone. Without it, logs are merged across every BP clone (newest
    first) — an aggregate view kept for API compatibility."""
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    if bp:
        _validate_bp_dir(bp)
        if not os.path.isdir(os.path.join(copy_path, bp, ".git")):
            raise HTTPException(
                status_code=404, detail=f"'{bp}' is not checked out in '{name}'"
            )
        bps = [bp]
    else:
        bps = copy_scope_bps(copy_path)

    copy_commits: list[dict] = []
    main_commits: list[dict] = []
    deploys: dict[str, list[str]] = {}
    for b in bps:
        clone = os.path.join(copy_path, b)
        await fetch_main(clone, b)
        copy_commits.extend(await _git_log("HEAD", clone))
        main_commits.extend(await _git_log(MAIN_REF, clone))
        deploys.update(await _deploy_tags(b))

    if len(bps) > 1:
        copy_commits.sort(key=lambda c: c["date"], reverse=True)
        main_commits.sort(key=lambda c: c["date"], reverse=True)
        copy_commits = copy_commits[:50]
        main_commits = main_commits[:50]

    for c in main_commits:
        c["deploys"] = deploys.get(c["sha"], [])

    return {"copy": copy_commits, "main": main_commits}


async def _clone_diff(clone_path: str, bp: str, rel_path: str | None) -> str:
    """Unified diff of one BP clone vs its main, with `a/<bp>/…` patch headers
    so paths stay copy-root-relative."""
    prefix_args = [f"--src-prefix=a/{bp}/", f"--dst-prefix=b/{bp}/"]
    git_args = ["git", "diff", *prefix_args, MAIN_REF, "--"]
    git_args.append(rel_path if rel_path else ".")

    stdout, stderr, rc = await call_git_command_with_output(*git_args, cwd=clone_path)
    if rc != 0:
        raise HTTPException(
            status_code=500, detail=f"Failed to get diff: {stderr.strip()}"
        )

    # Untracked new files don't appear in `git diff` against a ref — show the
    # whole file as added (`--no-index` exits 1 when it finds a diff; that's
    # expected, not an error, so we ignore the return code and use the output).
    if rel_path is not None and not stdout.strip():
        no_index_out, _, _ = await call_git_command_with_output(
            "git",
            "diff",
            "--no-index",
            *prefix_args,
            "--",
            "/dev/null",
            rel_path,
            cwd=clone_path,
        )
        if no_index_out.strip():
            stdout = no_index_out
    return stdout


@router.get("/{name}/diff")
async def get_copy_diff(name: str, path: str | None = None):
    """Unified diff of the copy against main — what will become the new main on
    Sync & Deploy, committed or not. Optional `?path=<bp>/rest` filter routes
    to that BP's clone; without a path, per-BP diffs are concatenated. Patch
    headers stay copy-root-relative (`a/<bp>/…`)."""
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")
    if path is not None and not _is_safe_relative_path(path):
        raise HTTPException(status_code=400, detail="invalid path")

    if path is not None:
        bp, _, rest = path.partition("/")
        _validate_bp_dir(bp)
        clone = os.path.join(copy_path, bp)
        if not os.path.isdir(os.path.join(clone, ".git")):
            raise HTTPException(
                status_code=404, detail=f"'{bp}' is not checked out in '{name}'"
            )
        await fetch_main(clone, bp)
        return {"diff": await _clone_diff(clone, bp, rest or None)}

    parts: list[str] = []
    for bp in copy_scope_bps(copy_path):
        clone = os.path.join(copy_path, bp)
        await fetch_main(clone, bp)
        d = await _clone_diff(clone, bp, None)
        if d.strip():
            parts.append(d)
    return {"diff": "".join(parts)}


# Git's own name for "nothing": the sha1 of the empty tree, present in every
# repository. Diffing against it turns "this whole business process arrives"
# into an ordinary diff, which is exactly what pulling a process the copy has
# never checked out is.
_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

# A single incoming diff is read into memory and shipped to the browser, which
# renders every line. A merge that has been left unpulled for weeks can carry
# megabytes; past this many characters we send what fits and say so, and the
# per-file diffs (``?path=``) stay available for the rest.
_INCOMING_DIFF_MAX_CHARS = 400_000

# How far back the incoming COMMIT list walks. Higher than the history view's
# 50 because this list is the answer to "what am I about to pull" and a copy
# left alone over a holiday really is hundreds behind; still bounded, and the
# response says when it hit the bound.
_INCOMING_LOG_LIMIT = 200


def _incoming_revs(clone_path: str, bp: str) -> tuple[str, list[str], list[str]]:
    """Where to run git for "what a pull brings in", and the ranges to run.

    Returns ``(cwd, log_args, diff_args)``. Two cases, and they are genuinely
    different repositories:

    * the copy HAS this business process — ask its clone. ``HEAD..MAIN_REF``
      are the commits arriving; ``HEAD...MAIN_REF`` (three dots) is their file
      effect, measured from the merge base so the copy's own commits are not
      reported back to it as incoming.
    * the copy does NOT have it — there is no clone to ask, so ask the bare
      repo. Every commit on its main arrives, against the empty tree.
    """
    if os.path.isdir(os.path.join(clone_path, ".git")):
        return clone_path, [f"HEAD..{MAIN_REF}"], [f"HEAD...{MAIN_REF}"]
    return bp_bare_repo_path(bp), ["main"], [_EMPTY_TREE, "main"]


async def _incoming_files(cwd: str, bp: str, diff_args: list[str]) -> list[dict]:
    """Per-file summary of an incoming range, in ``/status``'s wire shape:
    ``<bp>/…`` paths, a ``kind``, and line counts. ``--no-renames`` so every
    path is one a per-file diff can be fetched for."""
    by_path: dict[str, dict] = {}
    num_out, _, _ = await call_git_command_with_output(
        "git", "diff", "--no-renames", "--numstat", *diff_args, cwd=cwd
    )
    for line in num_out.splitlines():
        parts = line.split("\t", 2)
        if len(parts) != 3:
            continue
        adds_str, dels_str, p = parts
        full = f"{bp}/{p}"
        by_path[full] = {
            "path": full,
            "kind": "modified",
            # Binary files report "-" for both counts; 0 is the honest number
            # of TEXT lines they change.
            "adds": int(adds_str) if adds_str.isdigit() else 0,
            "dels": int(dels_str) if dels_str.isdigit() else 0,
        }
    ns_out, _, _ = await call_git_command_with_output(
        "git", "diff", "--no-renames", "--name-status", *diff_args, cwd=cwd
    )
    for line in ns_out.splitlines():
        cols = line.split("\t")
        if len(cols) < 2:
            continue
        kind = _NAME_STATUS_KIND.get(cols[0][:1], "modified")
        full = f"{bp}/{cols[-1]}"
        if full in by_path:
            by_path[full]["kind"] = kind
        else:
            by_path[full] = {"path": full, "kind": kind, "adds": 0, "dels": 0}
    return sorted(by_path.values(), key=lambda f: f["path"])


@router.get("/{name}/incoming")
async def get_incoming(name: str, bp: str = Query(...)):
    """What pulling main into ONE business process would bring in — the commits
    AND their file-level effect.

    The Sync screen used to list nothing but commit subjects, which on a
    workspace where everyone edits the same file is thirty identical lines and
    no answer to the only question the screen exists to answer: what changes.
    So this returns both, from one reading, and the screen leads with the
    files.

    Deliberately measured from the MERGE BASE (``HEAD...MAIN_REF``): a pull
    replays the copy's own commits on top of main, so the copy's work is not
    something the pull "brings in" and must not appear here. A business process
    the copy has not checked out at all reports its whole main — pulling
    materialises it, which is how a copy gains a process somebody else created,
    and it is the case the old commit-only view answered with a 404.
    """
    _validate_bp_dir(bp)
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")

    clone_path = os.path.join(copy_path, bp)
    if os.path.isdir(os.path.join(clone_path, ".git")):
        await fetch_main(clone_path, bp)
    elif not await bp_main_has_content(bp):
        # Neither checked out nor carrying anything on main: nothing arrives.
        return {"bp": bp, "commits": [], "files": [], "commits_truncated": False}

    cwd, log_args, diff_args = _incoming_revs(clone_path, bp)
    commits = await _git_log(*log_args, cwd=cwd, limit=_INCOMING_LOG_LIMIT)
    files = await _incoming_files(cwd, bp, diff_args)
    # The FILE list is complete whatever the log limit is — it is one diff, not
    # a walk — so say which half was capped rather than letting the screen
    # imply that a 200-commit pull carries 200 commits exactly.
    return {
        "bp": bp,
        "commits": commits,
        "files": files,
        "commits_truncated": len(commits) >= _INCOMING_LOG_LIMIT,
    }


@router.get("/{name}/incoming/diff")
async def get_incoming_diff(name: str, bp: str = Query(...), path: str | None = None):
    """The unified diff of what a pull brings into ONE business process —
    everything, or the single ``?path=<bp>/rest`` the file list was clicked on.

    Same range as :func:`get_incoming`, so the diff shown is the diff the file
    list counted. Patch headers stay copy-root-relative (``a/<bp>/…``) to match
    the paths in that list and everywhere else in the app.
    """
    _validate_bp_dir(bp)
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")
    if path is not None and not _is_safe_relative_path(path):
        raise HTTPException(status_code=400, detail="invalid path")

    rel_path = None
    if path is not None:
        path_bp, _, rest = path.partition("/")
        if path_bp != bp:
            raise HTTPException(
                status_code=400,
                detail=f"path '{path}' is not in business process '{bp}'",
            )
        rel_path = rest or None

    clone_path = os.path.join(copy_path, bp)
    if os.path.isdir(os.path.join(clone_path, ".git")):
        await fetch_main(clone_path, bp)
    elif not await bp_main_has_content(bp):
        return {"diff": "", "truncated": False}

    cwd, _, diff_args = _incoming_revs(clone_path, bp)
    # No pathspec at all for the whole-process diff: `cwd` is the BARE repo
    # when the copy hasn't checked this process out, and a bare repo has no
    # working tree for a `.` pathspec to be relative to.
    pathspec = ["--", rel_path] if rel_path else []
    stdout, stderr, rc = await call_git_command_with_output(
        "git",
        "diff",
        f"--src-prefix=a/{bp}/",
        f"--dst-prefix=b/{bp}/",
        *diff_args,
        *pathspec,
        cwd=cwd,
    )
    if rc != 0:
        raise HTTPException(
            status_code=500, detail=f"Failed to get diff: {stderr.strip()}"
        )
    if len(stdout) > _INCOMING_DIFF_MAX_CHARS:
        return {"diff": stdout[:_INCOMING_DIFF_MAX_CHARS], "truncated": True}
    return {"diff": stdout, "truncated": False}


@router.get("/{name}/commit/{sha}/diff")
async def get_commit_diff(name: str, sha: str, bp: str | None = None):
    """Unified diff introduced by a single commit (`git show`), for the history
    view's clickable rows. Each BP has its own repo, so the commit is looked up
    in the named BP's clone — or, without ``?bp=``, in whichever clone knows
    the sha (shas are unique across repos in practice)."""
    copy_path = _resolve_copy_path(name)
    if not os.path.exists(copy_path):
        raise HTTPException(status_code=404, detail=f"Copy '{name}' not found")
    if not re.fullmatch(r"[0-9a-fA-F]{4,64}", sha or ""):
        raise HTTPException(status_code=400, detail="invalid commit")

    if bp:
        _validate_bp_dir(bp)
        bps = [bp]
    else:
        bps = copy_scope_bps(copy_path)

    for b in bps:
        clone = os.path.join(copy_path, b)
        if not os.path.isdir(os.path.join(clone, ".git")):
            continue
        # main commits are reachable only via MAIN_REF's objects — fetch first.
        await fetch_main(clone, b)
        _, _, known_rc = await call_git_command_with_output(
            "git", "cat-file", "-e", f"{sha}^{{commit}}", cwd=clone
        )
        if known_rc != 0:
            continue
        stdout, stderr, rc = await call_git_command_with_output(
            "git", "show", "--no-color", "--format=medium", sha, cwd=clone
        )
        if rc == 0:
            return {"diff": stdout}
    raise HTTPException(status_code=404, detail="commit not found")
