package services

import (
	"os"
	"strings"
	"testing"
)

// A developer-run probe: prints the exact docker argv for a real audit agent so
// the mount semantics can be checked against a live Docker. Skipped unless
// AUDIT_ARGV_PROBE names a workspace/bp/sha triple.
func TestPrintAuditAgentArgv(t *testing.T) {
	spec := os.Getenv("AUDIT_ARGV_PROBE")
	if spec == "" {
		t.Skip("set AUDIT_ARGV_PROBE=workspace/bp/sha/image to print the argv")
	}
	parts := strings.Split(spec, "/")
	if len(parts) != 4 {
		t.Fatalf("AUDIT_ARGV_PROBE must be workspace/bp/sha/image, got %q", spec)
	}
	args := AuditAgentRunArgs(AuditAgentSpec{
		WorkspaceName: parts[0], BP: parts[1], Sha: parts[2], Image: parts[3],
	})
	t.Log("\n" + strings.Join(args, "\n"))
}
