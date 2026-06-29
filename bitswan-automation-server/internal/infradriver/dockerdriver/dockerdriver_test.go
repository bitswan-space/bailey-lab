package dockerdriver

import "testing"

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
