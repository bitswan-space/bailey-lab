package daemon

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// The socket API gitops calls on the coding agent's behalf (issue #210).
//
// It is on the workspace-callable side of the socket, next to /bailey/role and
// /ingress: gitops reaches it with no bearer token, and "came in over the
// socket" therefore means "a first-party workspace container", not "an
// operator". That is the right tier for this, because everything it can do is
// already bounded by the endpoint rules in canGiveAgentSession — a caller can
// only ever get a session for a live-dev frontend, which is a copy's own
// sandbox. It mints nothing for staging or production, and grants no role.

type agentIdentityRequest struct {
	Label     string   `json:"label"`
	Email     string   `json:"email"`
	Groups    []string `json:"groups"`
	Workspace string   `json:"workspace"`
}

type agentSessionRequest struct {
	Label        string `json:"label"`
	EndpointHost string `json:"endpoint_host"`
	Workspace    string `json:"workspace"`
}

// handleAgentIdentities serves the test identities: GET lists a workspace's,
// POST creates or updates one, DELETE removes it along with its sessions.
func (s *Server) handleAgentIdentities(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		ws := strings.TrimSpace(r.URL.Query().Get("workspace"))
		if ws == "" {
			writeJSONError(w, "workspace query parameter is required", http.StatusBadRequest)
			return
		}
		ids, err := dbListAgentIdentities(ws)
		if err != nil {
			writeJSONError(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeAgentJSON(w, map[string]any{"identities": ids})
	case http.MethodPost:
		var req agentIdentityRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSONError(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		label, err := validateAgentLabel(req.Label)
		if err != nil {
			writeJSONError(w, err.Error(), http.StatusBadRequest)
			return
		}
		ws := strings.TrimSpace(req.Workspace)
		if ws == "" {
			writeJSONError(w, "workspace is required", http.StatusBadRequest)
			return
		}
		email := strings.TrimSpace(req.Email)
		if email == "" {
			email = defaultAgentEmail(label, ws)
		}
		groups := []string{}
		for _, g := range req.Groups {
			if g = strings.TrimSpace(g); g != "" {
				groups = append(groups, g)
			}
		}
		id := agentIdentity{
			Label:     label,
			Email:     email,
			Groups:    groups,
			Workspace: ws,
			CreatedAt: time.Now().UTC(),
		}
		if err := dbUpsertAgentIdentity(id); err != nil {
			writeJSONError(w, err.Error(), http.StatusInternalServerError)
			return
		}
		// A re-created identity may have different groups; a token minted under
		// the old set would otherwise stay in the cache for its whole lifetime.
		forgetAgentTokens(label)
		writeAgentJSON(w, map[string]any{"identity": id})
	case http.MethodDelete:
		label := strings.TrimSpace(r.URL.Query().Get("label"))
		ws := strings.TrimSpace(r.URL.Query().Get("workspace"))
		if label == "" || ws == "" {
			writeJSONError(w, "label and workspace query parameters are required", http.StatusBadRequest)
			return
		}
		if err := dbDeleteAgentIdentity(label, ws); err != nil {
			writeJSONError(w, err.Error(), http.StatusInternalServerError)
			return
		}
		forgetAgentTokens(label)
		writeAgentJSON(w, map[string]any{"deleted": label})
	default:
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleAgentSession mints one browser session: a cookie value for one identity
// on one live-dev endpoint, plus the router that lets a request carrying it skip
// the sign-in on that endpoint.
func (s *Server) handleAgentSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req agentSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	label := strings.TrimSpace(req.Label)
	host := toOuterHost(strings.ToLower(strings.TrimSpace(req.EndpointHost)))
	ws := strings.TrimSpace(req.Workspace)
	if label == "" || host == "" || ws == "" {
		writeJSONError(w, "label, endpoint_host and workspace are required", http.StatusBadRequest)
		return
	}
	if currentAgentIssuerURL() == "" {
		writeJSONError(w, "this server has no domain yet, so it cannot issue agent tokens", http.StatusConflict)
		return
	}
	id, err := dbGetAgentIdentity(label)
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if id == nil || !strings.EqualFold(id.Workspace, ws) {
		writeJSONError(w, "no such test identity in this workspace", http.StatusNotFound)
		return
	}
	if ok, reason := canGiveAgentSession(host); !ok {
		writeJSONError(w, reason, http.StatusForbidden)
		return
	}
	if err := registerAgentRoute(host); err != nil {
		writeJSONError(w, "could not register the agent route: "+err.Error(), http.StatusBadGateway)
		return
	}
	token, handover, sess, err := dbCreateAgentSession(label, host, ws, agentSessionTTL)
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeAgentJSON(w, map[string]any{
		"cookie_name":   agentSessionCookie,
		"cookie_value":  token,
		"cookie_domain": "." + protectedHostnameDomain(),
		// The URL signs a browser in on arrival. It is the one that works for a
		// browser already running, which the agent's tools always are.
		"url":      "https://" + host + "/?" + agentHandoverParam + "=" + url.QueryEscape(handover),
		"app_url":  "https://" + host + "/",
		"email":         id.Email,
		"groups":        id.Groups,
		"expires_at":    sess.ExpiresAt.Format(time.RFC3339),
	})
}
