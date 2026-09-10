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

func TestRestartingIDsIsTheOnlySubsetInspected(t *testing.T) {
	// The point of the subset: a healthy workspace must cost ZERO extra docker
	// commands, because the count comes from `docker inspect` — the call
	// ContainerList deliberately does not make per container.
	healthy := []infradriver.Container{
		{ID: "a", State: "running"},
		{ID: "b", State: "exited"},
		{ID: "c", State: "created"},
		{ID: "d", State: "paused"},
	}
	if got := restartingIDs(healthy); len(got) != 0 {
		t.Errorf("healthy workspace would inspect %v, want nothing", got)
	}
	mixed := []infradriver.Container{
		{ID: "a", State: "running"},
		{ID: "b", State: "restarting"},
		{ID: "c", State: "exited"},
		{ID: "d", State: "restarting"},
	}
	got := restartingIDs(mixed)
	if len(got) != 2 || got[0] != "b" || got[1] != "d" {
		t.Errorf("restartingIDs = %v, want [b d]", got)
	}
}

func TestParseRestartCounts(t *testing.T) {
	raw := []byte("abc123" + psSep + "23032\n" + "def456" + psSep + "0\n")
	got, err := parseRestartCounts(raw)
	if err != nil {
		t.Fatalf("parseRestartCounts: %v", err)
	}
	if got["abc123"] != 23032 {
		t.Errorf("abc123 = %d, want 23032", got["abc123"])
	}
	// A container really can report 0 while restarting (the first crash has
	// not been counted yet); that is a read value, not an absent one.
	n, ok := got["def456"]
	if !ok || n != 0 {
		t.Errorf("def456 = %d (present=%v), want 0 present", n, ok)
	}
	if len(got) != 2 {
		t.Errorf("got %d entries, want 2", len(got))
	}
}

func TestParseRestartCountsRefusesGarbageRatherThanGuessing(t *testing.T) {
	// A count we cannot read must not become 0 — "restarted 0 times" is a
	// claim, and the whole bug behind #463 was the UI making claims like it.
	for _, raw := range []string{
		"abc123" + psSep + "not-a-number\n",
		"abc123-with-no-separator\n",
	} {
		if _, err := parseRestartCounts([]byte(raw)); err == nil {
			t.Errorf("parseRestartCounts(%q) = no error, want one", raw)
		}
	}
}
