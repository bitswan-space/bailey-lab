package daemon

import "testing"

// workspaceOwnerEmails must surface owner-role ACL grants (co-owners) alongside
// the recorded owner_email, and exclude access grantees — so the console can
// show every owner rather than the single owner_email slot.
func TestWorkspaceOwnerEmails_IncludesCoOwnersExcludesMembers(t *testing.T) {
	host := "coowner-dash.example.com"
	if _, err := registerEndpoint(host, "primary@example.com", "WS", "", "workspace", ""); err != nil {
		t.Fatalf("register: %v", err)
	}
	if err := addGrant(host, "email", "co@example.com", "owner", "primary@example.com"); err != nil {
		t.Fatalf("grant owner: %v", err)
	}
	if err := addGrant(host, "email", "member@example.com", "access", "primary@example.com"); err != nil {
		t.Fatalf("grant access: %v", err)
	}
	if err := addGrant(host, "group", "/Acme/devs", "owner", "primary@example.com"); err != nil {
		t.Fatalf("grant group-owner: %v", err)
	}

	owners := workspaceOwnerEmails(host)
	if len(owners) != 2 {
		t.Fatalf("want [primary, co], got %v", owners)
	}
	if owners[0] != "primary@example.com" {
		t.Fatalf("recorded owner must come first, got %v", owners)
	}
	seen := map[string]bool{}
	for _, o := range owners {
		seen[o] = true
	}
	if !seen["co@example.com"] {
		t.Fatalf("owner-role grant missing from owners: %v", owners)
	}
	if seen["member@example.com"] {
		t.Fatalf("access grantee must not appear as an owner: %v", owners)
	}
	// Group grants aren't emails — the members/owners email rosters only carry
	// email principals, so the group owner-grant is not in the email list.
	if seen["/Acme/devs"] {
		t.Fatalf("group principal must not appear in the email owner list: %v", owners)
	}
}
