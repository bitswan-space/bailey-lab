package services

import (
	"fmt"
	"os"
	"strings"
)

// AuditAgentSpec describes the temporary coding agent an auditor gets while a
// business process's staging stage is frozen.
type AuditAgentSpec struct {
	WorkspaceName string
	BP            string
	Sha           string
	Image         string
	ExtensionDir  string
}

// AuditAgentName is the container name for one audited image. Keyed by the
// image content hash, so re-freezing the same image reuses one container and
// two different images never share one.
func AuditAgentName(workspaceName, bp, sha string) string {
	return fmt.Sprintf("%s-%s-audit-%s", workspaceName, bp, shortSha(sha))
}

func shortSha(sha string) string {
	if len(sha) > 8 {
		return sha[:8]
	}
	return sha
}

func auditSubpath(workspaceName, bp, sha string) string {
	return fmt.Sprintf("workspaces/%s/audits/%s/%s", workspaceName, bp, sha)
}

// AuditAgentRunArgs is the docker argv that runs the audit agent.
//
// The audited source is mounted read-only over the writable audit directory:
// the agent must be able to write its report and must not be able to edit the
// version it is reporting on. It joins the same isolated <ws>-agent bridge the
// workspace's own agent uses — it runs the same untrusted-code risk — and it
// holds no clone, no remote and no credentials for the workspace's git.
func AuditAgentRunArgs(spec AuditAgentSpec) []string {
	sub := auditSubpath(spec.WorkspaceName, spec.BP, spec.Sha)
	args := []string{
		"run", "-d",
		"--name", AuditAgentName(spec.WorkspaceName, spec.BP, spec.Sha),
		"--label", "bitswan.audit.workspace=" + spec.WorkspaceName,
		"--label", "bitswan.audit.bp=" + spec.BP,
		"--label", "bitswan.audit.sha=" + spec.Sha,
		"--network", spec.WorkspaceName + "-agent",
		"--mount", "type=volume,source=bitswan,target=/audit,volume-subpath=" + sub,
		"--mount", "type=volume,source=bitswan,target=/audit/source,readonly,volume-subpath=" + sub + "/source",
	}
	if spec.ExtensionDir != "" {
		args = append(args, "-v", spec.ExtensionDir+":/claude-extension:ro")
	}
	args = append(args,
		"-e", "AUDIT_BP="+spec.BP,
		"-e", "AUDIT_SHA="+spec.Sha,
		"-e", "CLAUDE_CONFIG_DIR=/audit/.claude",
	)
	for _, key := range []string{"ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"} {
		if v := os.Getenv(key); v != "" {
			args = append(args, "-e", key+"="+v)
		}
	}
	return append(args, spec.Image, "sleep", "infinity")
}

// StartAuditAgent brings the audit agent up, or reports the one already there.
func StartAuditAgent(spec AuditAgentSpec) (map[string]any, error) {
	name := AuditAgentName(spec.WorkspaceName, spec.BP, spec.Sha)
	if state, err := AuditAgentState(spec.WorkspaceName, spec.BP, spec.Sha); err == nil {
		if running, _ := state["running"].(bool); running {
			return state, nil
		}
		if exists, _ := state["exists"].(bool); exists {
			if out, err := runDocker("", "start", name); err != nil {
				return nil, fmt.Errorf("could not start %s: %s", name, strings.TrimSpace(string(out)))
			}
			return AuditAgentState(spec.WorkspaceName, spec.BP, spec.Sha)
		}
	}
	if out, err := runDocker("", AuditAgentRunArgs(spec)...); err != nil {
		return nil, fmt.Errorf("could not run %s: %s", name, strings.TrimSpace(string(out)))
	}
	return AuditAgentState(spec.WorkspaceName, spec.BP, spec.Sha)
}

// StopAuditAgent removes the audit agent. The audit directory it was reading
// outlives it — the report and the diff are evidence, the container is not.
func StopAuditAgent(workspaceName, bp, sha string) (map[string]any, error) {
	name := AuditAgentName(workspaceName, bp, sha)
	if out, err := runDocker("", "rm", "-f", name); err != nil {
		text := strings.TrimSpace(string(out))
		if !strings.Contains(text, "No such container") {
			return nil, fmt.Errorf("could not remove %s: %s", name, text)
		}
	}
	return map[string]any{"name": name, "running": false, "exists": false}, nil
}

// AuditAgentState reports whether the audit agent for one image is there.
func AuditAgentState(workspaceName, bp, sha string) (map[string]any, error) {
	name := AuditAgentName(workspaceName, bp, sha)
	out, err := runDocker("", "inspect", "-f", "{{.State.Running}}", name)
	text := strings.TrimSpace(string(out))
	if err != nil {
		return map[string]any{"name": name, "running": false, "exists": false}, nil
	}
	return map[string]any{"name": name, "running": text == "true", "exists": true}, nil
}

// DraftAuditReport runs the agent over the audited source and its diff, and
// leaves the answer in the report the workspace shows the auditor. The prompt
// is the auditor's; the brief in the audit directory tells the agent where it
// is and what the two versions are.
func DraftAuditReport(workspaceName, bp, sha, prompt string) (map[string]any, error) {
	name := AuditAgentName(workspaceName, bp, sha)
	if prompt == "" {
		prompt = "Read AUDIT.md, then the source and production.diff, and write the audit report."
	}
	script := "cd /audit && claude -p " + shellQuote(prompt) +
		" --permission-mode plan --output-format text > /audit/report.md 2>/audit/report.err"
	out, err := runDocker("", "exec", name, "sh", "-lc", script)
	if err != nil {
		return nil, fmt.Errorf("audit agent could not draft the report: %s", strings.TrimSpace(string(out)))
	}
	return map[string]any{"name": name, "drafted": true}, nil
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// AuditAgentsForWorkspace lists every audit agent container of a workspace, so
// a workspace teardown can take them with it.
func AuditAgentsForWorkspace(workspaceName string) ([]string, error) {
	out, err := runDocker("", "ps", "-aq", "--filter", "label=bitswan.audit.workspace="+workspaceName)
	if err != nil {
		return nil, fmt.Errorf("could not list audit agents: %s", strings.TrimSpace(string(out)))
	}
	var ids []string
	for _, line := range strings.Split(string(out), "\n") {
		if id := strings.TrimSpace(line); id != "" {
			ids = append(ids, id)
		}
	}
	return ids, nil
}
