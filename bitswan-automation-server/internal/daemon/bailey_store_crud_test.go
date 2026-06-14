package daemon

import (
	"testing"
	"time"
)

// --- server_settings CRUD (bailey_store_settings.go) --------------------

func TestStoreSettings_CRUD(t *testing.T) {
	key := "test_setting_crud"
	_ = dbDeleteSetting(key)

	// Absent key reads back ("", nil) — not an error.
	if v, err := dbGetSetting(key); err != nil || v != "" {
		t.Fatalf("absent get = (%q,%v), want (\"\",nil)", v, err)
	}
	if rec, err := dbGetSettingRecord(key); err != nil || rec != nil {
		t.Fatalf("absent record = (%v,%v), want (nil,nil)", rec, err)
	}

	// Set then read.
	if err := dbSetSetting(key, "value1", "alice@example.com"); err != nil {
		t.Fatal(err)
	}
	if v, err := dbGetSetting(key); err != nil || v != "value1" {
		t.Fatalf("get after set = (%q,%v), want value1", v, err)
	}
	rec, err := dbGetSettingRecord(key)
	if err != nil || rec == nil {
		t.Fatalf("record after set = (%v,%v)", rec, err)
	}
	if rec.Value != "value1" || rec.UpdatedBy != "alice@example.com" || rec.Key != key {
		t.Errorf("record = %+v", rec)
	}

	// Upsert replaces value + updated_by.
	if err := dbSetSetting(key, "value2", "bob@example.com"); err != nil {
		t.Fatal(err)
	}
	rec2, _ := dbGetSettingRecord(key)
	if rec2.Value != "value2" || rec2.UpdatedBy != "bob@example.com" {
		t.Errorf("after upsert = %+v", rec2)
	}

	// Delete clears it.
	if err := dbDeleteSetting(key); err != nil {
		t.Fatal(err)
	}
	if v, _ := dbGetSetting(key); v != "" {
		t.Errorf("get after delete = %q, want empty", v)
	}
}

// --- events audit log (bailey_store_audit.go) ---------------------------

func TestStoreAudit_RecordAndList(t *testing.T) {
	// Append a couple of distinct events, then read back newest-first.
	if err := recordEvent("actor1@example.com", auditDeviceApprove, "dev-1"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)
	if err := recordEvent("actor2@example.com", auditWorkspaceCreate, "ws-audit"); err != nil {
		t.Fatal(err)
	}

	evs, err := dbListEvents(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) < 2 {
		t.Fatalf("got %d events, want >=2", len(evs))
	}
	// Newest first: the workspace.create we just wrote should precede the
	// device.approve (rowid DESC tiebreak even if ts collides).
	var sawCreate bool
	for _, e := range evs {
		if e.Action == auditWorkspaceCreate && e.Target == "ws-audit" {
			sawCreate = true
			if e.Actor != "actor2@example.com" {
				t.Errorf("actor = %q", e.Actor)
			}
		}
	}
	if !sawCreate {
		t.Error("recorded workspace.create event not found in list")
	}
}

func TestStoreAudit_ListDefaultLimit(t *testing.T) {
	// limit <= 0 falls back to the 25 default without error.
	if _, err := dbListEvents(0); err != nil {
		t.Fatal(err)
	}
	if _, err := dbListEvents(-5); err != nil {
		t.Fatal(err)
	}
}

// --- devices CRUD (bailey_store_devices.go) -----------------------------

func TestStoreDevices_CRUD(t *testing.T) {
	email := "devuser@example.com"

	d, err := dbAddDevice(email, "Laptop")
	if err != nil {
		t.Fatal(err)
	}
	if d.ID == "" || d.Name != "Laptop" {
		t.Fatalf("addDevice = %+v", d)
	}

	// Default name when blank.
	d2, err := dbAddDevice(email, "  ")
	if err != nil {
		t.Fatal(err)
	}
	if d2.Name == "" {
		t.Error("blank name was not defaulted")
	}

	if !dbAnyDevicesExist() {
		t.Error("dbAnyDevicesExist = false after adding")
	}

	// Find by id.
	found, err := dbFindDevice(email, d.ID)
	if err != nil || found == nil || found.ID != d.ID {
		t.Fatalf("findDevice = (%v,%v)", found, err)
	}
	// Find missing returns (nil,nil).
	missing, err := dbFindDevice(email, "deadbeef")
	if err != nil || missing != nil {
		t.Errorf("findDevice(missing) = (%v,%v)", missing, err)
	}

	// List for the user.
	list, err := dbListDevices(email)
	if err != nil || len(list) < 2 {
		t.Fatalf("listDevices = (%d,%v)", len(list), err)
	}

	// List all includes the email column.
	all, err := dbListAllDevices()
	if err != nil {
		t.Fatal(err)
	}
	var sawEmail bool
	for _, dev := range all {
		if dev.Email == email {
			sawEmail = true
		}
	}
	if !sawEmail {
		t.Error("listAllDevices did not include the added device email")
	}

	// Touch updates last_seen (no error path; just exercise it).
	dbTouchDevice(email, d.ID)
	touched, _ := dbFindDevice(email, d.ID)
	if touched.LastSeen == "" {
		t.Error("touch did not set last_seen")
	}

	// Remove.
	if err := dbRemoveDevice(email, d.ID); err != nil {
		t.Fatal(err)
	}
	if gone, _ := dbFindDevice(email, d.ID); gone != nil {
		t.Error("device still present after remove")
	}
}

// --- TOTP records + signing key (bailey_store_totp.go) ------------------

func TestStoreTOTP_CRUD(t *testing.T) {
	email := "totpstore@example.com"
	_ = dbDeleteTOTP(email)

	// Missing reads back os.ErrNotExist.
	if _, err := dbLoadTOTP(email); err == nil {
		t.Error("missing TOTP load returned nil error")
	}

	rec := &totpRecord{Email: email, Secret: "SECRET123", CreatedAt: nowRFC3339()}
	if err := dbSaveTOTP(rec); err != nil {
		t.Fatal(err)
	}
	got, err := dbLoadTOTP(email)
	if err != nil || got.Secret != "SECRET123" {
		t.Fatalf("load = (%v,%v)", got, err)
	}

	// Upsert replaces secret.
	rec.Secret = "SECRET456"
	if err := dbSaveTOTP(rec); err != nil {
		t.Fatal(err)
	}
	got2, _ := dbLoadTOTP(email)
	if got2.Secret != "SECRET456" {
		t.Errorf("secret after upsert = %q", got2.Secret)
	}

	// Enrolled set includes this email (lowercased).
	set, err := dbListTOTPEnrolledEmails()
	if err != nil {
		t.Fatal(err)
	}
	if !set[email] {
		t.Error("enrolled set missing email")
	}

	if err := dbDeleteTOTP(email); err != nil {
		t.Fatal(err)
	}
	if _, err := dbLoadTOTP(email); err == nil {
		t.Error("TOTP still loads after delete")
	}
}

func TestStoreSigningKey_StableAcrossCalls(t *testing.T) {
	k1, err := dbSigningKey()
	if err != nil {
		t.Fatal(err)
	}
	if len(k1) < 32 {
		t.Fatalf("signing key too short: %d", len(k1))
	}
	k2, err := dbSigningKey()
	if err != nil {
		t.Fatal(err)
	}
	if string(k1) != string(k2) {
		t.Error("signing key changed between calls; must be persisted")
	}
}

// --- backup codes (bailey_store_backupcodes.go) -------------------------

func TestStoreBackupCodes_NormalizeHashConsumeReplace(t *testing.T) {
	if got := normalizeBackupCode(" ab-cd 12 "); got != "ABCD12" {
		t.Errorf("normalize = %q, want ABCD12", got)
	}
	if normalizeBackupCode("-- !! ") != "" {
		t.Error("normalize of punctuation-only should be empty")
	}
	// Hash is stable under formatting differences.
	if hashBackupCode("abcd-1234") != hashBackupCode("ABCD1234") {
		t.Error("hash not stable across formatting")
	}

	email := "bkstore@example.com"
	if err := dbSaveBackupCodes(email, []string{"AAAA-1111", "BBBB-2222", "  "}); err != nil {
		t.Fatal(err)
	}
	if !dbBackupCodesExist(email) {
		t.Fatal("backup codes not saved")
	}

	// Empty/blank code never matches.
	if ok, _ := dbConsumeBackupCode(email, "   "); ok {
		t.Error("blank code consumed")
	}
	// Valid code consumes once.
	ok, err := dbConsumeBackupCode(email, "aaaa1111")
	if err != nil || !ok {
		t.Fatalf("consume = (%v,%v)", ok, err)
	}
	// Single-use: again fails.
	if ok2, _ := dbConsumeBackupCode(email, "aaaa1111"); ok2 {
		t.Error("code was reusable")
	}

	// Re-save replaces the set: the surviving BBBB code is gone.
	if err := dbSaveBackupCodes(email, []string{"CCCC-3333"}); err != nil {
		t.Fatal(err)
	}
	if ok, _ := dbConsumeBackupCode(email, "bbbb2222"); ok {
		t.Error("old code survived a re-save")
	}
	if ok, _ := dbConsumeBackupCode(email, "cccc3333"); !ok {
		t.Error("new code not present after re-save")
	}
}

// --- pending pairs (bailey_store_pendingpairs.go) -----------------------

func TestStorePendingPairs_CRUD(t *testing.T) {
	email := "ppstore@example.com"
	_ = dbDeletePendingPairByEmail(email)

	now := time.Now()
	e := &pairingEntry{
		Email:     email,
		Code:      "654321",
		IssuedAt:  now,
		ExpiresAt: now.Add(5 * time.Minute),
	}
	if err := dbUpsertPendingPair(e); err != nil {
		t.Fatal(err)
	}

	byEmail, err := dbLoadPendingPairByEmail(email)
	if err != nil || byEmail == nil || byEmail.Code != "654321" {
		t.Fatalf("loadByEmail = (%v,%v)", byEmail, err)
	}
	byCode, err := dbLoadPendingPairByCode("654321")
	if err != nil || byCode == nil || byCode.Email != email {
		t.Fatalf("loadByCode = (%v,%v)", byCode, err)
	}

	// Upsert with approval round-trips approved_by/approver_info.
	e.ApprovedBy = "admin@example.com"
	e.ApproverInfo = "admin@example.com (admin)"
	if err := dbUpsertPendingPair(e); err != nil {
		t.Fatal(err)
	}
	reload, _ := dbLoadPendingPairByEmail(email)
	if reload.ApprovedBy != "admin@example.com" || reload.ApproverInfo != "admin@example.com (admin)" {
		t.Errorf("approval not persisted: %+v", reload)
	}

	// List includes it.
	list, err := dbListPendingPairs()
	if err != nil {
		t.Fatal(err)
	}
	var seen bool
	for _, p := range list {
		if p.Email == email {
			seen = true
		}
	}
	if !seen {
		t.Error("pending pair not in list")
	}

	// Delete removes it.
	if err := dbDeletePendingPairByEmail(email); err != nil {
		t.Fatal(err)
	}
	if got, _ := dbLoadPendingPairByEmail(email); got != nil {
		t.Error("pending pair still present after delete")
	}
}

func TestStorePendingPairs_PurgeExpired(t *testing.T) {
	email := "ppexpired@example.com"
	past := time.Now().Add(-10 * time.Minute)
	e := &pairingEntry{
		Email:     email,
		Code:      "111111",
		IssuedAt:  past,
		ExpiresAt: past.Add(time.Minute), // still in the past
	}
	if err := dbUpsertPendingPair(e); err != nil {
		t.Fatal(err)
	}
	if err := dbPurgeExpiredPendingPairs(); err != nil {
		t.Fatal(err)
	}
	if got, _ := dbLoadPendingPairByEmail(email); got != nil {
		t.Error("expired pending pair was not purged")
	}
}

func TestStorePendingPairs_LoadMissing(t *testing.T) {
	// scanPendingPair returns (nil,nil) for a missing row.
	if got, err := dbLoadPendingPairByEmail("nobody-pp@example.com"); got != nil || err != nil {
		t.Errorf("missing load = (%v,%v)", got, err)
	}
	if got, err := dbLoadPendingPairByCode("000000-none"); got != nil || err != nil {
		t.Errorf("missing code load = (%v,%v)", got, err)
	}
}

func TestStore_ProtectedRouteCRUD(t *testing.T) {
	host := "route-test.example.com"
	if err := saveProtectedRoute(host, "http://10.0.0.1:9000"); err != nil {
		t.Fatal(err)
	}
	up, err := lookupProtectedRouteUpstream(host)
	if err != nil || up != "http://10.0.0.1:9000" {
		t.Fatalf("lookup = (%q,%v)", up, err)
	}
	// Replace upstream.
	if err := saveProtectedRoute(host, "http://10.0.0.2:9000"); err != nil {
		t.Fatal(err)
	}
	up2, _ := lookupProtectedRouteUpstream(host)
	if up2 != "http://10.0.0.2:9000" {
		t.Errorf("upstream after replace = %q", up2)
	}
	if err := deleteProtectedRoute(host); err != nil {
		t.Fatal(err)
	}
	if up3, _ := lookupProtectedRouteUpstream(host); up3 != "" {
		t.Errorf("upstream after delete = %q, want empty", up3)
	}
}

func TestStore_NowRFC3339Parses(t *testing.T) {
	if _, err := time.Parse(time.RFC3339, nowRFC3339()); err != nil {
		t.Errorf("nowRFC3339 not RFC3339: %v", err)
	}
}
