package daemon

import (
	"os"
	"path/filepath"
)

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
	"audits",
}

// ensureWorkspaceVolumeDirs creates any missing standard subdirectories for a
// workspace so the volume-subpath mounts resolve. Existing dirs are left as-is.
func ensureWorkspaceVolumeDirs(workspaceName string) {
	base := filepath.Join(os.Getenv("HOME"), ".config", "bitswan", "workspaces", workspaceName)
	for _, d := range workspaceVolumeSubdirs {
		_ = os.MkdirAll(filepath.Join(base, d), 0o755)
	}
}
