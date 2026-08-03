package daemon

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// Endpoints page in bailey. Shows a map of every protected
// endpoint with its owner + grants. Anyone signed in can open it
// (it's part of the chrome-wrapped bailey-admin), but the JSON API
// filters per caller:
//
//   - server owner (original owner of bailey.<domain>): sees
//     EVERY endpoint, with full ACL detail, in read-only audit mode.
//   - everyone else: sees only the endpoints they're involved with
//     (own, are granted on, or are in a granted group of).
//
// Modifying grants happens through /2fa-gate/share/<host>, which
// continues to enforce owner-only writes.

type endpointListEntry struct {
	Hostname    string `json:"hostname"`
	OwnerEmail  string `json:"owner_email"`
	DisplayName string `json:"display_name"`
	Kind        string `json:"kind"`  // workspace | frontend | service
	Stage       string `json:"stage"` // production | staging | dev | live-dev | ""
	CreatedAt   string `json:"created_at"`
	// ParentEndpoint is the hostname of the workspace dashboard this endpoint
	// delegates membership to (empty for top-level endpoints). Workspace and
	// BusinessProcess let clients group the flat listing into something
	// human-readable: Workspace is the name of the workspace the endpoint
	// belongs to (resolved from the parent dashboard host, or the endpoint's
	// own host for kind=workspace rows); BusinessProcess is the bitswan.yaml
	// business process a gitops-deployed route was reconciled from.
	ParentEndpoint  string          `json:"parent_endpoint,omitempty"`
	Workspace       string          `json:"workspace,omitempty"`
	BusinessProcess string          `json:"business_process,omitempty"`
	CallerRole      string          `json:"caller_role"`      // owner | access | viewer (server owner) | none
	Grants          []endpointGrant `json:"grants,omitempty"` // populated for owner/server-owner views
}

type endpointListing struct {
	CallerEmail   string              `json:"caller_email"`
	IsServerOwner bool                `json:"is_server_owner"`
	Endpoints     []endpointListEntry `json:"endpoints"`
}

// callerIsServerOwner reports whether the caller is the original
// owner of the bailey.<domain> endpoint. Used to gate the
// server-wide audit view.
func callerIsServerOwner(callerEmail string, r *http.Request) (bool, error) {
	host := serverBaileyAdminHost(r)
	if host == "" {
		return false, nil
	}
	ep, err := getEndpoint(host)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	if ep == nil {
		return false, nil
	}
	return strings.EqualFold(ep.OwnerEmail, callerEmail), nil
}

// serverBaileyAdminHost returns the hostname of the bailey-admin
// endpoint for this server. Prefers what the caller's request was
// addressed to (so the same daemon can serve multiple bailey-admin
// hosts if needed); falls back to the configured domain.
func serverBaileyAdminHost(r *http.Request) string {
	if r != nil {
		if h := requestEndpointHost(r); isBaileyHost(h) {
			return h
		}
	}
	sc, err := config.NewAutomationServerConfig().LoadConfig()
	if err != nil || sc == nil {
		return ""
	}
	if d := sc.ProtectedHostnameDomain(); d != "" {
		return "bailey." + d
	}
	return ""
}

// buildEndpointListing constructs the JSON used by the endpoints
// page. The result is already filtered per caller — clients render
// it directly.
//
// All endpoint rows are read up-front into a slice, then closed
// before any other DB calls run. SetMaxOpenConns(1) on bailey.db
// means a still-open rows handle holds the only connection; calling
// roleFor or listGrants inside the loop would deadlock waiting for
// itself.
func buildEndpointListing(callerEmail string, callerGroups []string, r *http.Request) (*endpointListing, error) {
	endpoints, err := listAllEndpoints()
	if err != nil {
		return nil, err
	}
	serverOwner, err := callerIsServerOwner(callerEmail, r)
	if err != nil {
		return nil, err
	}
	out := &endpointListing{
		CallerEmail:   callerEmail,
		IsServerOwner: serverOwner,
	}
	wsByDash := workspaceByDashboardHost()
	for _, ep := range endpoints {
		entry := endpointListEntry{
			Hostname:        ep.Hostname,
			OwnerEmail:      ep.OwnerEmail,
			DisplayName:     ep.DisplayName,
			Kind:            ep.Kind,
			Stage:           ep.Stage,
			CreatedAt:       ep.CreatedAt,
			ParentEndpoint:  ep.ParentEndpoint,
			BusinessProcess: ep.SourceBP,
		}
		// A parented endpoint belongs to its parent dashboard's workspace; a
		// parentless one may BE a workspace dashboard.
		if ep.ParentEndpoint != "" {
			entry.Workspace = wsByDash[strings.ToLower(ep.ParentEndpoint)]
		} else {
			entry.Workspace = wsByDash[strings.ToLower(ep.Hostname)]
		}
		role, err := roleFor(ep.Hostname, callerEmail, callerGroups)
		if err != nil {
			return nil, err
		}
		entry.CallerRole = string(role)
		if entry.CallerRole == "" && serverOwner {
			entry.CallerRole = "viewer"
		}
		if entry.CallerRole == "" {
			continue
		}
		if entry.CallerRole == "owner" || entry.CallerRole == "viewer" {
			grants, gerr := listGrants(ep.Hostname)
			if gerr != nil {
				return nil, gerr
			}
			entry.Grants = grants
		}
		out.Endpoints = append(out.Endpoints, entry)
	}
	return out, nil
}

// workspaceByDashboardHost maps each workspace's dashboard hostname (lowercase)
// to the workspace name, so endpoint entries can name the workspace they belong
// to. The host comes from the workspace's recorded metadata (dashboard-url),
// falling back to the conventional <name>-dashboard.<domain> — the same
// construction handleListAccessibleWorkspaces uses. Best-effort: on any error
// the map is just empty and entries go out ungrouped.
func workspaceByDashboardHost() map[string]string {
	out := map[string]string{}
	full, err := GetWorkspaceList(false, false)
	if err != nil || full == nil {
		return out
	}
	domain := ""
	if sc, err := config.NewAutomationServerConfig().LoadConfig(); err == nil && sc != nil {
		domain = sc.ProtectedHostnameDomain()
	}
	for _, ws := range full.Workspaces {
		host := workspaceDashboardEndpoint(ws.Name)
		if host == "" && domain != "" {
			host = strings.ToLower(ws.Name + "-dashboard." + domain)
		}
		if host != "" {
			out[host] = ws.Name
		}
	}
	return out
}
