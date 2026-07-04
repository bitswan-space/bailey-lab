package dockerdriver

import (
	"strings"
	"testing"
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
