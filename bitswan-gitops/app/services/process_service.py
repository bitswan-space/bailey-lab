import os
import toml
import uuid
from typing import Dict, Any, Optional

from ..models import ProcessInfo
from ..utils import read_bitswan_yaml

import logging

logger = logging.getLogger(__name__)


def _copies_dir() -> str:
    return os.environ.get("BITSWAN_COPIES_DIR", "/copies")


class ProcessService:
    def __init__(self):
        self.bs_home = os.environ.get("BITSWAN_GITOPS_DIR", "/mnt/repo/pipeline")
        self.gitops_dir = os.path.join(self.bs_home, "gitops")
        self.workspace_repo_dir = os.environ.get(
            "BITSWAN_WORKSPACE_REPO_DIR", "/workspace-repo"
        )
        # Per-scope cache of discovered processes. Key is the worktree name,
        # or None for the main repo. Kept fresh by the file-system watchers
        # in `lifespan.py` (see `WorkspaceChangeHandler` and
        # `WorktreeChangeHandler`) so REST/SSE consumers don't pay the cost
        # of a filesystem walk on every request.
        self._cache: Dict[Optional[str], Dict[str, ProcessInfo]] = {}

    def _scope_root(self, worktree: Optional[str] = None) -> str:
        """Filesystem root for a discovery scope.

        A copy (worktree name) maps to `${BITSWAN_COPIES_DIR}/<copy>`; the
        main scope (worktree None) maps to `${BITSWAN_COPIES_DIR}/main`.
        """
        if worktree:
            return os.path.join(_copies_dir(), worktree)
        return os.path.join(_copies_dir(), "main")

    def discover_processes(
        self, worktree: Optional[str] = None
    ) -> Dict[str, ProcessInfo]:
        """Discover business processes in the main repo or a single worktree.

        A directory qualifies as a BP when it contains both `process.toml`
        and `README.md`, and the toml declares a `process-id`.
        """
        processes: Dict[str, ProcessInfo] = {}
        root = self._scope_root(worktree)

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

                processes[process_id] = ProcessInfo(
                    id=process_id,
                    name=item,
                    attachments=self.get_process_attachments(process_id),
                    automation_sources=self.get_process_automation_sources(process_id),
                )

            except Exception as e:
                logger.error(
                    f"Error reading process {item} (worktree={worktree or 'main'}): {e}"
                )
                continue

        return processes

    # --- In-memory cache + refresh -----------------------------------------

    def refresh(self, worktree: Optional[str] = None) -> Dict[str, ProcessInfo]:
        """Re-scan one scope and update the cache. Returns the new mapping."""
        result = self.discover_processes(worktree)
        self._cache[worktree] = result
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

    def forget_worktree(self, worktree: str) -> None:
        """Drop a worktree's cache entry (used when the worktree is removed)."""
        self._cache.pop(worktree, None)

    def get_all_processes(self) -> list[dict]:
        """Flat, dedup-by-directory-name list of every known BP.

        Each entry:
            {
              "id":        process-id (from toml),
              "name":      directory name (filesystem-safe),
              "in_main":   bool — present in the main repo,
              "worktrees": list of worktree names where the same directory
                           name has a valid BP,
              "has_worktrees": derived (worktrees != []),
            }

        Worktree-only BPs surface as `in_main: false, worktrees: [<wt>]`.
        """
        # Build directory-name -> {in_main, worktrees, process_id} aggregations.
        by_name: Dict[str, dict] = {}
        for scope, processes in self._cache.items():
            for info in processes.values():
                entry = by_name.setdefault(
                    info.name,
                    {"id": info.id, "in_main": False, "worktrees": []},
                )
                if scope is None:
                    entry["in_main"] = True
                    # Main always wins as the canonical id source.
                    entry["id"] = info.id
                else:
                    entry["worktrees"].append(scope)

        out: list[dict] = []
        for name in sorted(by_name):
            entry = by_name[name]
            entry["worktrees"].sort()
            out.append(
                {
                    "id": entry["id"],
                    "name": name,
                    "in_main": entry["in_main"],
                    "worktrees": entry["worktrees"],
                    "has_worktrees": bool(entry["worktrees"]),
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

    def create_business_process(
        self,
        name: str,
        worktree: Optional[str] = None,
        process_id: Optional[str] = None,
    ) -> dict:
        """Create a new business-process directory with a `process.toml` +
        `README.md` template inside the main repo or a specific worktree.

        Returns the entry as it appears in `get_all_processes()`.
        """
        # Strip + basename to defend against path traversal. The HTTP route
        # additionally validates the input against a regex.
        clean = os.path.basename((name or "").strip())
        if not clean:
            raise ValueError("process name is empty or invalid")

        if worktree:
            scope_root = os.path.join(_copies_dir(), worktree)
            if not os.path.isdir(scope_root):
                raise FileNotFoundError(f"worktree '{worktree}' does not exist")
        else:
            scope_root = os.path.join(_copies_dir(), "main")

        process_dir = os.path.join(scope_root, clean)
        if os.path.exists(process_dir):
            raise FileExistsError(
                f"a directory named '{clean}' already exists in "
                f"{'worktree ' + worktree if worktree else 'main'}"
            )

        pid = process_id or str(uuid.uuid4())

        os.makedirs(process_dir)
        with open(os.path.join(process_dir, "process.toml"), "w") as f:
            f.write(f'process-id = "{pid}"\n')
        with open(os.path.join(process_dir, "README.md"), "w") as f:
            f.write(f"# {clean}\n")

        # Refresh just the affected scope so the next discovery call sees
        # the new BP. The HTTP route is expected to broadcast the snapshot
        # over SSE after this returns; we keep the cache update local to
        # avoid coupling the service to the broadcaster.
        self.refresh(worktree)

        return {
            "id": pid,
            "name": clean,
            "in_main": worktree is None,
            "worktrees": [worktree] if worktree else [],
            "has_worktrees": bool(worktree),
        }


# Global process service instance
process_service = ProcessService()
