package cmd

import (
	"strings"
	"testing"
)

// The contract file is all this CLI owns now: running tests and producing
// verdicts moved to gitops (and is tested there), so what is left to pin down
// here is the file format, id minting, and how server verdicts are merged in.

func TestParseDropsStatusAndKeepsTheContract(t *testing.T) {
	reqs := parseRequirementsToml(`[[requirement]]
id = "REQ-7QX4"
parent = ""
description = "totals include VAT"
status = "pass"
automation = "backend"

[[requirement]]
id = "AI-8ABC"
parent = "REQ-7QX4"
description = "proposed by the agent"
origin = "proposed"
`)
	if len(reqs) != 2 {
		t.Fatalf("expected 2 requirements, got %d", len(reqs))
	}
	// A stale `status` in the file must not become a verdict.
	if reqs[0].Status != "" {
		t.Errorf("status was read from the file: %q", reqs[0].Status)
	}
	if reqs[0].Automation != "backend" {
		t.Errorf("automation = %q", reqs[0].Automation)
	}
	if reqs[1].Origin != "proposed" || reqs[1].Parent != "REQ-7QX4" {
		t.Errorf("proposed child not parsed: %+v", reqs[1])
	}
}

func TestSerializeWritesNoStatus(t *testing.T) {
	out := serializeRequirementsToml([]Requirement{
		{ID: "REQ-7QX4", Description: "a", Status: "pass"},
	})
	if strings.Contains(out, "status") {
		t.Errorf("serialized a verdict into the contract:\n%s", out)
	}
	if !strings.Contains(out, `id = "REQ-7QX4"`) {
		t.Errorf("missing id:\n%s", out)
	}
}

func TestSerializeOmitsEmptyOptionalKeys(t *testing.T) {
	out := serializeRequirementsToml([]Requirement{{ID: "REQ-7QX4"}})
	for _, key := range []string{"origin", "automation", "runner"} {
		if strings.Contains(out, key) {
			t.Errorf("unset %s was written:\n%s", key, out)
		}
	}
}

func TestRoundTrip(t *testing.T) {
	in := []Requirement{
		{ID: "REQ-7QX4", Description: "a", Automation: "backend"},
		{ID: "AI-8ABC", Parent: "REQ-7QX4", Description: "b", Origin: "proposed"},
	}
	out := parseRequirementsToml(serializeRequirementsToml(in))
	if len(out) != len(in) {
		t.Fatalf("round trip lost rows: %d -> %d", len(in), len(out))
	}
	for i := range in {
		if out[i].ID != in[i].ID || out[i].Origin != in[i].Origin ||
			out[i].Automation != in[i].Automation || out[i].Parent != in[i].Parent {
			t.Errorf("row %d changed: %+v -> %+v", i, in[i], out[i])
		}
	}
}

func TestNextReqIDIsRandomSoCopiesDoNotCollide(t *testing.T) {
	// The old max+1 scheme made two copies mint REQ-004 independently and
	// fuse two different requirements when they merged.
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		id := nextReqID(nil, "REQ-")
		if !strings.HasPrefix(id, "REQ-") || len(id) != 8 {
			t.Fatalf("unexpected id shape: %q", id)
		}
		seen[id] = true
	}
	if len(seen) < 40 {
		t.Errorf("ids are not random enough: %d distinct out of 50", len(seen))
	}
}

func TestNextReqIDAvoidsExistingIDs(t *testing.T) {
	existing := []Requirement{}
	for i := 0; i < 5; i++ {
		existing = append(existing, Requirement{ID: nextReqID(existing, "REQ-")})
	}
	id := nextReqID(existing, "REQ-")
	for _, r := range existing {
		if r.ID == id {
			t.Fatalf("minted an id that already exists: %s", id)
		}
	}
}

func TestApplyVerdictsFillsStatusFromTheServer(t *testing.T) {
	reqs := []Requirement{{ID: "REQ-AAAA"}, {ID: "REQ-BBBB"}}
	state := &reqTestState{Requirements: []reqTestResult{
		{ID: "REQ-AAAA", Verdict: "pass"},
	}}
	out := applyVerdicts(reqs, state)
	if out[0].Status != "pass" {
		t.Errorf("verdict not applied: %q", out[0].Status)
	}
	// Nobody has judged REQ-BBBB — that is not the same as a test waiting to run.
	if out[1].Status != "unknown" {
		t.Errorf("unjudged requirement should be unknown, got %q", out[1].Status)
	}
}

func TestApplyVerdictsWithNoServerStateIsNotFatal(t *testing.T) {
	out := applyVerdicts([]Requirement{{ID: "REQ-AAAA"}}, nil)
	if out[0].Status != "unknown" {
		t.Errorf("expected unknown without server state, got %q", out[0].Status)
	}
}

func TestNextNonPassingGoesDeepestFirst(t *testing.T) {
	reqs := []Requirement{
		{ID: "A", Status: "fail"},
		{ID: "B", Parent: "A", Status: "fail"},
		{ID: "C", Parent: "B", Status: "pass"},
	}
	next, path := dfsNextNonPassing(reqs)
	if next == nil || next.ID != "B" {
		t.Fatalf("expected the deepest non-passing requirement B, got %+v", next)
	}
	if len(path) != 2 || path[0].ID != "A" {
		t.Errorf("unexpected path: %+v", path)
	}
}

func TestTestStatePathEscapesItsArguments(t *testing.T) {
	got := testStatePath("/run", "my bp", "my copy")
	if !strings.Contains(got, "my%20bp") || !strings.Contains(got, "copy=my+copy") {
		t.Errorf("path not escaped: %s", got)
	}
}

func TestShortSHA(t *testing.T) {
	if shortSHA("abcdef1234567") != "abcdef1" {
		t.Errorf("unexpected short sha: %s", shortSHA("abcdef1234567"))
	}
	if shortSHA("abc") != "abc" {
		t.Errorf("short input should pass through")
	}
}
