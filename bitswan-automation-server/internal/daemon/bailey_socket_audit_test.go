package daemon

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// #189 has two halves: gate the privileged socket mutations on the admin token,
// AND record the real caller in the audit event. These cover the second half.
//
// The distinction that matters: the admin token proves possession of a
// CREDENTIAL, not the identity of a person. Two different holders pass the gate
// — the host operator's CLI token and the daemon's own token (reachable by
// anyone who can `docker exec` into the daemon container). Attributing either to
// the root-admin address would put a named user's email on an action they may
// never have taken, which is worse than recording no name at all.

// findEvent returns the most recent audit row with the given action, or nil.
func findEvent(t *testing.T, action string) *eventRecord {
	t.Helper()
	events, err := dbListEvents(50)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	for i := range events {
		if events[i].Action == action {
			return &events[i]
		}
	}
	return nil
}

func TestCallerAdminPrincipal_IdentifiesTheCredential(t *testing.T) {
	s := &Server{token: "daemon-secret"}

	r := httptest.NewRequest(http.MethodPost, "/x", nil)
	r.Header.Set("Authorization", "Bearer daemon-secret")
	if p, ok := s.callerAdminPrincipal(r); !ok || p != adminPrincipalDaemon {
		t.Fatalf("daemon token → (%q, %v), want (%q, true)", p, ok, adminPrincipalDaemon)
	}

	// No header, wrong scheme, empty token, and a wrong secret all fail closed
	// without naming a principal.
	for _, tc := range []struct{ name, header string }{
		{"missing", ""},
		{"wrong scheme", "Basic daemon-secret"},
		{"empty token", "Bearer "},
		{"wrong token", "Bearer nope"},
	} {
		r := httptest.NewRequest(http.MethodPost, "/x", nil)
		if tc.header != "" {
			r.Header.Set("Authorization", tc.header)
		}
		if p, ok := s.callerAdminPrincipal(r); ok || p != "" {
			t.Errorf("%s → (%q, %v), want (\"\", false)", tc.name, p, ok)
		}
	}

	// callerHasAdminToken must stay consistent with it — the secret-read path
	// (#128) still uses the boolean form.
	r2 := httptest.NewRequest(http.MethodPost, "/x", nil)
	r2.Header.Set("Authorization", "Bearer daemon-secret")
	if !s.callerHasAdminToken(r2) {
		t.Error("callerHasAdminToken disagrees with callerAdminPrincipal")
	}
}

func TestDeviceApprove_AuditsTheCredentialNotTheRootAdmin(t *testing.T) {
	s := &Server{token: tSockAdminTok}
	email := "socket-audit-dev@example.com"
	_ = dbDeletePendingPairByEmail(email)
	e, err := generatePendingPair(email)
	if err != nil {
		t.Fatalf("generatePendingPair: %v", err)
	}

	w := httptest.NewRecorder()
	s.handleDeviceApprove(w, jsonReq(http.MethodPost, "/bailey/devices/approve",
		map[string]string{"code": e.Code}))
	if w.Code != http.StatusOK {
		t.Fatalf("approve = %d, want 200 (%s)", w.Code, w.Body.String())
	}

	// Minting device trust over the socket previously recorded nothing at all.
	ev := findEvent(t, auditDeviceApprove)
	if ev == nil {
		t.Fatal("socket device approval recorded no audit event")
	}
	if ev.Actor != adminPrincipalDaemon {
		t.Errorf("actor = %q, want the credential %q", ev.Actor, adminPrincipalDaemon)
	}
	if !strings.EqualFold(ev.Target, email) {
		t.Errorf("target = %q, want the affected user %q", ev.Target, email)
	}
	if strings.Contains(ev.Actor, "@") {
		t.Errorf("actor %q looks like a person's address; the token proves a credential, not an identity", ev.Actor)
	}

	// The pending-pair provenance should name the credential too, so the device
	// record itself says how it was approved.
	got, err := dbLoadPendingPairByCode(e.Code)
	if err != nil || got == nil {
		t.Fatalf("reload pending pair: %v", err)
	}
	if !strings.Contains(got.ApproverInfo, adminPrincipalDaemon) {
		t.Errorf("ApproverInfo = %q, want it to name the %q credential", got.ApproverInfo, adminPrincipalDaemon)
	}
}

func TestAccessGrantRevoke_AreAudited(t *testing.T) {
	s := &Server{token: tSockAdminTok}
	host := "socket-audit-acl.example.com"
	owner := "acl-audit-owner@example.com"
	grantee := "acl-audit-grantee@example.com"

	if _, err := registerEndpoint(host, owner, "ACL Audit App", "", "", ""); err != nil {
		t.Fatalf("registerEndpoint: %v", err)
	}

	w := httptest.NewRecorder()
	s.handleAccessGrant(w, jsonReq(http.MethodPost, "/bailey/access/grant",
		map[string]string{"host": host, "principal": grantee}))
	if w.Code != http.StatusOK {
		t.Fatalf("grant = %d, want 200 (%s)", w.Code, w.Body.String())
	}
	ev := findEvent(t, auditAccessGrant)
	if ev == nil {
		t.Fatal("access grant recorded no audit event")
	}
	if ev.Actor != adminPrincipalDaemon {
		t.Errorf("grant actor = %q, want %q", ev.Actor, adminPrincipalDaemon)
	}
	if !strings.Contains(ev.Target, host) || !strings.Contains(ev.Target, grantee) {
		t.Errorf("grant target = %q, want it to name the endpoint and the principal", ev.Target)
	}

	// A revoke deletes the row carrying granted_by, so without an event the
	// grant's only trace disappears with it.
	w = httptest.NewRecorder()
	s.handleAccessRevoke(w, jsonReq(http.MethodPost, "/bailey/access/revoke",
		map[string]string{"host": host, "principal": grantee}))
	if w.Code != http.StatusOK {
		t.Fatalf("revoke = %d, want 200 (%s)", w.Code, w.Body.String())
	}
	rev := findEvent(t, auditAccessRevoke)
	if rev == nil {
		t.Fatal("access revoke recorded no audit event — the grant's only trace is now gone")
	}
	if rev.Actor != adminPrincipalDaemon {
		t.Errorf("revoke actor = %q, want %q", rev.Actor, adminPrincipalDaemon)
	}
	if !strings.Contains(rev.Target, grantee) {
		t.Errorf("revoke target = %q, want it to name the principal", rev.Target)
	}
}
