package daemon

import (
	"strings"
)

// The workspace half of an endpoint's ACL (#251), described for the share
// dialog. This file changes NO access: workspace members have been able to
// open what their workspace deploys ever since roleFor gained parent
// delegation. It only assembles what the dialog needs to SHOW — which
// workspace is inherited, and exactly who that lets in — because the dialog
// used to list only endpoint_grants and so reported an endpoint with six
// workspace members as "1 person, no additional people yet".
//
// "The workspace" is the endpoint's recorded parent (its dashboard) —
// resolved by workspaceMembershipSurface, the same helper roleFor uses, so
// the dialog cannot describe a different set from the one the gate enforces.
// Its members are the parent endpoint's owner plus its email grantees, the
// same roster the server console's workspace drawer renders
// (workspaceMemberEmails). Group grants on the parent are reported but not
// enumerable as individuals — the dialog says so rather than under-reporting.

// endpointWorkspaceAccess is the `workspace` object in the share API's
// JSON. Absent (nil) for an endpoint with no membership surface, which is
// how the dialog knows not to draw the inherited row at all.
//
// JSON tags are snake_case: the share modal's JS reads these fields
// directly (w.label, w.members, …).
type endpointWorkspaceAccess struct {
	// Endpoint is the membership surface's hostname (the dashboard).
	Endpoint string `json:"endpoint"`
	// Label is a human name for the workspace, for the row's title. Best
	// effort and presentation-only — never used for an access decision.
	Label string `json:"label"`
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
// standalone route).
//
// A roster-enumeration failure degrades to a SHORTER member list, never to
// nil: whether the inheritance exists is decided by the endpoint's parent
// alone, so a failed listGrants must not be able to render the row away and
// imply the workspace has no access.
func workspaceAccessFor(ep *endpointRecord) *endpointWorkspaceAccess {
	surface := workspaceMembershipSurface(ep)
	if surface == "" {
		return nil
	}
	out := &endpointWorkspaceAccess{
		Endpoint: surface,
		Label:    workspaceLabelForDashboardHost(surface),
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
