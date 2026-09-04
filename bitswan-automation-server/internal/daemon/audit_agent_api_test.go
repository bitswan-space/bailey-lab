package daemon

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func postAudit(t *testing.T, handler http.HandlerFunc, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/audit-agent/start", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler(rec, req)
	return rec
}

func TestAuditAgentRequestsNeedAWorkspaceBpAndSha(t *testing.T) {
	s := &Server{}
	for _, body := range []string{
		`{}`,
		`{"workspace":"finance"}`,
		`{"workspace":"finance","bp":"invoices"}`,
		`{"workspace":"../etc","bp":"invoices","sha":"abc"}`,
		`{"workspace":"finance","bp":"a/b","sha":"abc"}`,
		`{"workspace":"finance","bp":"invoices","sha":"../../escape"}`,
		`not json`,
	} {
		rec := postAudit(t, s.handleAuditAgentStart, body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %s → %d, want 400", body, rec.Code)
		}
	}
}

func TestAuditAgentStateNeedsTheSameThreeKeys(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest(http.MethodGet, "/audit-agent?workspace=finance", nil)
	rec := httptest.NewRecorder()
	s.handleAuditAgentState(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("state without a bp/sha → %d, want 400", rec.Code)
	}
}

func TestAuditAgentEndpointsRejectTheWrongMethod(t *testing.T) {
	s := &Server{}
	get := httptest.NewRequest(http.MethodGet, "/audit-agent/start", nil)
	rec := httptest.NewRecorder()
	s.handleAuditAgentStart(rec, get)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET on start → %d, want 405", rec.Code)
	}
	post := httptest.NewRequest(http.MethodPost, "/audit-agent", nil)
	rec = httptest.NewRecorder()
	s.handleAuditAgentState(rec, post)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST on state → %d, want 405", rec.Code)
	}
}

// The audit agent is the workspace's own coding-agent image with a read-only
// job: an audit must not introduce a second version of the tool.
func TestTheAuditAgentUsesTheWorkspacesCodingAgentImage(t *testing.T) {
	t.Setenv("BITSWAN_CODING_AGENT_IMAGE", "internal/coding-agent:sha123")
	if got := auditAgentImage(); got != "internal/coding-agent:sha123" {
		t.Errorf("auditAgentImage = %s", got)
	}
	t.Setenv("BITSWAN_CODING_AGENT_IMAGE", "")
	if got := auditAgentImage(); got != "bitswan/coding-agent:latest" {
		t.Errorf("auditAgentImage without an override = %s", got)
	}
}

func TestTheAuditAgentSpecCarriesTheExtensionWhenTheDaemonHasOne(t *testing.T) {
	t.Setenv("BITSWAN_CLAUDE_EXTENSION_DIR", "/repo/.claude-extension")
	spec := auditAgentSpec(auditAgentRequest{Workspace: "finance", BP: "invoices", Sha: "abc"})
	if spec.ExtensionDir != "/repo/.claude-extension" {
		t.Errorf("spec = %+v", spec)
	}
}

// gitops calls these with no bearer token over the trusted socket, so they have
// to stay classified as workspace-callable — adding an admin gate breaks the
// freeze path silently.
func TestTheAuditAgentRoutesAreWorkspaceCallable(t *testing.T) {
	for _, route := range []string{
		"/audit-agent", "/audit-agent/start", "/audit-agent/stop", "/audit-agent/draft",
	} {
		found := false
		for _, r := range socketWorkspaceCallableRoutes {
			if r == route {
				found = true
			}
		}
		if !found {
			t.Errorf("%s must be listed in socketWorkspaceCallableRoutes", route)
		}
	}
}

func TestAuditAgentStateAnswersJSON(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest(http.MethodGet, "/audit-agent?workspace=finance&bp=invoices&sha=abc12345", nil)
	rec := httptest.NewRecorder()
	s.handleAuditAgentState(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("state → %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("not JSON: %s", rec.Body.String())
	}
	name, _ := body["name"].(string)
	if !strings.HasPrefix(name, "finance-invoices-audit-") {
		t.Errorf("body = %v", body)
	}
}
