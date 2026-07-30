package daemon

import (
	"strings"
)

// The workspace half of an endpoint's union ACL (#251), described for the
// share dialog. Enforcement lives in roleFor — this file only assembles
// what the dialog needs to SHOW: which workspace is inherited, whether
// the switch is on, and who that actually lets in.
//
// "The workspace" is the endpoint's recorded parent (its dashboard); its
// members are the parent endpoint's owner plus its email grantees, which
// is the same roster the server console's workspace drawer renders
// (workspaceMemberEmails). Group grants on the parent are counted but not
// enumerable as individuals — the dialog says so rather than under-reporting.

// endpointWorkspaceAccess is the `workspace` object in the share API's
// JSON. Absent (nil) for an endpoint with no membership surface, which is
// how the dialog knows not to draw the inherited row at all.
//
// JSON tags are snake_case: the share modal's JS reads these fields
// directly (w.enabled, w.members, …).
type endpointWorkspaceAccess struct {
	// Endpoint is the membership surface's hostname (the dashboard).
	Endpoint string `json:"endpoint"`
	// Label is a human name for the workspace, for the row's title. Best
	// effort and presentation-only — never used for an access decision.
	Label string `json:"label"`
	// Enabled mirrors endpoints.inherit_workspace_members: true means every
	// member below can open this endpoint.
	Enabled bool `json:"enabled"`
	// Members are the individually-identifiable members of the workspace
	// (owner first). The dialog enumerates these so an admin can see who
	// "workspace members" means.
	Members []string `json:"members"`
	// Groups are Keycloak group paths granted on the workspace. They also
	// come with the inheritance, but can't be expanded to individuals
	// without querying Keycloak, so they're reported separately.
	Groups []string `json:"groups,omitempty"`
}

// workspaceAccessFor describes the inherited half of ep's ACL, or nil when
// ep has no workspace membership surface (a dashboard itself, or a
// standalone route). Enumeration failures degrade to a shorter member list
// — never to a claim that the inheritance isn't there — because Enabled is
// read from the endpoint row, not from the roster.
func workspaceAccessFor(ep *endpointRecord) *endpointWorkspaceAccess {
	surface := workspaceMembershipSurface(ep)
	if surface == "" {
		return nil
	}
	out := &endpointWorkspaceAccess{
		Endpoint: surface,
		Label:    workspaceLabelForDashboardHost(surface),
		Enabled:  ep.InheritWorkspaceMembers,
		Members:  workspaceMemberEmails(surface),
	}
	if grants, err := listGrants(surface); err == nil {
		for _, g := range grants {
			if g.PrincipalType == "group" {
				out.Groups = append(out.Groups, g.PrincipalValue)
			}
		}
	}
	if out.Members == nil {
		out.Members = []string{}
	}
	return out
}

// workspaceLabelForDashboardHost names the workspace behind a dashboard
// hostname. Prefers the server's real workspace list (the authoritative
// name); falls back to the host's first DNS label with a "-dashboard"
// suffix trimmed, which is how workspace dashboards are named.
//
// This is a LABEL, for the dialog's row title. It is never consulted for
// authorization — that always keys on the hostname.
func workspaceLabelForDashboardHost(host string) string {
	if name := workspaceByDashboardHost()[strings.ToLower(host)]; name != "" {
		return name
	}
	label := host
	if i := strings.Index(label, "."); i > 0 {
		label = label[:i]
	}
	return strings.TrimSuffix(label, "-dashboard")
}
