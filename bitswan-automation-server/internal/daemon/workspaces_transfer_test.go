package daemon

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Tests for POST /bailey/api/workspaces/{name}/transfer-ownership
// (workspaces_transfer.go): recorded-owner-only (no admin bypass),
// recipient must be a known person, surface + inherited children move,
// old owner stays a member, explicit child owners are preserved.

// transferReq posts a transfer as `caller` proposing `newOwner`.
func transferReq(ws, caller, newOwner string, groups ...string) *http.Request {
	return gateAPIJSON(http.MethodPost, "/bailey/api/workspaces/"+ws+"/transfer-ownership",
		caller, fmt.Sprintf(`{"email":%q}`, newOwner), groups...)
}

// transferWorkspace registers the canonical endpoint pair (dashboard as
// the membership surface, gitops parented to it) under `owner` and
// returns the two hosts. Rows are cleaned up with the test.
func transferWorkspace(t *testing.T, name, owner string) (dash, gitops string) {
	t.Helper()
	domain := writeTestConfig(t)
	dash = name + "-dashboard." + domain
	gitops = name + "-gitops." + domain
	if _, err := registerEndpoint(dash, owner, name+" (dashboard)", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint(gitops, owner, name+" (gitops)", dash, endpointKindService, ""); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = deleteEndpoint(dash); _ = deleteEndpoint(gitops) })
	return dash, gitops
}

func ownerOf(t *testing.T, host string) string {
	t.Helper()
	ep, err := getEndpoint(host)
	if err != nil || ep == nil {
		t.Fatalf("endpoint %s: %v", host, err)
	}
	return ep.OwnerEmail
}

// hasAccessGrant reports whether email holds an access grant on host.
func hasAccessGrant(t *testing.T, host, email string) bool {
	t.Helper()
	grants, err := listGrants(host)
	if err != nil {
		t.Fatal(err)
	}
	for _, g := range grants {
		if g.PrincipalType == "email" && strings.EqualFold(g.PrincipalValue, email) && g.Role == roleAccess {
			return true
		}
	}
	return false
}

func TestTransferOwnership_MovesSurfaceChildrenAndDemotesOldOwner(t *testing.T) {
	const (
		oldOwner = "old-owner@example.com"
		newOwner = "new-owner@example.com"
		deployer = "member@example.com"
	)
	dash, gitops := transferWorkspace(t, "transferws", oldOwner)
	domain := strings.TrimPrefix(dash, "transferws-dashboard.")
	// A frontend that inherited the workspace owner at registration…
	inherited := "transferws-app.c.transferws." + domain
	if _, err := registerEndpoint(inherited, oldOwner, "App", dash, endpointKindFrontend, "production"); err != nil {
		t.Fatal(err)
	}
	// …and one registered with a different explicit owner (manual add-route).
	explicit := "transferws-tool.c.transferws." + domain
	if _, err := registerEndpoint(explicit, deployer, "Tool", dash, endpointKindFrontend, "production"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = deleteEndpoint(inherited); _ = deleteEndpoint(explicit) })

	// The recipient was invited into the server (that's what makes them a
	// known person the transfer accepts) and is already a member of this
	// workspace — the access grant must be dropped once they own it.
	seedInvite(t, newOwner, roleMember, time.Hour)
	if err := addGrant(dash, "email", newOwner, string(roleAccess), oldOwner); err != nil {
		t.Fatal(err)
	}

	w := dispatch(transferReq("transferws", oldOwner, newOwner))
	if w.Code != http.StatusOK {
		t.Fatalf("transfer = %d; body=%s", w.Code, w.Body.String())
	}

	if got := ownerOf(t, dash); !strings.EqualFold(got, newOwner) {
		t.Errorf("dashboard owner = %q, want %q", got, newOwner)
	}
	if got := ownerOf(t, gitops); !strings.EqualFold(got, newOwner) {
		t.Errorf("gitops owner = %q, want %q", got, newOwner)
	}
	if got := ownerOf(t, inherited); !strings.EqualFold(got, newOwner) {
		t.Errorf("inherited frontend owner = %q, want %q", got, newOwner)
	}
	if got := ownerOf(t, explicit); !strings.EqualFold(got, deployer) {
		t.Errorf("explicitly-owned frontend owner = %q, want %q (must not move)", got, deployer)
	}

	// Old owner is now a member; the new owner's access grant is gone.
	if !hasAccessGrant(t, dash, oldOwner) {
		t.Error("old owner has no access grant — they were locked out of the workspace")
	}
	if hasAccessGrant(t, dash, newOwner) {
		t.Error("new owner still carries a redundant access grant")
	}

	// The new owner (and not the old) now passes the owner capability
	// checks the trash/update handlers use.
	if !callerOwnsWorkspace(newOwner, nil, false, "transferws") {
		t.Error("new owner does not pass callerOwnsWorkspace")
	}
	if callerOwnsWorkspace(oldOwner, nil, false, "transferws") {
		t.Error("old owner still passes callerOwnsWorkspace")
	}

	// The transfer landed in the audit feed.
	events, err := dbListEvents(10)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range events {
		if e.Action == auditWorkspaceTransfer && e.Actor == oldOwner && strings.Contains(e.Target, newOwner) {
			found = true
		}
	}
	if !found {
		t.Errorf("no %s audit event recorded", auditWorkspaceTransfer)
	}
}

func TestTransferOwnership_OnlyTheOwnerMayTransfer(t *testing.T) {
	const oldOwner = "held-owner@example.com"
	dash, _ := transferWorkspace(t, "heldws", oldOwner)
	seedInvite(t, "held-recipient@example.com", roleMember, time.Hour)

	// A workspace member can't take it.
	if err := addGrant(dash, "email", "held-member@example.com", string(roleAccess), oldOwner); err != nil {
		t.Fatal(err)
	}
	w := dispatch(transferReq("heldws", "held-member@example.com", "held-recipient@example.com"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("member transfer = %d, want 403; body=%s", w.Code, w.Body.String())
	}

	// Neither can a Bailey admin — ownership is the owner's alone to give.
	const admin = "held-admin@example.com"
	if err := dbSetUserRole(admin, roleAdmin, "test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbDeleteUserRole(admin) })
	w = dispatch(transferReq("heldws", admin, "held-recipient@example.com", adminGrp))
	if w.Code != http.StatusForbidden {
		t.Fatalf("admin transfer = %d, want 403; body=%s", w.Code, w.Body.String())
	}
	if got := ownerOf(t, dash); !strings.EqualFold(got, oldOwner) {
		t.Errorf("owner changed to %q by a rejected transfer", got)
	}
}

func TestTransferOwnership_RecipientMustBeOnTheServer(t *testing.T) {
	const oldOwner = "strict-owner@example.com"
	dash, _ := transferWorkspace(t, "strictws", oldOwner)

	w := dispatch(transferReq("strictws", oldOwner, "stranger@example.com"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("uninvited transfer = %d, want 400; body=%s", w.Code, w.Body.String())
	}
	if got := ownerOf(t, dash); !strings.EqualFold(got, oldOwner) {
		t.Errorf("owner changed to %q by a rejected transfer", got)
	}

	// A live invite is enough to make the recipient transferable-to.
	seedInvite(t, "strict-invitee@example.com", roleMember, time.Hour)
	w = dispatch(transferReq("strictws", oldOwner, "strict-invitee@example.com"))
	if w.Code != http.StatusOK {
		t.Fatalf("invited transfer = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	if got := ownerOf(t, dash); !strings.EqualFold(got, "strict-invitee@example.com") {
		t.Errorf("owner = %q, want the invitee", got)
	}
}

func TestTransferOwnership_SelfAndMissingTargets(t *testing.T) {
	const oldOwner = "selfws-owner@example.com"
	transferWorkspace(t, "selfws", oldOwner)

	if w := dispatch(transferReq("selfws", oldOwner, oldOwner)); w.Code != http.StatusConflict {
		t.Errorf("self transfer = %d, want 409", w.Code)
	}
	if w := dispatch(transferReq("selfws", oldOwner, "")); w.Code != http.StatusBadRequest {
		t.Errorf("empty recipient = %d, want 400", w.Code)
	}
	// A workspace with no recorded owner has nothing to transfer.
	if w := dispatch(transferReq("ghostws", oldOwner, "anyone@example.com")); w.Code != http.StatusNotFound {
		t.Errorf("ownerless workspace = %d, want 404", w.Code)
	}
}

func TestTransferOwnership_NoDashboardFallsBackToGitops(t *testing.T) {
	const oldOwner = "nodash-owner@example.com"
	domain := writeTestConfig(t)
	gitops := "nodashws-gitops." + domain
	// --no-dashboard workspace: gitops is the membership surface, no parent.
	if _, err := registerEndpoint(gitops, oldOwner, "", "", endpointKindService, ""); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = deleteEndpoint(gitops) })
	seedInvite(t, "nodash-recipient@example.com", roleMember, time.Hour)

	w := dispatch(transferReq("nodashws", oldOwner, "nodash-recipient@example.com"))
	if w.Code != http.StatusOK {
		t.Fatalf("transfer = %d; body=%s", w.Code, w.Body.String())
	}
	if got := ownerOf(t, gitops); !strings.EqualFold(got, "nodash-recipient@example.com") {
		t.Errorf("gitops owner = %q, want the recipient", got)
	}
	if !hasAccessGrant(t, gitops, oldOwner) {
		t.Error("old owner has no access grant on the gitops surface")
	}
}
