package daemon

import (
	"encoding/json"
	"net/http"
)

// GET /bailey/api/people/directory — a minimal people directory: every
// person on this server (invited-but-never-seen users included) as
// {email, name, invited}, sorted by email.
//
// Unlike /bailey/api/people (the admin roster with roles/devices/
// last-active), this is readable by anyone who OWNS a shareable
// endpoint — the same listEndpointsWhereUserCanShare authority that
// backs the gate's share index. That includes workspace owners and,
// via the dashboard's parent delegation, workspace members: both can
// already grant emails on endpoints they control, so both need to see
// who there is to grant. Someone who owns nothing shareable has no use
// for the server's email list and gets a 403.
//
// ROLE is the person's authoritative Bailey org role (admin | auditor |
// member | user) — the same value the admin roster reports. It's exposed
// here (not just on the admin-only /bailey/api/people) because who the
// admins and auditors are is already discoverable to any authenticated
// user via /bailey/auditors — a workspace owner managing people benefits
// from seeing those badges inline. No device counts or activity, though.
type directoryPersonDTO struct {
	Email   string `json:"email"`
	Name    string `json:"name,omitempty"`
	Invited bool   `json:"invited"`
	Role    string `json:"role,omitempty"`
}

func handleBaileyPeopleDirectory(w http.ResponseWriter, r *http.Request, email string) {
	if email == "" {
		writeJSONError(w, "no identity", http.StatusUnauthorized)
		return
	}
	_, groups := identityFromHeaders(r)
	if !callerIsAdmin(email) {
		owned, err := listEndpointsWhereUserCanShare(email, groups)
		if err != nil {
			writeJSONError(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if len(owned) == 0 {
			writeJSONError(w, "only endpoint owners can list the directory", http.StatusForbidden)
			return
		}
	}

	// Same degrade contract as /bailey/api/people: a partial-enumeration
	// failure returns what DID enumerate plus an `error` field, never a
	// fabricated (or silently truncated) directory.
	people, pErr := gatherPeople(r)
	out := make([]directoryPersonDTO, 0, len(people))
	for i := range people {
		out = append(out, directoryPersonDTO{
			Email:   people[i].Email,
			Name:    people[i].Name,
			Invited: people[i].InvitedOnly,
			Role:    people[i].Role,
		})
	}
	resp := map[string]any{"people": out}
	if pErr != nil {
		resp["error"] = pErr.Error()
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
