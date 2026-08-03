package daemon

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
)

// Regression guards for bailey-lab#278: "I still see 'New device waiting to be
// linked' even after verifying that device with authenticator app."
//
// Root cause: only the poll path cleared the pending_pairs row
// (claimPendingPair). The self-trust / recovery paths minted device trust and
// walked away, so the pending row survived and every view built on
// visiblePendingRequests kept rendering a link prompt for a device that was
// already linked — the /devices panel, the People & roles badge/banner/inline
// row, and the overview count.

// TestSelfTrustViaAuthenticatorClearsPendingPair is the primary guard: the
// authenticator self-trust handler must leave NO pending request behind.
func TestSelfTrustViaAuthenticatorClearsPendingPair(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	reopenBaileyDBForTest(t)
	t.Cleanup(func() { reopenBaileyDBForTest(t) })

	const email = "selftrust278@example.com"
	secret := enrolTOTP(t, email)

	// The new browser hits the gate, which mints its pairing code.
	if _, err := generatePendingPairUA(email, "Mozilla/5.0 (X11; Linux x86_64) Chrome/128.0"); err != nil {
		t.Fatalf("generate pending pair: %v", err)
	}
	if got := len(visiblePendingRequests("", true)); got != 1 {
		t.Fatalf("pending requests before self-trust = %d, want 1 (test setup)", got)
	}

	// …then self-trusts with its authenticator instead of asking an admin.
	code, _ := totp.GenerateCode(secret, time.Now())
	w := httptest.NewRecorder()
	selfTrustHandler(w, pairReq(http.MethodPost, mfaGatePathPrefix+"/self-trust", email, "code="+code), email)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("self-trust = %d, want 303; body=%s", w.Code, w.Body.String())
	}

	// The row itself must be gone — not merely filtered out of one view.
	e, err := dbLoadPendingPairByEmail(email)
	if err != nil {
		t.Fatalf("load pending pair: %v", err)
	}
	if e != nil {
		t.Errorf("pending_pairs row survived authenticator self-trust (code %q) — the stale "+
			"\"New device waiting to be linked\" prompt of #278", e.Code)
	}
	// …and therefore no surface renders a request: the /devices panel and the
	// People & roles banner/badge/row, the admin approvals page, and the
	// overview count all read through here.
	if got := len(visiblePendingRequests(email, false)); got != 0 {
		t.Errorf("own pending requests after self-trust = %d, want 0", got)
	}
	if got := len(visiblePendingRequests("", true)); got != 0 {
		t.Errorf("admin-visible pending requests after self-trust = %d, want 0", got)
	}
}

// TestRecoveryClearsPendingPair covers the other two paths that trust a device
// without going through the approval poll: authenticator recovery and a
// single-use backup code.
func TestRecoveryClearsPendingPair(t *testing.T) {
	for _, tc := range []struct {
		name  string
		email string
		form  func(t *testing.T, email string) string
	}{
		{
			name:  "authenticator recovery",
			email: "recovtotp278@example.com",
			form: func(t *testing.T, email string) string {
				secret := enrolTOTP(t, email)
				code, _ := totp.GenerateCode(secret, time.Now())
				return "mode=totp&code=" + code
			},
		},
		{
			name:  "backup code",
			email: "recovbackup278@example.com",
			form: func(t *testing.T, email string) string {
				codes, err := generateBackupCodes()
				if err != nil {
					t.Fatalf("generate backup codes: %v", err)
				}
				if err := dbSaveBackupCodes(email, codes); err != nil {
					t.Fatalf("save backup codes: %v", err)
				}
				return "mode=backup&backup=" + codes[0]
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			t.Setenv("SUDO_USER", "")
			reopenBaileyDBForTest(t)
			t.Cleanup(func() { reopenBaileyDBForTest(t) })

			form := tc.form(t, tc.email)
			if _, err := generatePendingPairUA(tc.email, "Chrome/128.0"); err != nil {
				t.Fatalf("generate pending pair: %v", err)
			}

			w := httptest.NewRecorder()
			recoveryHandler(w, pairReq(http.MethodPost, mfaGatePathPrefix+"/recovery", tc.email, form), tc.email)
			if w.Code != http.StatusSeeOther {
				t.Fatalf("recovery = %d, want 303; body=%s", w.Code, w.Body.String())
			}

			e, err := dbLoadPendingPairByEmail(tc.email)
			if err != nil {
				t.Fatalf("load pending pair: %v", err)
			}
			if e != nil {
				t.Errorf("pending_pairs row survived recovery via %s", tc.name)
			}
		})
	}
}

// TestVisiblePendingRequestsSkipsAlreadyTrustedDevice covers the defence in
// depth. A row stranded by an older build (or by any path that trusts a device
// without clearing it) must not be rendered once the account holds a device
// trusted after the request was issued — that's what un-sticks the banner in
// deployments that already have a stray row.
func TestVisiblePendingRequestsSkipsAlreadyTrustedDevice(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	reopenBaileyDBForTest(t)
	t.Cleanup(func() { reopenBaileyDBForTest(t) })

	const email = "stranded278@example.com"

	e, err := generatePendingPairUA(email, "Chrome/128.0")
	if err != nil {
		t.Fatalf("generate pending pair: %v", err)
	}
	// Age the request a couple of minutes (still live — pairingTTL is 5) so the
	// device below is unambiguously trusted AFTER it was issued, which is the
	// shape of a stranded row.
	e.IssuedAt = time.Now().Add(-2 * time.Minute)
	if err := dbUpsertPendingPair(e); err != nil {
		t.Fatalf("age pending pair: %v", err)
	}
	if got := len(visiblePendingRequests("", true)); got != 1 {
		t.Fatalf("pending requests = %d, want 1 (test setup)", got)
	}

	// Trust a device the way an old build's self-trust did, then put the stray
	// row back — addDeviceWithOrigin now clears it, and we're testing the
	// filter, not the delete.
	if _, err := addDevice(email, "Chrome on Linux · approved by self via authenticator"); err != nil {
		t.Fatalf("add device: %v", err)
	}
	if err := dbUpsertPendingPair(e); err != nil {
		t.Fatalf("re-strand pending pair: %v", err)
	}
	if got, err := dbLoadPendingPairByEmail(email); err != nil || got == nil {
		t.Fatalf("stray row not re-inserted (err=%v)", err)
	}

	if got := len(visiblePendingRequests("", true)); got != 0 {
		t.Errorf("admin-visible pending requests = %d, want 0 — a stranded row is still "+
			"prompting for a code for an already-trusted device", got)
	}
	if got := len(visiblePendingRequests(email, false)); got != 0 {
		t.Errorf("own pending requests = %d, want 0", got)
	}
}

// TestVisiblePendingRequestsKeepsRequestFromNewBrowser is the counter-test:
// the staleness filter must not hide a genuine request just because the account
// already has trusted devices. A user with a laptop already linked who signs in
// on a phone still needs that phone's code shown.
func TestVisiblePendingRequestsKeepsRequestFromNewBrowser(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	reopenBaileyDBForTest(t)
	t.Cleanup(func() { reopenBaileyDBForTest(t) })

	const email = "twodevices278@example.com"

	// An existing trusted device, paired well before the new request.
	rec, err := addDevice(email, "Chrome on Linux")
	if err != nil {
		t.Fatalf("add device: %v", err)
	}
	backdateDevice(t, email, rec.ID, time.Now().Add(-48*time.Hour))

	if _, err := generatePendingPairUA(email, "Mozilla/5.0 (iPhone) Safari/605"); err != nil {
		t.Fatalf("generate pending pair: %v", err)
	}
	if got := len(visiblePendingRequests("", true)); got != 1 {
		t.Errorf("admin-visible pending requests = %d, want 1 — a real request from a new "+
			"browser was filtered out because the account already has a trusted device", got)
	}
	if got := len(visiblePendingRequests(email, false)); got != 1 {
		t.Errorf("own pending requests = %d, want 1", got)
	}
}

// backdateDevice rewrites a device row's paired_at so a test can place an
// existing trusted device clearly before a later pending request (paired_at is
// second-granularity, so "now" for both is indistinguishable).
func backdateDevice(t *testing.T, email, id string, at time.Time) {
	t.Helper()
	db, err := openBaileyDB()
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if _, err := db.Exec(`UPDATE devices SET paired_at = ? WHERE email = ? COLLATE NOCASE AND id = ?`,
		at.UTC().Format(time.RFC3339), email, id); err != nil {
		t.Fatalf("backdate paired_at: %v", err)
	}
}
