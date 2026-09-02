package daemon

import (
	"net/http"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// Endpoints listing in bailey (GET /bailey/api/endpoints). Open to any
// signed-in user, and filtered per caller to the endpoints they are
// genuinely involved with: they own it, are granted on it, or are in a
// granted group of it. That is the same set roleFor admits at the gate, so
// what this lists is exactly what the caller can open.
//
// SECURITY (#337): the "server owner" — the recorded owner of the
// bailey.<domain> endpoint — used to additionally receive a read-only
// "viewer" row for EVERY endpoint on the server. This listing is what the
// console's "Apps you can access" grid is built from, so that override
// leaked other people's app hostnames, display names and business-process
// names to a caller the gate then refused. The identity itself has since
// been removed entirely: nothing in the daemon derives privilege from who
// owns the bailey endpoint. Server-wide auditing lives on
// /bailey/api/admin/acl, which is admin-gated in handleBailey; this
// endpoint is not an audit surface and widens for nobody.
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
	CallerRole      string          `json:"caller_role"`      // owner | access (never empty — roleless rows are omitted)
	Grants          []endpointGrant `json:"grants,omitempty"` // populated for the caller's own endpoints
}

type endpointListing struct {
	CallerEmail string              `json:"caller_email"`
	Endpoints   []endpointListEntry `json:"endpoints"`
}

// buildEndpointListing constructs the JSON used by the endpoints
// listing. The result is already filtered per caller — clients render
// it directly, and MUST be able to: a row reaching a client is a
// statement that the caller can open that endpoint.
//
// The filter fails closed. roleFor returning an error aborts the whole
// listing (the caller gets a 500) rather than emitting a row whose access
// we could not establish.
//
// All endpoint rows are read up-front into a slice, then closed
// before any other DB calls run. SetMaxOpenConns(1) on bailey.db
// means a still-open rows handle holds the only connection; calling
// roleFor or listGrants inside the loop would deadlock waiting for
// itself.
// r is unused by the filter itself (nothing about the caller's privileges
// depends on the request any more); it stays in the signature because
// request-scoped work is layered on top of this listing.
func buildEndpointListing(callerEmail string, callerGroups []string, r *http.Request) (*endpointListing, error) {
	endpoints, err := listAllEndpoints()
	if err != nil {
		return nil, err
	}
	out := &endpointListing{CallerEmail: callerEmail}
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
		// No role ⇒ the gate would deny this endpoint, so it must not appear
		// here either — not even for the server owner (#337).
		if entry.CallerRole == "" {
			continue
		}
		if entry.CallerRole == "owner" {
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
	full, err := workspaceInventory()
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
