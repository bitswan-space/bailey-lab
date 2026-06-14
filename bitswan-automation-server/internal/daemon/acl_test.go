package daemon

import (
	"strings"
	"testing"
)

func TestRegisterEndpoint_Idempotent(t *testing.T) {
	host := "acl-register.example.com"
	rec, err := registerEndpoint(host, "alice@example.com", "My App", "", "", "")
	if err != nil {
		t.Fatalf("registerEndpoint: %v", err)
	}
	if !strings.EqualFold(rec.Hostname, host) || !strings.EqualFold(rec.OwnerEmail, "alice@example.com") {
		t.Errorf("unexpected record: %+v", rec)
	}

	// Re-registering with a different owner must NOT steal the endpoint.
	rec2, err := registerEndpoint(host, "mallory@example.com", "Stolen", "", "", "")
	if err != nil {
		t.Fatalf("re-register: %v", err)
	}
	if !strings.EqualFold(rec2.OwnerEmail, "alice@example.com") {
		t.Errorf("re-register changed owner to %q", rec2.OwnerEmail)
	}
	if rec2.CreatedAt != rec.CreatedAt {
		t.Errorf("re-register changed created_at: %q → %q", rec.CreatedAt, rec2.CreatedAt)
	}
}

func TestRegisterEndpoint_RequiresOwner(t *testing.T) {
	if _, err := registerEndpoint("no-owner.example.com", "", "", "", "", ""); err == nil {
		t.Error("expected error for empty owner")
	}
	if _, err := registerEndpoint("", "a@b.c", "", "", "", ""); err == nil {
		t.Error("expected error for empty hostname")
	}
}

func TestRoleFor(t *testing.T) {
	host := "acl-rolefor.example.com"
	if _, err := registerEndpoint(host, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := addGrant(host, "email", "friend@example.com", "access", "owner@example.com"); err != nil {
		t.Fatal(err)
	}
	if err := addGrant(host, "group", "/Acme Org/devs", "access", "owner@example.com"); err != nil {
		t.Fatal(err)
	}
	if err := addGrant(host, "email", "coowner@example.com", "owner", "owner@example.com"); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name   string
		email  string
		groups []string
		want   endpointRole
	}{
		{"original owner", "owner@example.com", nil, roleOwner},
		{"original owner case-insensitive", "OWNER@Example.COM", nil, roleOwner},
		{"email grant", "friend@example.com", nil, roleAccess},
		{"owner grant short-circuits", "coowner@example.com", nil, roleOwner},
		{"group grant", "dev@example.com", []string{"/Acme Org/devs"}, roleAccess},
		{"no grant", "stranger@example.com", []string{"/Other Org/users"}, roleNone},
		{"unregistered endpoint", "owner@example.com", nil, roleNone},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := host
			if tc.name == "unregistered endpoint" {
				h = "never-registered.example.com"
			}
			got, err := roleFor(h, tc.email, tc.groups)
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Errorf("roleFor(%q, %q) = %q, want %q", h, tc.email, got, tc.want)
			}
		})
	}
}

func TestRemoveGrant(t *testing.T) {
	host := "acl-revoke.example.com"
	if _, err := registerEndpoint(host, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := addGrant(host, "email", "temp@example.com", "access", "owner@example.com"); err != nil {
		t.Fatal(err)
	}
	if role, _ := roleFor(host, "temp@example.com", nil); role != roleAccess {
		t.Fatalf("grant not effective, role = %q", role)
	}
	if err := removeGrant(host, "email", "temp@example.com", "access"); err != nil {
		t.Fatal(err)
	}
	if role, _ := roleFor(host, "temp@example.com", nil); role != roleNone {
		t.Errorf("revoked grant still effective, role = %q", role)
	}
}

func TestAddGrant_Validation(t *testing.T) {
	host := "acl-validate.example.com"
	if _, err := registerEndpoint(host, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := addGrant(host, "robot", "x", "access", "o"); err == nil {
		t.Error("expected error for invalid principal_type")
	}
	if err := addGrant(host, "email", "x@y.z", "superuser", "o"); err == nil {
		t.Error("expected error for invalid role")
	}
}

func TestAccessRequests(t *testing.T) {
	host := "acl-requests.example.com"
	if _, err := registerEndpoint(host, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := addAccessRequest(host, "wantsin@example.com"); err != nil {
		t.Fatal(err)
	}
	// Idempotent — a second request just refreshes the timestamp.
	if err := addAccessRequest(host, "wantsin@example.com"); err != nil {
		t.Fatal(err)
	}
	reqs, err := listAccessRequests(host)
	if err != nil {
		t.Fatal(err)
	}
	if len(reqs) != 1 || !strings.EqualFold(reqs[0].Email, "wantsin@example.com") {
		t.Fatalf("unexpected requests: %+v", reqs)
	}
	if err := removeAccessRequest(host, "wantsin@example.com"); err != nil {
		t.Fatal(err)
	}
	if reqs, _ := listAccessRequests(host); len(reqs) != 0 {
		t.Errorf("request not removed: %+v", reqs)
	}
}

func TestDeleteEndpoint_Cascades(t *testing.T) {
	host := "acl-delete.example.com"
	if _, err := registerEndpoint(host, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := addGrant(host, "email", "g@example.com", "access", "owner@example.com"); err != nil {
		t.Fatal(err)
	}
	if err := addAccessRequest(host, "r@example.com"); err != nil {
		t.Fatal(err)
	}
	if err := deleteEndpoint(host); err != nil {
		t.Fatal(err)
	}
	if ep, _ := getEndpoint(host); ep != nil {
		t.Error("endpoint still present after delete")
	}
	if grants, _ := listGrants(host); len(grants) != 0 {
		t.Errorf("grants survived endpoint delete: %+v", grants)
	}
	if reqs, _ := listAccessRequests(host); len(reqs) != 0 {
		t.Errorf("access requests survived endpoint delete: %+v", reqs)
	}
}

func TestRoleFor_ParentDelegation(t *testing.T) {
	// The workspace dashboard is the membership surface; endpoints
	// registered with it as parent treat every dashboard member —
	// owner OR access — as an owner, so workspace members can share
	// the automations they deploy.
	dashboard := "delegate-dashboard.example.com"
	child := "delegate-bp-frontend.example.com"
	if _, err := registerEndpoint(dashboard, "wsowner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := addGrant(dashboard, "email", "member@example.com", "access", "wsowner@example.com"); err != nil {
		t.Fatal(err)
	}
	if err := addGrant(dashboard, "group", "/Acme/devs", "access", "wsowner@example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint(child, "wsowner@example.com", "BP frontend", dashboard, "", ""); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name   string
		email  string
		groups []string
		host   string
		want   endpointRole
	}{
		{"dashboard owner owns child", "wsowner@example.com", nil, child, roleOwner},
		{"access member owns child", "member@example.com", nil, child, roleOwner},
		{"group member owns child", "dev@example.com", []string{"/Acme/devs"}, child, roleOwner},
		{"stranger has nothing on child", "stranger@example.com", nil, child, roleNone},
		// Delegation must not leak back: an access member stays
		// access on the dashboard itself.
		{"access member stays access on dashboard", "member@example.com", nil, dashboard, roleAccess},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := roleFor(tc.host, tc.email, tc.groups)
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Errorf("roleFor(%s, %s) = %q, want %q", tc.host, tc.email, got, tc.want)
			}
		})
	}
}

func TestRoleFor_SelfParentDoesNotRecurse(t *testing.T) {
	host := "delegate-self.example.com"
	if _, err := registerEndpoint(host, "owner@example.com", "", host, "", ""); err != nil {
		t.Fatal(err)
	}
	if role, err := roleFor(host, "stranger@example.com", nil); err != nil || role != roleNone {
		t.Errorf("self-parented endpoint: role=%q err=%v, want none/nil", role, err)
	}
}

func TestRegisterEndpoint_PreservesParent(t *testing.T) {
	host := "delegate-preserve.example.com"
	if _, err := registerEndpoint(host, "a@example.com", "", "parent.example.com", "", ""); err != nil {
		t.Fatal(err)
	}
	// Re-registration must not overwrite the recorded parent.
	rec, err := registerEndpoint(host, "b@example.com", "", "other.example.com", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if rec.ParentEndpoint != "parent.example.com" {
		t.Errorf("parent overwritten: %q", rec.ParentEndpoint)
	}
}

func TestListEndpointsWhereUserCanShare(t *testing.T) {
	owned := "acl-share-owned.example.com"
	granted := "acl-share-granted.example.com"
	other := "acl-share-other.example.com"
	if _, err := registerEndpoint(owned, "sharer@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint(granted, "someoneelse@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint(other, "someoneelse@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := addGrant(granted, "email", "sharer@example.com", "owner", "someoneelse@example.com"); err != nil {
		t.Fatal(err)
	}
	// access-only grant must NOT make `other` shareable
	if err := addGrant(other, "email", "sharer@example.com", "access", "someoneelse@example.com"); err != nil {
		t.Fatal(err)
	}

	eps, err := listEndpointsWhereUserCanShare("sharer@example.com", nil)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, e := range eps {
		got[strings.ToLower(e.Hostname)] = true
	}
	if !got[owned] || !got[granted] {
		t.Errorf("missing shareable endpoints, got %v", got)
	}
	if got[other] {
		t.Errorf("access-only endpoint listed as shareable: %v", got)
	}
}
