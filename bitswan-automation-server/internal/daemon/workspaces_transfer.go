package daemon

import (
	"encoding/json"
	"net/http"
	"strings"
)

// POST /bailey/api/workspaces/{name}/transfer-ownership {"email": "..."}
//
// Moves the workspace's recorded ownership to another user. Semantics:
//
//   - CALLER: only the workspace's recorded owner may transfer — checked
//     against the same membership surface workspaceOwnerEmail reads
//     (dashboard, falling back to gitops). Deliberately NO server-owner /
//     admin bypass: ownership is the owner's to give away, and an admin
//     path would let an admin silently take a workspace over via a proxy
//     owner. (This is stricter than trash/restore, which admins may do.)
//
//   - RECIPIENT: must already be a person on this server — someone in the
//     same roster gatherPeople builds (root admin, device owners, ACL
//     principals, TOTP enrollees, live invitees). Transferring to a free-
//     typed unknown email would hand the workspace to an account that may
//     never be able to log in, with no owner left who could fix it.
//
//   - EFFECT: the membership surface's owner_email is rewritten, and every
//     child endpoint that inherited the old owner at registration (gitops,
//     editor, gitops-deployed frontends — see reassignChildEndpoints)
//     follows. Children with a different explicit owner keep it. The old
//     owner is granted 'access' on the surface so they stay a member
//     instead of being locked out, and the new owner's now-redundant
//     access grant (if any) is dropped so the roster stays honest.
func handleTransferWorkspaceOwnership(w http.ResponseWriter, r *http.Request, email, workspaceName string) {
	var req struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "bad request", http.StatusBadRequest)
		return
	}
	newOwner := strings.TrimSpace(req.Email)
	if newOwner == "" {
		writeJSONError(w, "email of the new owner is required", http.StatusBadRequest)
		return
	}

	domain := configuredProtectedDomain()
	if domain == "" {
		writeJSONError(w, "server has no protected domain configured", http.StatusInternalServerError)
		return
	}
	dashboardHost := workspaceName + "-dashboard." + domain
	gitopsHost := workspaceName + "-gitops." + domain

	currentOwner := workspaceOwnerEmail(dashboardHost, gitopsHost)
	if currentOwner == "" {
		writeJSONError(w, "workspace has no recorded owner", http.StatusNotFound)
		return
	}
	if !strings.EqualFold(email, currentOwner) {
		writeJSONError(w, "only the workspace owner can transfer ownership", http.StatusForbidden)
		return
	}
	if strings.EqualFold(newOwner, currentOwner) {
		writeJSONError(w, "that user already owns this workspace", http.StatusConflict)
		return
	}

	// The recipient must be a known person on this server (see the roster
	// contract above). A partial-enumeration error only matters when it
	// hides the recipient — if they're found in what DID enumerate, proceed.
	people, pErr := gatherPeople(r)
	known := false
	for i := range people {
		if strings.EqualFold(people[i].Email, newOwner) {
			known = true
			break
		}
	}
	if !known {
		if pErr != nil {
			writeJSONError(w, "couldn't verify the new owner: "+pErr.Error(), http.StatusInternalServerError)
			return
		}
		writeJSONError(w, newOwner+" isn't on this server yet — invite them first", http.StatusBadRequest)
		return
	}

	// The membership surface is the dashboard endpoint when it exists
	// (the canonical case), otherwise gitops (--no-dashboard workspaces) —
	// the same fallback workspaceOwnerEmail just resolved the owner from.
	surfaceHost := dashboardHost
	if ep, err := getEndpoint(dashboardHost); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	} else if ep == nil {
		surfaceHost = gitopsHost
	}

	if err := setEndpointOwner(surfaceHost, newOwner); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := reassignChildEndpoints(surfaceHost, currentOwner, newOwner); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// Pre-parent-linkage gitops rows: registered before the dashboard row
	// existed, so parent_endpoint is empty and the child sweep misses them.
	if surfaceHost != gitopsHost {
		if ep, _ := getEndpoint(gitopsHost); ep != nil && ep.ParentEndpoint == "" && strings.EqualFold(ep.OwnerEmail, currentOwner) {
			if err := setEndpointOwner(gitopsHost, newOwner); err != nil {
				writeJSONError(w, err.Error(), http.StatusInternalServerError)
				return
			}
		}
	}

	// Keep the old owner in the workspace as a member, and drop the new
	// owner's now-shadowed access grant. Both best-effort ACL bookkeeping:
	// ownership has already moved, so surface a failure without pretending
	// the transfer didn't happen.
	if err := addGrant(surfaceHost, "email", currentOwner, string(roleAccess), email); err != nil {
		writeJSONError(w, "ownership transferred, but keeping you as a member failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	_ = removeGrant(surfaceHost, "email", newOwner, string(roleAccess))

	_ = recordEvent(email, auditWorkspaceTransfer, workspaceName+" → "+newOwner)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":          true,
		"workspace":   workspaceName,
		"owner_email": newOwner,
	})
}
