import os
import re
import toml
import unicodedata
import uuid
from typing import Dict, Any, Optional

from ..models import ProcessInfo
from ..utils import read_bitswan_yaml

import logging

logger = logging.getLogger(__name__)


def _copies_dir() -> str:
    return os.environ.get("BITSWAN_COPIES_DIR", "/copies")


def slugify_bp_name(name: str) -> str:
    """Derive the filesystem/git/deployment slug from a human-readable BP name.

    The slug is what the directory, the BP's bare repo, and deployment-id
    segments are named after, and deployment ids can end up as subdomain
    labels — so the alphabet is strictly `[a-z0-9-]`: lowercase, diacritics
    folded to ASCII (Zpracování → zpracovani), every other run of characters
    collapsed to a single dash. Returns "" when nothing survives (e.g. a
    name with no Latin letters or digits); callers must treat that as
    invalid input.
    """
    folded = (
        unicodedata.normalize("NFKD", name)
        .encode("ascii", "ignore")
        .decode("ascii")
        .lower()
    )
    return re.sub(r"[^a-z0-9]+", "-", folded).strip("-")


class ProcessService:
    def __init__(self):
        self.bs_home = os.environ.get("BITSWAN_GITOPS_DIR", "/mnt/repo/pipeline")
        self.gitops_dir = os.path.join(self.bs_home, "gitops")
        self.workspace_repo_dir = os.environ.get(
            "BITSWAN_WORKSPACE_REPO_DIR", "/workspace-repo"
        )
        # Per-scope cache of discovered processes. Key is the copy name,
        # or None for the main repo. Kept fresh by the file-system watchers
        # in `lifespan.py` (see `WorkspaceChangeHandler` and
        # `CopyChangeHandler`) so REST/SSE consumers don't pay the cost
        # of a filesystem walk on every request.
        self._cache: Dict[Optional[str], Dict[str, ProcessInfo]] = {}

    def _scope_root(self, copy: Optional[str] = None) -> str:
        """Filesystem root for a discovery scope.

        A copy (copy name) maps to `${BITSWAN_COPIES_DIR}/<copy>`; the
        main scope (copy None) maps to `${BITSWAN_COPIES_DIR}/main`.
        """
        if copy:
            return os.path.join(_copies_dir(), copy)
        return os.path.join(_copies_dir(), "main")

    def discover_processes(self, copy: Optional[str] = None) -> Dict[str, ProcessInfo]:
        """Discover business processes in the main repo or a single copy.

        A directory qualifies as a BP when it contains both `process.toml`
        and `README.md`, and the toml declares a `process-id`.
        """
        processes: Dict[str, ProcessInfo] = {}
        root = self._scope_root(copy)

        if not os.path.exists(root):
            return processes

        for item in os.listdir(root):
            process_path = os.path.join(root, item)
            if not os.path.isdir(process_path):
                continue

            process_toml_path = os.path.join(process_path, "process.toml")
            process_md_path = os.path.join(process_path, "README.md")

            if not (
                os.path.exists(process_toml_path) and os.path.exists(process_md_path)
            ):
                continue

            try:
                with open(process_toml_path, "r") as f:
                    process_config = toml.load(f)
                    process_id = process_config.get("process-id")

                if not process_id:
                    continue

                # Human-readable name (issue #77). Older BPs predate the
                # `name` key — their directory name IS the display name.
                display_name = process_config.get("name")
                if not isinstance(display_name, str) or not display_name.strip():
                    display_name = item

                processes[process_id] = ProcessInfo(
                    id=process_id,
                    name=item,
                    display_name=display_name.strip(),
                    attachments=self.get_process_attachments(process_id),
                    automation_sources=self.get_process_automation_sources(process_id),
                )

            except Exception as e:
                logger.error(
                    f"Error reading process {item} (copy={copy or 'main'}): {e}"
                )
                continue

        return processes

    # --- In-memory cache + refresh -----------------------------------------

    def refresh(self, copy: Optional[str] = None) -> Dict[str, ProcessInfo]:
        """Re-scan one scope and update the cache. Returns the new mapping."""
        result = self.discover_processes(copy)
        self._cache[copy] = result
        return result

    def refresh_all(self) -> None:
        """Warm the cache from scratch: main copy + every other copy on disk."""
        self.refresh(None)
        copies_root = _copies_dir()
        if not os.path.isdir(copies_root):
            # Drop any stale copy entries (e.g. all copies removed).
            for key in [k for k in self._cache.keys() if k is not None]:
                self._cache.pop(key, None)
            return
        live = set()
        for entry in os.listdir(copies_root):
            if entry.startswith("."):
                continue
            # "main" is the None scope, refreshed separately above.
            if entry == "main":
                continue
            full = os.path.join(copies_root, entry)
            if not os.path.isdir(full):
                continue
            live.add(entry)
            self.refresh(entry)
        # Forget copies that have disappeared since the last refresh.
        for stale in [k for k in self._cache.keys() if k and k not in live]:
            self._cache.pop(stale, None)

    def forget_copy(self, copy: str) -> None:
        """Drop a copy's cache entry (used when the copy is removed)."""
        self._cache.pop(copy, None)

    def get_all_processes(self) -> list[dict]:
        """Flat, dedup-by-directory-name list of every known BP.

        Each entry:
            {
              "id":        process-id (from toml),
              "name":      directory name (filesystem-safe slug),
              "display_name": human-readable name from process.toml
                           (falls back to the directory name),
              "in_main":   bool — present in the main repo,
              "copies":    list of copy names where the same directory
                           name has a valid BP,
              "has_copies": derived (copies != []),
            }

        Copy-only BPs surface as `in_main: false, copies: [<copy>]`.
        """
        # Build directory-name -> {in_main, copies, process_id} aggregations.
        by_name: Dict[str, dict] = {}
        for scope, processes in self._cache.items():
            for info in processes.values():
                entry = by_name.setdefault(
                    info.name,
                    {
                        "id": info.id,
                        "display_name": info.display_name,
                        "in_main": False,
                        "copies": [],
                    },
                )
                if scope is None:
                    entry["in_main"] = True
                    # Main always wins as the canonical id + display-name source.
                    entry["id"] = info.id
                    entry["display_name"] = info.display_name
                else:
                    entry["copies"].append(scope)

        out: list[dict] = []
        for name in sorted(by_name):
            entry = by_name[name]
            entry["copies"].sort()
            out.append(
                {
                    "id": entry["id"],
                    "name": name,
                    "display_name": entry["display_name"],
                    "in_main": entry["in_main"],
                    "copies": entry["copies"],
                    "has_copies": bool(entry["copies"]),
                }
            )
        return out

    def get_process_attachments(self, process_id: str) -> list[str]:
        """Get attachments for a specific process."""
        attachments = []

        process_dir = self._find_process_dir_by_id(process_id)
        if not process_dir:
            return attachments

        process_path = os.path.join(self.workspace_repo_dir, process_dir)
        if not process_path or not os.path.exists(process_path):
            return attachments

        attachments_dir = os.path.join(process_path, "Attachments")
        if not os.path.exists(attachments_dir):
            return attachments

        for item in os.listdir(attachments_dir):
            if os.path.isfile(os.path.join(attachments_dir, item)):
                attachments.append(item)

        return attachments

    def get_process_automation_sources(self, process_id: str) -> list[str]:
        """Get automation sources for a specific process."""
        automation_sources = []

        process_dir = self._find_process_dir_by_id(process_id)
        if not process_dir:
            return automation_sources

        process_path = os.path.join(self.workspace_repo_dir, process_dir)
        if not process_path or not os.path.exists(process_path):
            return automation_sources

        # Read bitswan.yaml to get deployment information
        bs_yaml = read_bitswan_yaml(self.gitops_dir)
        if not bs_yaml or "deployments" not in bs_yaml:
            return automation_sources

        # Look for subdirectories in the process folder
        for item in os.listdir(process_path):
            item_path = os.path.join(process_path, item)
            if os.path.isdir(item_path) and item != "Attachments":
                # This could be an automation source
                # Check if there's a deployment for this path
                deployment_id = self._find_deployment_for_path(
                    f"{process_dir}/{item}", bs_yaml
                )
                if deployment_id is not None:
                    automation_sources.append(deployment_id)

        return automation_sources

    def _find_process_dir_by_id(self, process_id: str) -> Optional[str]:
        """Find the directory name for a given process ID."""
        if not os.path.exists(self.workspace_repo_dir):
            return None

        for item in os.listdir(self.workspace_repo_dir):
            process_path = os.path.join(self.workspace_repo_dir, item)
            if not os.path.isdir(process_path):
                continue

            process_toml_path = os.path.join(process_path, "process.toml")
            if not os.path.exists(process_toml_path):
                continue

            try:
                with open(process_toml_path, "r") as f:
                    process_config = toml.load(f)
                    if process_config.get("process-id") == process_id:
                        return item
            except Exception:
                continue

        return None

    def _find_deployment_for_path(
        self, path: str, bs_yaml: Dict[str, Any]
    ) -> Optional[str]:
        """Find deployment ID for a given path."""

        for deployment_id, config in bs_yaml["deployments"].items():
            relative_path = config.get("relative_path") or ""
            if relative_path.endswith(path):
                return deployment_id

        return None

    def get_attachment_content(self, process_id: str, filename: str) -> Optional[bytes]:
        """Get content of a specific attachment."""
        process_dir = self._find_process_dir_by_id(process_id)
        if not process_dir:
            return None

        # Sanitize filename to prevent path traversal
        filename = os.path.basename(filename)

        attachment_path = os.path.join(
            self.workspace_repo_dir, process_dir, "Attachments", filename
        )

        if not os.path.exists(attachment_path):
            return None

        try:
            with open(attachment_path, "rb") as f:
                return f.read()
        except Exception:
            return None

    def set_attachment_content(
        self, process_id: str, filename: str, content: bytes
    ) -> bool:
        """Set content of a specific attachment."""
        process_dir = self._find_process_dir_by_id(process_id)
        if not process_dir:
            return False

        # Sanitize filename to prevent path traversal
        filename = os.path.basename(filename)

        attachments_dir = os.path.join(
            self.workspace_repo_dir, process_dir, "Attachments"
        )
        os.makedirs(attachments_dir, exist_ok=True)

        attachment_path = os.path.join(attachments_dir, filename)

        try:
            with open(attachment_path, "wb") as f:
                f.write(content)
            return True
        except Exception:
            return False

    def delete_attachment(self, process_id: str, filename: str) -> bool:
        """Delete a specific attachment."""
        process_dir = self._find_process_dir_by_id(process_id)
        if not process_dir:
            return False

        # Sanitize filename to prevent path traversal
        filename = os.path.basename(filename)

        attachment_path = os.path.join(
            self.workspace_repo_dir, process_dir, "Attachments", filename
        )

        try:
            if os.path.exists(attachment_path):
                os.remove(attachment_path)
                return True
        except Exception:
            pass
        return False

    def get_process_markdown(self, process_id: str) -> Optional[str]:
        """Get README.md content for a process."""
        process_dir = self._find_process_dir_by_id(process_id)
        if not process_dir:
            return None

        process_md_path = os.path.join(
            self.workspace_repo_dir, process_dir, "README.md"
        )

        if not os.path.exists(process_md_path):
            return None

        try:
            with open(process_md_path, "r", encoding="utf-8") as f:
                return f.read()
        except Exception:
            return None

    def set_process_markdown(self, process_id: str, content: str) -> bool:
        """Set README.md content for a process."""
        process_dir = self._find_process_dir_by_id(process_id)
        if not process_dir:
            return False

        process_md_path = os.path.join(
            self.workspace_repo_dir, process_dir, "README.md"
        )

        try:
            with open(process_md_path, "w", encoding="utf-8") as f:
                f.write(content)
            return True
        except Exception:
            return False

    def delete_process(self, process_id: str) -> bool:
        """Delete an entire process."""
        process_dir = self._find_process_dir_by_id(process_id)
        if not process_dir:
            return False

        process_path = os.path.join(self.workspace_repo_dir, process_dir)

        try:
            import shutil

            if os.path.exists(process_path):
                shutil.rmtree(process_path)
                return True
        except Exception:
            pass
        return False

    async def create_business_process(
        self,
        name: str,
        process_id: Optional[str] = None,
        created_by: Optional[str] = None,
    ) -> dict:
        """Create a new business process, BORN IN MAIN: its own git repo, a main
        checkout, and the `process.toml` + `README.md` scaffold committed and
        published to the repo's deploy-only ``main``.

        `name` is the human-readable display name (issue #77): it is stored in
        `process.toml` and shown in the dashboard, while the directory, git repo,
        and deployment ids use the slug derived from it.

        A BP is created in ``main`` first (this method) so it is ``in_main`` and
        copy-switchable from birth; the requesting copy is then materialized as a
        clone of ``main`` by the caller (the create route, after it adds the
        template automations to ``main`` too). Historically the scaffold rode the
        requesting copy's branch and ``main`` stayed an empty seed until Sync &
        Deploy — which left a fresh BP invisible to every other copy.

        Main-scope + globally unique: a BP whose slug already exists in ``main``
        is a duplicate (use copy-pull to bring an existing BP into a copy, not
        create). Returns the entry as it appears in `get_all_processes()`.
        """
        from app.services.bp_git import (
            bp_clone_path,
            clone_bp_into_copy,
            commit_in_bp_clone,
            publish_main_from_clone,
        )
        from app.services.git_server import bp_main_has_content, ensure_bp_bare_repo

        # Collapse whitespace runs; the display name is stored verbatim
        # otherwise. Slugification confines the filesystem/git name to
        # [a-z0-9-], which also rules out path traversal.
        display = " ".join((name or "").split())
        clean = slugify_bp_name(display)
        if not clean:
            raise ValueError(
                "process name must contain at least one letter or digit (a-z, 0-9)"
            )

        # The BP's own repo (idempotent — reused if it already exists as an empty
        # seed from a failed earlier attempt).
        await ensure_bp_bare_repo(clean, author=created_by)
        if await bp_main_has_content(clean):
            raise FileExistsError(f"a business process named '{clean}' already exists")

        main_scope = os.path.join(_copies_dir(), "main")
        os.makedirs(main_scope, exist_ok=True)
        main_dir = bp_clone_path(None, clean)  # copies/main/<clean>

        # allow_empty: the brand-new repo has only the empty seed — the scaffold
        # is the first real content, published to main below.
        await clone_bp_into_copy(main_scope, "main", clean, allow_empty=True)

        pid = process_id or str(uuid.uuid4())
        with open(os.path.join(main_dir, "process.toml"), "w") as f:
            # toml.dump handles quoting/escaping of the free-form name.
            toml.dump({"process-id": pid, "name": display}, f)
        with open(os.path.join(main_dir, "README.md"), "w") as f:
            f.write(f"# {display}\n")

        await commit_in_bp_clone(
            main_dir, f"Create business process {display}", author=created_by
        )
        # Advance the repo's deploy-only main server-side (fast-forward via a temp
        # ref, since the pre-receive hook forbids pushing main directly) and
        # realign the main checkout.
        await publish_main_from_clone(main_dir, clean)

        # Refresh main-scope discovery so the next call sees the new BP. The HTTP
        # route broadcasts the snapshot over SSE after this returns.
        self.refresh(None)

        return {
            "id": pid,
            "name": clean,
            "display_name": display,
            "in_main": True,
            "copies": [],
            "has_copies": False,
        }

    async def rename_business_process(
        self,
        name: str,
        new_name: str,
        copy: Optional[str] = None,
        renamed_by: Optional[str] = None,
    ) -> dict:
        """Change a business process's display name (issue #77 follow-up).

        Only the `name` key in `process.toml` changes — the slug (`name`
        here) still names the directory, the bare git repo, and deployment-id
        segments, so URLs, API paths, and deployments are untouched. The
        edit is committed in the BP clone and, for the main scope, published
        to the repo's deploy-only main (same rules as creation).

        Returns the entry as it appears in `get_all_processes()`.
        """
        from app.services.bp_git import commit_in_bp_clone, publish_bp_clone

        display = " ".join((new_name or "").split())
        if not slugify_bp_name(display):
            raise ValueError(
                "process name must contain at least one letter or digit (a-z, 0-9)"
            )

        scope_root = self._scope_root(copy)
        if copy and not os.path.isdir(scope_root):
            raise FileNotFoundError(f"copy '{copy}' does not exist")
        process_dir = os.path.join(scope_root, name)
        toml_path = os.path.join(process_dir, "process.toml")
        if not os.path.isfile(toml_path):
            raise FileNotFoundError(
                f"no business process '{name}' in "
                f"{'copy ' + copy if copy else 'main'}"
            )

        config = toml.load(toml_path)
        # Pre-#77 BPs have no `name` key — their directory name IS the
        # display name, and it reads better in the commit message too.
        old_display = config.get("name")
        if not isinstance(old_display, str) or not old_display.strip():
            old_display = name
        config["name"] = display
        with open(toml_path, "w") as f:
            toml.dump(config, f)

        # A no-op rename leaves the clone clean; commit_in_bp_clone returns
        # False and there is nothing to publish.
        committed = await commit_in_bp_clone(
            process_dir,
            f"Rename business process {old_display} to {display}",
            author=renamed_by,
        )
        if committed:
            await publish_bp_clone(process_dir, name, copy)

        self.refresh(copy)
        for entry in self.get_all_processes():
            if entry["name"] == name:
                return entry
        # The BP was on disk moments ago; only a concurrent delete gets here.
        raise FileNotFoundError(f"business process '{name}' disappeared mid-rename")


# Global process service instance
process_service = ProcessService()
