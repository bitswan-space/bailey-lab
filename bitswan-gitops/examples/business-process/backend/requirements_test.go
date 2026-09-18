package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// Tests for this business process's testable requirements.
//
// The binding between a requirement and its test is the test's NAME: it
// carries the requirement's id with hyphens turned into underscores, so
// REQ-H3AL is tested by TestREQ_H3AL_… . There is nothing else to register.
//
// These run inside the BP's live-dev container on every commit (see
// [testing] in ../process.toml). The source is mounted read-only there, so a
// test that needs to write must write to /tmp.

func TestREQ_H3AL_HealthEndpointReportsOK(t *testing.T) {
	app := &App{}
	rec := httptest.NewRecorder()

	app.handleHealth(rec, httptest.NewRequest(http.MethodGet, "/health", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	if body["status"] != "ok" {
		t.Errorf("status = %q, want %q", body["status"], "ok")
	}
}

func TestREQ_GR33_PublicRootGreetsTheCaller(t *testing.T) {
	app := &App{}
	rec := httptest.NewRecorder()

	app.handlePublicRoot(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	if body["message"] == "" {
		t.Error("public root returned no message")
	}
}

// TestREQ_D3M0_* exists to demonstrate a red row in Requirements & tests.
//
// It is skipped unless BITSWAN_DEMO_FAIL is set, because this directory is
// also covered by the repository's own `go test ./` CI job, and an
// unconditional failure here would turn that job red for everyone.
func TestREQ_D3M0_DeliberateFailure(t *testing.T) {
	if os.Getenv("BITSWAN_DEMO_FAIL") == "" {
		t.Skip("set BITSWAN_DEMO_FAIL=1 to see a failing requirement in the dashboard")
	}
	t.Fatal("this requirement's test fails on purpose — this text is what the dashboard shows")
}

// REQ-T0D0 has no test on purpose: it shows how an unverified requirement
// appears ("no test"), and that such a requirement does not block a deploy.
