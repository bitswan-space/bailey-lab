package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Tests for the auditor/admin roster: dbListUsersByRoles (store) and
// handleWorkspaceAuditors (GET /bailey/auditors) — the roster the dashboard
// Audits panel shows a member so they know who to ask for a production review.
func TestWorkspaceAuditors_ListAndEndpoint(t *testing.T) {
	writeTestConfig(t)
	if err := dbSetSetting(settingRootAdmin, "root@example.com", "root@example.com"); err != nil {
		t.Fatal(err)
	}
	for email, role := range map[string]string{
		"aud@example.com": roleAuditor,
		"adm@example.com": roleAdmin,
		"mem@example.com": roleMember,
	} {
		if err := dbSetUserRole(email, role, "root@example.com"); err != nil {
			t.Fatal(err)
		}
	}

	// dbListUsersByRoles returns only the requested roles (admin + auditor),
	// never a member; empty roles → nil.
	rows, err := dbListUsersByRoles(roleAdmin, roleAuditor)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, r := range rows {
		got[r.Email] = r.Role
	}
	if got["adm@example.com"] != roleAdmin || got["aud@example.com"] != roleAuditor {
		t.Errorf("dbListUsersByRoles missing admin/auditor: %+v", rows)
	}
	if _, ok := got["mem@example.com"]; ok {
		t.Error("member must not appear in the admin/auditor roster")
	}
	if r, err := dbListUsersByRoles(); err != nil || r != nil {
		t.Errorf("no roles should return (nil, nil), got (%+v, %v)", r, err)
	}

	// GET /bailey/auditors returns the roster, including the bootstrap root
	// admin (who may carry no explicit user_roles row).
	w := httptest.NewRecorder()
	(&Server{}).handleWorkspaceAuditors(w, httptest.NewRequest(http.MethodGet, "/bailey/auditors", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("GET auditors = %d; body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Users []userRole `json:"users"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v\n%s", err, w.Body.String())
	}
	var haveRoot, haveAud, haveMem bool
	for _, u := range resp.Users {
		switch u.Email {
		case "root@example.com":
			haveRoot = u.Role == roleAdmin
		case "aud@example.com":
			haveAud = u.Role == roleAuditor
		case "mem@example.com":
			haveMem = true
		}
	}
	if !haveRoot {
		t.Errorf("root admin missing from roster: %+v", resp.Users)
	}
	if !haveAud {
		t.Errorf("auditor missing from roster: %+v", resp.Users)
	}
	if haveMem {
		t.Error("member must not appear in the roster")
	}

	// Non-GET → 405.
	w2 := httptest.NewRecorder()
	(&Server{}).handleWorkspaceAuditors(w2, httptest.NewRequest(http.MethodPost, "/bailey/auditors", nil))
	if w2.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST auditors = %d, want 405", w2.Code)
	}
}
