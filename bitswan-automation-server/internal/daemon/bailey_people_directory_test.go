package daemon

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Tests for GET /bailey/api/people/directory (bailey_people_directory.go):
// endpoint owners (NOT just admins) can read the minimal directory; people
// with nothing shareable can't; invited-only users appear flagged.

func directoryPeople(t *testing.T, caller string, groups ...string) (int, []directoryPersonDTO) {
	t.Helper()
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/people/directory", caller, groups...))
	var resp struct {
		People []directoryPersonDTO `json:"people"`
	}
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v\n%s", err, w.Body.String())
		}
	}
	return w.Code, resp.People
}

func TestPeopleDirectory_EndpointOwnerCanList(t *testing.T) {
	const owner = "dir-owner@example.com"
	domain := writeTestConfig(t)
	host := "dirws-dashboard." + domain
	if _, err := registerEndpoint(host, owner, "", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = deleteEndpoint(host) })
	// An invited-but-never-seen user must appear, flagged.
	seedInvite(t, "dir-invitee@example.com", roleMember, time.Hour)

	code, people := directoryPeople(t, owner)
	if code != http.StatusOK {
		t.Fatalf("owner directory = %d, want 200", code)
	}
	var invitee *directoryPersonDTO
	for i := range people {
		if strings.EqualFold(people[i].Email, "dir-invitee@example.com") {
			invitee = &people[i]
		}
	}
	if invitee == nil {
		t.Fatalf("invited user missing from directory: %+v", people)
	}
	if !invitee.Invited {
		t.Error("invited-only user not flagged invited")
	}
}

// The directory carries each person's authoritative Bailey org role so the
// workspace people panel can badge admins/auditors inline.
func TestPeopleDirectory_ReportsOrgRole(t *testing.T) {
	const owner = "dirrole-owner@example.com"
	const auditor = "dirrole-auditor@example.com"
	domain := writeTestConfig(t)
	host := "dirrolews-dashboard." + domain
	if _, err := registerEndpoint(host, owner, "", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = deleteEndpoint(host) })
	// A person with the auditor role, surfaced into the roster via a pending
	// invite. The directory must report their role, not just the picker fields.
	seedInvite(t, auditor, roleAuditor, time.Hour)

	code, people := directoryPeople(t, owner)
	if code != http.StatusOK {
		t.Fatalf("owner directory = %d, want 200", code)
	}
	var got *directoryPersonDTO
	for i := range people {
		if strings.EqualFold(people[i].Email, auditor) {
			got = &people[i]
		}
	}
	if got == nil {
		t.Fatalf("auditor missing from directory: %+v", people)
	}
	if got.Role != roleAuditor {
		t.Errorf("directory role = %q, want %q", got.Role, roleAuditor)
	}
}

func TestPeopleDirectory_RequiresOwnedEndpointUnlessAdmin(t *testing.T) {
	writeTestConfig(t)
	// A user who owns nothing shareable is refused.
	code, _ := directoryPeople(t, "dir-nobody@example.com")
	if code != http.StatusForbidden {
		t.Fatalf("ownerless caller = %d, want 403", code)
	}
	// An admin with no endpoints still passes (they see the full roster
	// via /bailey/api/people anyway).
	const admin = "dir-admin@example.com"
	if err := dbSetUserRole(admin, roleAdmin, "test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbDeleteUserRole(admin) })
	if code, _ := directoryPeople(t, admin); code != http.StatusOK {
		t.Fatalf("admin directory = %d, want 200", code)
	}
}
