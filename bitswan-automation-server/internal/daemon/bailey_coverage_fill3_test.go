package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// --- handleGateRecover error branches ----------------------------------

func TestGateRecover_BackupInvalid(t *testing.T) {
	markServerClaimed(t)
	email := "recbkbad@example.com"
	if err := dbSaveBackupCodes(email, []string{"REAL-0001"}); err != nil {
		t.Fatal(err)
	}
	w := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/recover", email, `{"backup":"FAKE-9999"}`))
	if w.Code != http.StatusUnauthorized {
		t.Errorf("invalid backup = %d, want 401", w.Code)
	}
}

func TestGateRecover_TOTPWrong(t *testing.T) {
	markServerClaimed(t)
	email := "rectotpwrong@example.com"
	if err := dbSaveTOTP(&totpRecord{Email: email, Secret: "JBSWY3DPEHPK3PXP", CreatedAt: nowRFC3339()}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbDeleteTOTP(email) })
	w := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/recover", email, `{"totp":"000000"}`))
	if w.Code != http.StatusUnauthorized {
		t.Errorf("wrong recover totp = %d, want 401", w.Code)
	}
}

func TestGateRecover_BackupOnlyAccount_WrongTOTPFallthrough(t *testing.T) {
	markServerClaimed(t)
	// Backup codes only (no authenticator): submitting a totp must 403
	// (authenticator not set up) after the backup branch is skipped.
	email := "recbackuponly@example.com"
	_ = dbDeleteTOTP(email)
	if err := dbSaveBackupCodes(email, []string{"ONLY-0001"}); err != nil {
		t.Fatal(err)
	}
	w := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/recover", email, `{"totp":"123456"}`))
	if w.Code != http.StatusForbidden {
		t.Errorf("totp on backup-only account = %d, want 403", w.Code)
	}
}

// --- bailey_admin_devices.go current-device flag -----------------------

func TestAdminDevices_MarksCurrentDevice(t *testing.T) {
	email := "addevcurrent@example.com"
	rec, err := addDevice(email, "Current")
	if err != nil {
		t.Fatal(err)
	}
	// Roles are authoritative in the local DB now; make the caller a real admin.
	if err := dbSetUserRole(email, roleAdmin, "test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbDeleteUserRole(email) })
	// Build an admin request that ALSO presents this device's cookie under
	// the same email, so currentDeviceForRequest resolves it.
	w0 := httptest.NewRecorder()
	if err := setDeviceCookie(w0, baileyReq(http.MethodGet, "/", email), email, rec.ID); err != nil {
		t.Fatal(err)
	}
	r := baileyReq(http.MethodGet, "/bailey/api/admin/devices", email, adminGrp)
	for _, c := range w0.Result().Cookies() {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	(&Server{}).handleBailey(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("admin devices = %d", w.Code)
	}
	var resp adminDevicesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	var sawCurrent bool
	for _, u := range resp.Users {
		if strings.EqualFold(u.Email, email) {
			for _, d := range u.Devices {
				if d.ID == rec.ID && d.IsCurrent {
					sawCurrent = true
				}
			}
		}
	}
	if !sawCurrent {
		t.Error("current device not flagged in admin devices view")
	}
}

// --- bailey_store_settings.go record with updated_at -------------------

func TestStoreSettings_RecordHasTimestamp(t *testing.T) {
	key := "ts_setting"
	if err := dbSetSetting(key, "v", "who@example.com"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbDeleteSetting(key) })
	rec, err := dbGetSettingRecord(key)
	if err != nil || rec == nil {
		t.Fatal(err)
	}
	if rec.UpdatedAt == "" {
		t.Error("record missing updated_at timestamp")
	}
}

// --- mfa_account inline status non-admin returnTo ----------------------

func TestInlineTOTPStatusHTML_AdminWithReturnTo(t *testing.T) {
	h := inlineTOTPStatusHTML("x@example.com", true, "/devices")
	if !strings.Contains(h, "Disable TOTP") || !strings.Contains(h, "/devices") {
		t.Error("admin inline status missing disable form / return_to")
	}
}

// --- mfa_scene smoke ---------------------------------------------------

func TestScenePageAndSignedInRow(t *testing.T) {
	page := scenePage("Title", "Pill", scPillWarning, "<div>card</div>", "foot note", "", "")
	if !strings.Contains(page, "Title") || !strings.Contains(page, "card") {
		t.Error("scenePage missing title/card")
	}
	row := sceneSignedInRow("user@example.com")
	if !strings.Contains(row, "user@example.com") {
		t.Error("sceneSignedInRow missing email")
	}
}
