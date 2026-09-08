package daemon

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// renameForm builds the rename body from REAL strings. parseFormVals (the
// shared helper) splits on & and = without decoding, so a pre-encoded value
// would be stored verbatim — the harness would test its own escaping instead
// of the handler's validation.
func renameForm(id, name string) url.Values {
	return url.Values{"id": {id}, "name": {name}}
}

// Renaming a device is what makes the handbook's incident-response advice
// workable (Ch. 04, "Your devices"): the auto-derived names come from the
// User-Agent, so three browsers on one laptop all read "Chrome on macOS" —
// indistinguishable at the moment you need to pick the one to sign out.

func TestDevicesAPI_Rename(t *testing.T) {
	email := "daprename@example.com"
	rec, err := addDevice(email, "Chrome on macOS")
	if err != nil {
		t.Fatal(err)
	}

	w := dispatch(baileyForm("/bailey/api/devices/rename", email,
		renameForm(rec.ID, "Work laptop")))
	if w.Code != http.StatusOK {
		t.Fatalf("rename = %d; body=%s", w.Code, w.Body.String())
	}

	var got struct {
		OK   bool   `json:"ok"`
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.OK || got.Name != "Work laptop" || got.ID != rec.ID {
		t.Errorf("response = %+v, want ok with the new name", got)
	}

	stored, err := findDevice(email, rec.ID)
	if err != nil || stored == nil {
		t.Fatalf("findDevice: %v (rec=%v)", err, stored)
	}
	if stored.Name != "Work laptop" {
		t.Errorf("stored name = %q, want %q", stored.Name, "Work laptop")
	}
}

// The name is a label a person types, so leading/trailing whitespace is theirs
// to fumble and ours to drop — but only whitespace. What is stored is what the
// response reports, so the UI never shows something different from the record.
func TestDevicesAPI_RenameTrimsWhitespace(t *testing.T) {
	email := "daptrim@example.com"
	rec, err := addDevice(email, "old")
	if err != nil {
		t.Fatal(err)
	}
	w := dispatch(baileyForm("/bailey/api/devices/rename", email,
		renameForm(rec.ID, "  Kitchen iPad  ")))
	if w.Code != http.StatusOK {
		t.Fatalf("rename = %d; body=%s", w.Code, w.Body.String())
	}
	stored, _ := findDevice(email, rec.ID)
	if stored == nil || stored.Name != "Kitchen iPad" {
		t.Errorf("stored name = %q, want %q", stored.Name, "Kitchen iPad")
	}
}

// A device id is not an authorisation. The UPDATE is scoped to the caller's
// email, so another user's id matches no row — 404, and their device keeps its
// name. Without the email scope this would be a cross-account write.
func TestDevicesAPI_RenameCannotTouchAnotherUsersDevice(t *testing.T) {
	owner := "dapowner@example.com"
	attacker := "dapattacker@example.com"
	rec, err := addDevice(owner, "Owner's laptop")
	if err != nil {
		t.Fatal(err)
	}
	// The attacker must have a device of their own, so the only thing being
	// tested is the scope of the write and not some earlier "no devices" path.
	if _, err := addDevice(attacker, "Attacker's laptop"); err != nil {
		t.Fatal(err)
	}

	w := dispatch(baileyForm("/bailey/api/devices/rename", attacker,
		renameForm(rec.ID, "pwned")))
	if w.Code != http.StatusNotFound {
		t.Errorf("cross-account rename = %d, want 404; body=%s", w.Code, w.Body.String())
	}
	stored, _ := findDevice(owner, rec.ID)
	if stored == nil || stored.Name != "Owner's laptop" {
		t.Errorf("another user's rename changed the record: %+v", stored)
	}
}

func TestDevicesAPI_RenameRejectsBadNames(t *testing.T) {
	email := "dapbad@example.com"
	rec, err := addDevice(email, "Original")
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct{ label, name string }{
		{"empty", ""},
		{"whitespace only", "   "},
		{"too long", strings.Repeat("x", deviceNameMaxLen+1)},
		{"newline", "Work\nlaptop"},
		{"control character", "Work\x00laptop"},
		{"tab", "Work\tlaptop"},
	}
	for _, c := range cases {
		t.Run(c.label, func(t *testing.T) {
			w := dispatch(baileyForm("/bailey/api/devices/rename", email,
				renameForm(rec.ID, c.name)))
			if w.Code != http.StatusBadRequest {
				t.Errorf("%s: status = %d, want 400; body=%s", c.label, w.Code, w.Body.String())
			}
		})
	}

	// Nothing above may have landed.
	stored, _ := findDevice(email, rec.ID)
	if stored == nil || stored.Name != "Original" {
		t.Errorf("a rejected name was still stored: %+v", stored)
	}
}

func TestDevicesAPI_RenameMissingID(t *testing.T) {
	w := dispatch(baileyForm("/bailey/api/devices/rename", "u@example.com",
		renameForm("", "Anything")))
	if w.Code != http.StatusBadRequest {
		t.Errorf("rename with no id = %d, want 400", w.Code)
	}
}

// A rename is a security-relevant edit to the device list, so it belongs in the
// audit log next to approve/revoke — otherwise a device could be quietly
// relabelled to look like one an admin recognises.
func TestDevicesAPI_RenameIsAudited(t *testing.T) {
	email := "dapaudit@example.com"
	rec, err := addDevice(email, "before")
	if err != nil {
		t.Fatal(err)
	}
	before := countAuditEvents(t, auditDeviceRename, rec.ID)

	w := dispatch(baileyForm("/bailey/api/devices/rename", email,
		renameForm(rec.ID, "after")))
	if w.Code != http.StatusOK {
		t.Fatalf("rename = %d; body=%s", w.Code, w.Body.String())
	}
	if got := countAuditEvents(t, auditDeviceRename, rec.ID); got != before+1 {
		t.Errorf("audit events for %s = %d, want %d", auditDeviceRename, got, before+1)
	}
}

// A rename that changes nothing (unknown id) must not write an audit entry —
// the log should record what happened, not what was attempted.
func TestDevicesAPI_UnsuccessfulRenameIsNotAudited(t *testing.T) {
	email := "dapnoaudit@example.com"
	if _, err := addDevice(email, "real"); err != nil {
		t.Fatal(err)
	}
	const ghost = "ffffffffffffffff"
	before := countAuditEvents(t, auditDeviceRename, ghost)

	w := dispatch(baileyForm("/bailey/api/devices/rename", email,
		renameForm(ghost, "whatever")))
	if w.Code != http.StatusNotFound {
		t.Fatalf("rename of an unknown id = %d, want 404", w.Code)
	}
	if got := countAuditEvents(t, auditDeviceRename, ghost); got != before {
		t.Errorf("a failed rename was audited: %d events, want %d", got, before)
	}
}

func countAuditEvents(t *testing.T, action, target string) int {
	t.Helper()
	db, err := openBaileyDB()
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM events WHERE action = ? AND target = ?`, action, target).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
