package dockerdriver

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Containment helpers for tenant-controlled path elements (#134).
//
// The deployment record (bitswan.yaml) is tenant-writable: gitops's
// POST /automations/{id}/deploy persists `checksum` / `relative_path`
// verbatim, and the compiler joins those strings onto trusted roots
// (gitopsDir/gitopsDirHost/workspaceDir) to build the SOURCE of read-only
// bind-mounts. The driver holds /var/run/docker.sock and promises that a
// deployment record cannot inject host bind-mounts (see the NOTE in
// buildServiceEntry), so an uncontained `../..` element would let a workspace
// user mount an arbitrary host path into a driver-managed container. These
// helpers mirror the realpath+containment check gitops applies in
// prep_deploy_source: lexical containment on the join, plus a realpath
// re-check where the joined path is visible to this process.

// escapesRel reports whether a filepath.Rel result points at or outside the
// root ("." = the root itself, ".." / "../…" = outside). The root itself is
// rejected too: for mount sources it holds every sibling deployment's tree
// (and, for the gitops root, the secrets/ fallback dir).
func escapesRel(rel string) bool {
	return rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// containedJoin joins a tenant-supplied path element onto root and errors
// unless the cleaned result lies strictly below root. Purely lexical (catches
// `..` traversal and absolute elements); pair with assertRealUnder for the
// symlink case when the joined path is visible to this process.
func containedJoin(root, elem string) (string, error) {
	cleanRoot := filepath.Clean(root)
	joined := filepath.Join(cleanRoot, elem)
	rel, err := filepath.Rel(cleanRoot, joined)
	if err != nil || escapesRel(rel) {
		return "", fmt.Errorf("path element %q is not contained in %q", elem, root)
	}
	return joined, nil
}

// assertRealUnder verifies that path — already lexically contained in root —
// still resolves strictly below root once symlinks are applied, so a symlink
// planted inside root cannot redirect a bind-mount source outside it. Missing
// paths pass: there is nothing on disk to follow, and the lexical check has
// already run (the compiler may check a container-visible twin of a host-side
// root, which need not exist in every environment).
func assertRealUnder(root, path string) error {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("resolve %s: %w", root, err)
	}
	realPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("resolve %s: %w", path, err)
	}
	rel, err := filepath.Rel(realRoot, realPath)
	if err != nil || escapesRel(rel) {
		return fmt.Errorf("path %q resolves outside %q", path, root)
	}
	return nil
}
