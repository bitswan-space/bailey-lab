package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestUserRoles_EffectiveRoleAndCapability(t *testing.T) {
	writeTestConfig(t)
	if err := dbSetSetting(settingRootAdmin, "root@example.com", "root@example.com"); err != nil {
		t.Fatal(err)
	}
	// Root admin defaults to admin; an unset user defaults to member.
	if effectiveRole("root@example.com") != roleAdmin {
		t.Errorf("root admin effectiveRole = %q, want admin", effectiveRole("root@example.com"))
	}
	if effectiveRole("nobody@example.com") != roleMember {
		t.Errorf("unset user effectiveRole = %q, want member", effectiveRole("nobody@example.com"))
	}
	// A local assignment is authoritative for the role + admin capability.
	if err := dbSetUserRole("alice@example.com", roleAdmin, "root@example.com"); err != nil {
		t.Fatal(err)
	}
	if !callerIsAdmin("alice@example.com") {
		t.Error("locally-assigned admin is not treated as admin")
	}
	if err := dbSetUserRole("alice@example.com", roleUser, "root@example.com"); err != nil {
		t.Fatal(err)
	}
	if callerIsAdmin("alice@example.com") {
		t.Error("demoted user still treated as admin")
	}
}

func TestSetUserRole_Endpoint(t *testing.T) {
	writeTestConfig(t)
	if err := dbSetSetting(settingRootAdmin, "root@example.com", "root@example.com"); err != nil {
		t.Fatal(err)
	}
	// Valid assignment.
	w := httptest.NewRecorder()
	handleSetUserRole(w, baileyReqBody(http.MethodPost, "/bailey/api/people/role", "root@example.com", `{"email":"bob@example.com","role":"auditor"}`), "root@example.com")
	if w.Code != http.StatusOK {
		t.Fatalf("set role = %d; body=%s", w.Code, w.Body.String())
	}
	if effectiveRole("bob@example.com") != roleAuditor {
		t.Errorf("bob role not persisted: %q", effectiveRole("bob@example.com"))
	}
	// Invalid role → 400.
	w2 := httptest.NewRecorder()
	handleSetUserRole(w2, baileyReqBody(http.MethodPost, "/bailey/api/people/role", "root@example.com", `{"email":"bob@example.com","role":"superuser"}`), "root@example.com")
	if w2.Code != http.StatusBadRequest {
		t.Errorf("invalid role = %d, want 400", w2.Code)
	}
	// Root admin can't be demoted → 409.
	w3 := httptest.NewRecorder()
	handleSetUserRole(w3, baileyReqBody(http.MethodPost, "/bailey/api/people/role", "root@example.com", `{"email":"root@example.com","role":"member"}`), "root@example.com")
	if w3.Code != http.StatusConflict {
		t.Errorf("root-admin demote = %d, want 409", w3.Code)
	}
	_ = json.Marshal
	_ = strings.TrimSpace
}
