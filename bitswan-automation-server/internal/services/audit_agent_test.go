package services

import (
	"fmt"
	"strings"
	"testing"
)

func argvString(args []string) string {
	return strings.Join(args, " ")
}

func TestAuditAgentNameIsKeyedByTheAuditedImage(t *testing.T) {
	a := AuditAgentName("finance", "invoices", "0123456789abcdef")
	b := AuditAgentName("finance", "invoices", "fedcba9876543210")
	if a == b {
		t.Errorf("two different images must not share one container: %s", a)
	}
	if a != "finance-invoices-audit-01234567" {
		t.Errorf("name = %s", a)
	}
	if AuditAgentName("finance", "invoices", "abc") != "finance-invoices-audit-abc" {
		t.Error("a short sha is used as-is")
	}
}

func TestTheAuditedSourceIsMountedReadOnlyOverTheWritableAuditDirectory(t *testing.T) {
	args := argvString(AuditAgentRunArgs(AuditAgentSpec{
		WorkspaceName: "finance",
		BP:            "invoices",
		Sha:           "0123456789abcdef",
		Image:         "bitswan/coding-agent:latest",
	}))
	sub := "workspaces/finance/audits/invoices/0123456789abcdef"
	if !strings.Contains(args, "target=/audit,volume-subpath="+sub) {
		t.Errorf("the audit directory must be writable — the report is written into it:\n%s", args)
	}
	if !strings.Contains(args, "target=/audit/source,readonly,volume-subpath="+sub+"/source") {
		t.Errorf("the audited source must be read-only — an auditor may not edit what they report on:\n%s", args)
	}
}

func TestTheAuditAgentJoinsTheIsolatedAgentBridgeOnly(t *testing.T) {
	args := argvString(AuditAgentRunArgs(AuditAgentSpec{
		WorkspaceName: "finance", BP: "invoices", Sha: "abc12345", Image: "img",
	}))
	if !strings.Contains(args, "--network finance-agent") {
		t.Errorf("expected the agent bridge:\n%s", args)
	}
	if strings.Contains(args, "bitswan_network") {
		t.Errorf("the audit agent runs untrusted code and must not reach the control plane:\n%s", args)
	}
	if strings.Contains(args, "/var/run/docker.sock") {
		t.Errorf("no docker socket in an audit sandbox:\n%s", args)
	}
	if strings.Contains(args, "workspaces/finance/copies") {
		t.Errorf("the audit agent gets the audited copy only, never the working copies:\n%s", args)
	}
}

func TestTheAuditAgentCarriesTheLabelsThatFindItAgain(t *testing.T) {
	args := argvString(AuditAgentRunArgs(AuditAgentSpec{
		WorkspaceName: "finance", BP: "invoices", Sha: "abc12345", Image: "img",
	}))
	for _, want := range []string{
		"bitswan.audit.workspace=finance",
		"bitswan.audit.bp=invoices",
		"bitswan.audit.sha=abc12345",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("missing label %s:\n%s", want, args)
		}
	}
}

func TestAnAlternateClaudeEndpointReachesTheAuditAgent(t *testing.T) {
	t.Setenv("ANTHROPIC_BASE_URL", "http://mock:8790")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "sk-ant-e2e")
	args := argvString(AuditAgentRunArgs(AuditAgentSpec{
		WorkspaceName: "finance", BP: "invoices", Sha: "abc12345", Image: "img",
	}))
	if !strings.Contains(args, "ANTHROPIC_BASE_URL=http://mock:8790") ||
		!strings.Contains(args, "ANTHROPIC_AUTH_TOKEN=sk-ant-e2e") {
		t.Errorf("the audit agent needs the endpoint the workspace was given:\n%s", args)
	}
	if strings.Contains(args, "ANTHROPIC_API_KEY=") {
		t.Errorf("an unset variable must not be forwarded as empty:\n%s", args)
	}
}

func TestTheExtensionIsMountedWhenThereIsOne(t *testing.T) {
	with := argvString(AuditAgentRunArgs(AuditAgentSpec{
		WorkspaceName: "f", BP: "b", Sha: "s", Image: "img", ExtensionDir: "/repo/.claude-extension",
	}))
	if !strings.Contains(with, "/repo/.claude-extension:/claude-extension:ro") {
		t.Errorf("expected the extension mount:\n%s", with)
	}
	without := argvString(AuditAgentRunArgs(AuditAgentSpec{
		WorkspaceName: "f", BP: "b", Sha: "s", Image: "img",
	}))
	if strings.Contains(without, "/claude-extension") {
		t.Errorf("no extension, no mount:\n%s", without)
	}
}

func TestStartingAnAuditAgentThatIsAlreadyRunningDoesNotRunASecond(t *testing.T) {
	var calls []string
	old := runDocker
	runDocker = func(dir string, args ...string) ([]byte, error) {
		calls = append(calls, strings.Join(args, " "))
		if args[0] == "inspect" {
			return []byte("true\n"), nil
		}
		return nil, fmt.Errorf("unexpected docker %v", args)
	}
	t.Cleanup(func() { runDocker = old })

	state, err := StartAuditAgent(AuditAgentSpec{
		WorkspaceName: "finance", BP: "invoices", Sha: "abc12345", Image: "img",
	})
	if err != nil {
		t.Fatalf("StartAuditAgent: %v", err)
	}
	if running, _ := state["running"].(bool); !running {
		t.Errorf("state = %v", state)
	}
	for _, c := range calls {
		if strings.HasPrefix(c, "run ") {
			t.Errorf("a second container was started: %v", calls)
		}
	}
}

func TestAStoppedAuditAgentIsStartedRatherThanRecreated(t *testing.T) {
	var calls []string
	old := runDocker
	inspects := 0
	runDocker = func(dir string, args ...string) ([]byte, error) {
		calls = append(calls, args[0])
		if args[0] == "inspect" {
			inspects++
			if inspects == 1 {
				return []byte("false\n"), nil
			}
			return []byte("true\n"), nil
		}
		return []byte(""), nil
	}
	t.Cleanup(func() { runDocker = old })

	if _, err := StartAuditAgent(AuditAgentSpec{
		WorkspaceName: "f", BP: "b", Sha: "s", Image: "img",
	}); err != nil {
		t.Fatalf("StartAuditAgent: %v", err)
	}
	if !calledDocker(calls, "start") || calledDocker(calls, "run") {
		t.Errorf("expected a start, not a run: %v", calls)
	}
}

func TestRemovingAnAgentThatIsNotThereIsNotAnError(t *testing.T) {
	old := runDocker
	runDocker = func(dir string, args ...string) ([]byte, error) {
		return []byte("Error: No such container: finance-invoices-audit-abc12345"),
			fmt.Errorf("exit status 1")
	}
	t.Cleanup(func() { runDocker = old })
	state, err := StopAuditAgent("finance", "invoices", "abc12345")
	if err != nil {
		t.Fatalf("StopAuditAgent: %v", err)
	}
	if running, _ := state["running"].(bool); running {
		t.Errorf("state = %v", state)
	}
}

func TestDraftingWritesIntoTheReportTheWorkspaceReads(t *testing.T) {
	var script string
	old := runDocker
	runDocker = func(dir string, args ...string) ([]byte, error) {
		if args[0] == "exec" {
			script = args[len(args)-1]
		}
		return []byte(""), nil
	}
	t.Cleanup(func() { runDocker = old })

	if _, err := DraftAuditReport("finance", "invoices", "abc12345", "check the VAT change"); err != nil {
		t.Fatalf("DraftAuditReport: %v", err)
	}
	if !strings.Contains(script, "> /audit/report.md") {
		t.Errorf("the draft must land in the report: %s", script)
	}
	if !strings.Contains(script, "'check the VAT change'") {
		t.Errorf("the auditor's prompt must reach the agent: %s", script)
	}
}

func TestAPromptCannotBreakOutOfTheAgentCommand(t *testing.T) {
	var script string
	old := runDocker
	runDocker = func(dir string, args ...string) ([]byte, error) {
		if args[0] == "exec" {
			script = args[len(args)-1]
		}
		return []byte(""), nil
	}
	t.Cleanup(func() { runDocker = old })

	if _, err := DraftAuditReport("f", "b", "s", "'; rm -rf /audit; echo '"); err != nil {
		t.Fatalf("DraftAuditReport: %v", err)
	}
	if strings.Contains(script, "; rm -rf /audit;") && !strings.Contains(script, `'\''`) {
		t.Errorf("the prompt was interpolated unquoted: %s", script)
	}
}

func calledDocker(calls []string, verb string) bool {
	for _, v := range calls {
		if v == verb {
			return true
		}
	}
	return false
}
