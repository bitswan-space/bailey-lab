package daemon

// workspaceVolumeSubdirs are the per-workspace directories that workspace
// containers mount as subpaths of the `bitswan` volume. Volume subpath mounts
// are strict — Docker fails to start a container if the subpath doesn't exist
// (unlike bind mounts, which auto-create the source), so the full set is
// created before (re)generating a workspace's deployment.
var workspaceVolumeSubdirs = []string{
	"workspace",    // shared working tree (the gitops state worktree)
	"gitops",       // promoted-deployment materialization/state
	"deploy-repos", // per-BP infra-driver bare deploy repos (<bp>.deploy.git; the subpath must exist before the driver sidecar mounts it)
	"git-repos",    // per-BP canonical bare repos (<bp>.git, created by gitops at BP creation)
	"copies",       // per-copy checkouts base
	"copies/main",  // the main copy (per-BP checkouts of each repo's main)
	"secrets",
	"snapshots",
	// Egress-firewall attempt telemetry (per-BP JSONL the egress gateways
	// append to and the gitops dashboard reads for "Needs review"). Shared
	// between the gitops container and the gateway containers via this volume
	// subpath, so it must exist before the gitops container mounts it.
	"firewall",
	"ssh",
	"coder-home",
	"coding-agent-home",
	"coding-agent-sessions",
	"claude-configs",
	// Where the dashboard container downloads the pinned Claude Code VS Code
	// extension. Excluded from backups (see backup/engine.go): it is a large,
	// immutable, re-downloadable third-party artifact, not workspace state.
	"claude-extension",
}

// ensureWorkspaceVolumeDirs creates any missing standard subdirectories for a
// workspace so the volume-subpath mounts resolve. Existing dirs are left as-is;
// each one it creates is chowned to uid 1000, because the daemon runs as root
// while every container mounting these subpaths runs as 1000 — a root-owned
// subdir EACCESes them.
//
// The create path (workspace_init.go) masked that with a recursive chown of the
// whole bitswan config dir afterwards, but the update path (workspace_update.go)
// has no chown at all. So a subdir introduced by a new release landed root-owned
// on every *updated* workspace: `claude-configs` left the dashboard's sidebar —
// which drops to uid 1000 — unable to mkdir its per-user Claude config dir, and
// the coding agent came up broken on exactly the workspaces that had been
// updated rather than created fresh.
func ensureWorkspaceVolumeDirs(workspaceName string) {
	_ = ensureWorkspaceVolumeDirsReporting(workspaceName)
}
