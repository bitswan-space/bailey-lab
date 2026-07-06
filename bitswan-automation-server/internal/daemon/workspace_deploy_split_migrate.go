package daemon

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Per-BP deploy state: split the workspace's single gitops/bitswan.yaml into one
// bitswan.yaml PER business process, each its own local git repo at
// gitops/bp/<bp>/. gitops then reads/writes/histories per BP and pushes each to
// its own deploy repo, so the driver compiles + `docker compose`s one BP at a
// time (see the per-BP-deploy-state plan). The per-BP DEPLOY repos
// (deploy-repos/<bp>.deploy.git) are created on demand by the driver's
// /v1/deploy-repo/ensure at the first deploy — the migration only splits the
// STATE. Marker-guarded + idempotent.

const deploySplitMarker = ".deploy-split-migrated"

// deployStateBPKeys are the top-level bitswan.yaml maps keyed by (raw) business
// process — each per-BP file holds only its BP's entry. Mirrors gitops
// utils._WS_MERGE_KEYS (minus business_processes, handled specially).
var deployStateBPKeys = []string{"firewall", "backups", "secrets", "disaster_recovery"}

// rawBPFromRelPath extracts the raw bp from a deployment relative_path
// (copies/<copy>/<bp>/<automation>) — structured parsing, the same rule as
// dockerdriver.deriveBPAndCopy / gitops bp_from_relative_path. Empty when the
// path has no bp segment.
func rawBPFromRelPath(rel string) string {
	if rel == "" {
		return ""
	}
	parts := strings.Split(strings.ReplaceAll(rel, "\\", "/"), "/")
	if len(parts) >= 2 && parts[0] == "copies" {
		parts = parts[2:] // drop copies/<copy>
	}
	if len(parts) >= 2 {
		return parts[0]
	}
	return ""
}

// rawBPForContext resolves a business_processes CONTEXT node to its raw bp by
// reading any deployment's relative_path (a copy context is copy-<copy>-<bp>,
// which is not safely parseable — the path is). Falls back to the context key.
func rawBPForContext(node interface{}, ctx string) string {
	stages, ok := node.(map[string]interface{})
	if !ok {
		return ctx
	}
	for _, stageNode := range stages {
		sn, ok := stageNode.(map[string]interface{})
		if !ok {
			continue
		}
		deps, ok := sn["deployments"].(map[string]interface{})
		if !ok {
			continue
		}
		for _, conf := range deps {
			cm, ok := conf.(map[string]interface{})
			if !ok {
				continue
			}
			if rel, ok := cm["relative_path"].(string); ok {
				if bp := rawBPFromRelPath(rel); bp != "" {
					return bp
				}
			}
		}
	}
	return ctx
}

// splitBitswanByBP partitions a whole-workspace bitswan.yaml map into per-raw-bp
// slices: each BP gets every business_processes context that belongs to it (main
// + its copies) plus its firewall/backups/secrets/disaster_recovery entries.
func splitBitswanByBP(bs map[string]interface{}) map[string]map[string]interface{} {
	out := map[string]map[string]interface{}{}
	ensure := func(bp string) map[string]interface{} {
		if out[bp] == nil {
			out[bp] = map[string]interface{}{}
		}
		return out[bp]
	}
	if tree, ok := bs["business_processes"].(map[string]interface{}); ok {
		for ctx, node := range tree {
			bp := rawBPForContext(node, ctx)
			s := ensure(bp)
			bpTree, _ := s["business_processes"].(map[string]interface{})
			if bpTree == nil {
				bpTree = map[string]interface{}{}
				s["business_processes"] = bpTree
			}
			bpTree[ctx] = node
		}
	}
	for _, key := range deployStateBPKeys {
		m, ok := bs[key].(map[string]interface{})
		if !ok {
			continue
		}
		for bp, v := range m {
			s := ensure(bp)
			mm, _ := s[key].(map[string]interface{})
			if mm == nil {
				mm = map[string]interface{}{}
				s[key] = mm
			}
			mm[bp] = v
		}
	}
	return out
}

// migrateToPerBPDeployState splits one workspace's single deploy-state file into
// per-BP repos. Marker-guarded; idempotent (per-BP dirs/commits are skipped if
// already present). run is a git runner (user1000).
func migrateToPerBPDeployState(wsName, wsDir string, run gitRunner) error {
	marker := filepath.Join(wsDir, deploySplitMarker)
	if _, err := os.Stat(marker); err == nil {
		return nil
	}
	gitopsDir := filepath.Join(wsDir, "gitops")
	statePath := filepath.Join(gitopsDir, "bitswan.yaml")
	data, err := os.ReadFile(statePath)
	if os.IsNotExist(err) {
		// Fresh workspace with no deploys yet — per-BP files are created on the
		// first deploy. Nothing to split.
		return writeMarker(marker)
	}
	if err != nil {
		return fmt.Errorf("read %s: %w", statePath, err)
	}
	var bs map[string]interface{}
	if err := yaml.Unmarshal(data, &bs); err != nil {
		return fmt.Errorf("parse %s: %w", statePath, err)
	}
	if bs == nil {
		return writeMarker(marker)
	}

	bpDir := filepath.Join(gitopsDir, "bp")
	if err := os.MkdirAll(bpDir, 0o755); err != nil {
		return err
	}
	for bp, slice := range splitBitswanByBP(bs) {
		if bp == "" {
			continue
		}
		dir := filepath.Join(bpDir, bp)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		out, err := yaml.Marshal(slice)
		if err != nil {
			return fmt.Errorf("marshal slice for %s: %w", bp, err)
		}
		if err := os.WriteFile(filepath.Join(dir, "bitswan.yaml"), out, 0o644); err != nil {
			return err
		}
		// Local git repo (no remote): its history is this BP's deploy history;
		// the deploy PUSH target is the BP's deploy repo, created on demand.
		if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
			if _, err := run(dir, "git init -q -b main"); err != nil {
				return fmt.Errorf("git init %s: %w", bp, err)
			}
		}
		if _, err := run(dir, "git add bitswan.yaml"); err != nil {
			return fmt.Errorf("git add %s: %w", bp, err)
		}
		// Only commit when there's something staged (idempotent re-run).
		if _, err := run(dir, "git diff --cached --quiet"); err != nil {
			if _, err := run(dir, fmt.Sprintf("git %s commit -q -m %q", migGitIdent, "Split deploy state for "+bp)); err != nil {
				return fmt.Errorf("git commit %s: %w", bp, err)
			}
		}
	}

	// Retire the old single file so reads use the per-BP layout unambiguously
	// (the aggregate reader already prefers bp/* when present; renaming keeps a
	// forensic copy).
	_ = os.Rename(statePath, statePath+".pre-split")
	_ = exec.Command("chown", "-R", "1000:1000", bpDir).Run()

	fmt.Printf("[deploy-split] %s: split into %d per-BP deploy repo(s)\n", wsName, len(listSubdirs(bpDir)))
	return writeMarker(marker)
}

func writeMarker(marker string) error {
	return os.WriteFile(marker, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o644)
}
