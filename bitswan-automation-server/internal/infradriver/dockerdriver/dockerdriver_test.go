package dockerdriver

import (
	"strings"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

func TestParseInspect(t *testing.T) {
	// A two-container `docker inspect` sample: one healthy (with healthcheck),
	// one running without a healthcheck.
	raw := []byte(`[
	  {
	    "Id": "abc123",
	    "Name": "/acme-frontend-9f86-dev",
	    "State": {"Status": "running", "Health": {"Status": "healthy"}},
	    "Config": {"Image": "internal/acme-frontend:sha1", "Labels": {"gitops.deployment.id": "frontend-9f86-dev", "gitops.stage": "dev"}}
	  },
	  {
	    "Id": "def456",
	    "Name": "/acme__postgres-dev",
	    "State": {"Status": "running"},
	    "Config": {"Image": "postgres:16", "Labels": {"gitops.stage": "dev"}}
	  }
	]`)
	got, err := parseInspect(raw)
	if err != nil {
		t.Fatalf("parseInspect: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d containers, want 2", len(got))
	}
	if got[0].Name != "acme-frontend-9f86-dev" { // leading slash stripped
		t.Errorf("name = %q", got[0].Name)
	}
	if got[0].Health != "healthy" {
		t.Errorf("health = %q, want healthy", got[0].Health)
	}
	if got[0].Labels["gitops.deployment.id"] != "frontend-9f86-dev" {
		t.Errorf("labels not parsed: %v", got[0].Labels)
	}
	if got[1].Health != "" { // no healthcheck → empty
		t.Errorf("health = %q, want empty (no healthcheck)", got[1].Health)
	}
	if got[1].State != "running" {
		t.Errorf("state = %q, want running", got[1].State)
	}
}

func TestParsePS(t *testing.T) {
	// Lean field-separated `docker ps --format` (psFormat): ID,State,Status,
	// Image,CreatedAt,Names,Labels. One healthy (with healthcheck), one running
	// without, one exited. No `docker inspect`, no {{json .}}.
	row := func(f ...string) string { return strings.Join(f, psSep) }
	raw := []byte(strings.Join([]string{
		row("abc123", "running", "Up 2 hours (healthy)", "internal/acme-frontend:sha1", "2026-07-04 08:28:27 +0000 UTC", "acme-frontend-9f86-dev", "gitops.deployment.id=frontend-9f86-dev,gitops.stage=dev"),
		row("def456", "running", "Up 3 hours", "postgres:16", "2026-07-04 08:00:00 +0000 UTC", "acme__postgres-dev", "gitops.stage=dev"),
		row("ghi789", "exited", "Exited (0) 5 minutes ago", "busybox", "2026-07-03 09:00:00 +0000 UTC", "acme-old", ""),
	}, "\n") + "\n")
	got, err := parsePS(raw)
	if err != nil {
		t.Fatalf("parsePS: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d containers, want 3", len(got))
	}
	if got[0].Name != "acme-frontend-9f86-dev" {
		t.Errorf("name = %q", got[0].Name)
	}
	if got[0].State != "running" {
		t.Errorf("state = %q, want running", got[0].State)
	}
	if got[0].Health != "healthy" {
		t.Errorf("health = %q, want healthy", got[0].Health)
	}
	if got[0].Image != "internal/acme-frontend:sha1" {
		t.Errorf("image = %q", got[0].Image)
	}
	if got[0].Labels["gitops.deployment.id"] != "frontend-9f86-dev" ||
		got[0].Labels["gitops.stage"] != "dev" {
		t.Errorf("labels not parsed: %v", got[0].Labels)
	}
	if got[0].Created == 0 {
		t.Errorf("created not parsed")
	}
	if got[1].Health != "" { // no healthcheck → empty
		t.Errorf("health = %q, want empty", got[1].Health)
	}
	if got[2].State != "exited" {
		t.Errorf("state = %q, want exited", got[2].State)
	}
}

func TestEveryListedContainerIsInspectedInOneExec(t *testing.T) {
	// Both readings have to be there whatever state the poll catches: a
	// container that crashes every few minutes is `running` at most instants,
	// so inspecting only the ones caught mid-restart made the number blink in
	// and out. One exec covers them all — the measured cost is per-exec.
	cs := []infradriver.Container{
		{ID: "a", State: "running"},
		{ID: "b", State: "restarting"},
		{ID: "c", State: "exited"},
	}
	got := allIDs(cs)
	if len(got) != 3 || got[0] != "a" || got[1] != "b" || got[2] != "c" {
		t.Errorf("allIDs = %v, want [a b c]", got)
	}
	if len(allIDs(nil)) != 0 {
		t.Error("an empty listing must not run a command at all")
	}
}

func TestParseInspectReadings(t *testing.T) {
	raw := []byte("abc123" + psSep + "23032" + psSep + "2026-09-10T18:26:13.744009882Z\n" +
		"def456" + psSep + "0" + psSep + "2026-09-11T16:50:12.233568268Z\n")
	counts, started := parseInspectReadings(raw)
	if counts["abc123"] != 23032 {
		t.Errorf("abc123 = %d, want 23032", counts["abc123"])
	}
	// A container really can report 0 while restarting (the first crash has
	// not been counted yet); that is a read value, not an absent one.
	n, ok := counts["def456"]
	if !ok || n != 0 {
		t.Errorf("def456 = %d (present=%v), want 0 present", n, ok)
	}
	if len(counts) != 2 {
		t.Errorf("got %d counts, want 2", len(counts))
	}
	// Docker's RFC3339Nano has 9 fractional digits; it is parsed HERE, in Go,
	// and travels as unix seconds — Python's fromisoformat accepts 3 or 6.
	if started["abc123"] != 1789064773 {
		t.Errorf("abc123 started = %d, want 1789064773", started["abc123"])
	}
	if started["def456"] != 1789145412 {
		t.Errorf("def456 started = %d, want 1789145412", started["def456"])
	}
}

func TestBothReadingsRideOneInspect(t *testing.T) {
	// The measured cost is per-EXEC, so a second command must never creep back
	// in for the second field — and two inspects would be two instants, which
	// would let one record carry a count and a start time from different
	// moments (the "ONE record, ONE container" rule gitops enforces downstream).
	if !strings.Contains(inspectReadingsFormat, "{{.RestartCount}}") {
		t.Error("the inspect format must still read the restart count")
	}
	if !strings.Contains(inspectReadingsFormat, "{{.State.StartedAt}}") {
		t.Error("the inspect format must read the start time in the SAME exec")
	}
	if n := strings.Count(inspectReadingsFormat, psSep); n != 2 {
		t.Errorf("inspect format has %d separators, want 2 (id + 2 readings)", n)
	}
}

func TestAStartTimeThatWasNeverSetIsAbsentNotTheZeroTime(t *testing.T) {
	// A container created and never started reports Docker's zero time. That is
	// an absence, and it must be dropped at this first hop — never travel as
	// -62135596800, never as 0. A caller comparing start times to decide
	// whether a container restarted would read either as a real instant.
	raw := []byte("abc123" + psSep + "0" + psSep + "0001-01-01T00:00:00Z\n")
	counts, started := parseInspectReadings(raw)
	if _, ok := started["abc123"]; ok {
		t.Errorf("the zero time must be absent, got %d", started["abc123"])
	}
	// …and it costs the container nothing else: the count beside it was fine.
	if n, ok := counts["abc123"]; !ok || n != 0 {
		t.Errorf("count = %d (present=%v), want 0 present", n, ok)
	}
}

func TestAnUnreadableReadingCostsOnlyThatReading(t *testing.T) {
	// A count we cannot read must not become 0 — "restarted 0 times" is a
	// claim, and the whole bug behind #463 was the UI making claims like it.
	// Nor may one unreadable FIELD cost the container the other one, or one
	// unreadable LINE cost every other container: the crashlooper this feature
	// exists for would be the one to lose its number.
	raw := []byte(strings.Join([]string{
		"abc123" + psSep + "not-a-number" + psSep + "2026-09-10T18:26:13.744009882Z",
		"bad789" + psSep + "7" + psSep + "not-a-timestamp",
		"noseparatorhere",
		"def456" + psSep + "23032" + psSep + "2026-09-11T16:50:12.233568268Z",
	}, "\n") + "\n")
	counts, started := parseInspectReadings(raw)
	if _, ok := counts["abc123"]; ok {
		t.Error("a count that could not be read must be absent, not guessed at")
	}
	if started["abc123"] != 1789064773 {
		t.Error("an unreadable count must not cost the container its start time")
	}
	if counts["bad789"] != 7 {
		t.Errorf("bad789 count = %d, want 7 — an unreadable timestamp must not cost the count", counts["bad789"])
	}
	if _, ok := started["bad789"]; ok {
		t.Error("a start time that could not be read must be absent, not guessed at")
	}
	if counts["def456"] != 23032 {
		t.Errorf("def456 = %d, want 23032 — a bad line elsewhere must not cost it", counts["def456"])
	}
	if len(counts) != 2 || len(started) != 2 {
		t.Errorf("got %d counts / %d start times, want 2 / 2", len(counts), len(started))
	}
}
