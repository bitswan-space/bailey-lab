package daemon

import (
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/services"
)

var auditKeyPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

type auditAgentRequest struct {
	Workspace string `json:"workspace"`
	BP        string `json:"bp"`
	Sha       string `json:"sha"`
	Prompt    string `json:"prompt,omitempty"`
}

func (a auditAgentRequest) valid() bool {
	return auditKeyPattern.MatchString(a.Workspace) &&
		auditKeyPattern.MatchString(a.BP) &&
		auditKeyPattern.MatchString(a.Sha)
}

func decodeAuditAgentRequest(w http.ResponseWriter, r *http.Request) (auditAgentRequest, bool) {
	var req auditAgentRequest
	if r.Method != http.MethodPost {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return req, false
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body", http.StatusBadRequest)
		return req, false
	}
	if !req.valid() {
		writeJSONError(w, "workspace, bp and sha are required", http.StatusBadRequest)
		return req, false
	}
	return req, true
}

func auditAgentSpec(req auditAgentRequest) services.AuditAgentSpec {
	return services.AuditAgentSpec{
		WorkspaceName: req.Workspace,
		BP:            req.BP,
		Sha:           req.Sha,
		Image:         auditAgentImage(),
		ExtensionDir:  os.Getenv("BITSWAN_CLAUDE_EXTENSION_DIR"),
	}
}

// auditAgentImage is the workspace's own coding-agent image: the audit agent is
// the same agent with a different, read-only job, and pinning it to whatever
// this deployment already runs means an audit never introduces a second
// version of the tool.
func auditAgentImage() string {
	if v := strings.TrimSpace(os.Getenv("BITSWAN_CODING_AGENT_IMAGE")); v != "" {
		return v
	}
	return "bitswan/coding-agent:latest"
}

// handleAuditAgentStart (POST /audit-agent/start) brings up the temporary agent
// for a frozen image. Called by gitops when an auditor freezes staging.
func (s *Server) handleAuditAgentStart(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeAuditAgentRequest(w, r)
	if !ok {
		return
	}
	state, err := services.StartAuditAgent(auditAgentSpec(req))
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, state)
}

// handleAuditAgentStop (POST /audit-agent/stop) removes it again — on unfreeze,
// or after the promotion the audit was for.
func (s *Server) handleAuditAgentStop(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeAuditAgentRequest(w, r)
	if !ok {
		return
	}
	state, err := services.StopAuditAgent(req.Workspace, req.BP, req.Sha)
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, state)
}

// handleAuditAgentDraft (POST /audit-agent/draft) has the agent read the audited
// source and the production diff and write the report.
func (s *Server) handleAuditAgentDraft(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeAuditAgentRequest(w, r)
	if !ok {
		return
	}
	state, err := services.DraftAuditReport(req.Workspace, req.BP, req.Sha, req.Prompt)
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, state)
}

// handleAuditAgentState (GET /audit-agent?workspace=&bp=&sha=) reports whether
// the agent for one audited image is there.
func (s *Server) handleAuditAgentState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	req := auditAgentRequest{
		Workspace: r.URL.Query().Get("workspace"),
		BP:        r.URL.Query().Get("bp"),
		Sha:       r.URL.Query().Get("sha"),
	}
	if !req.valid() {
		writeJSONError(w, "workspace, bp and sha are required", http.StatusBadRequest)
		return
	}
	state, err := services.AuditAgentState(req.Workspace, req.BP, req.Sha)
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, state)
}
