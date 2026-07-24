package daemon

import (
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func clearThrottle() {
	mfaThrottleMu.Lock()
	mfaAttempts = map[string]*mfaAttempt{}
	mfaThrottleMu.Unlock()
}

// Failures below the cap raise the count (for the > mfaWarnThreshold indicator)
// without locking; the mfaMaxFails-th failure engages the ~25s cooldown.
func TestMFAThrottle_LocksAfterMaxFails(t *testing.T) {
	clearThrottle()
	email, ip := "a@x", "10.0.0.1"
	for i := 1; i < mfaMaxFails; i++ {
		fails, retry := mfaThrottleFail(email, ip)
		if retry != 0 {
			t.Fatalf("locked early at failure %d (retry=%d)", i, retry)
		}
		if fails != i {
			t.Fatalf("fail count = %d, want %d", fails, i)
		}
	}
	// The (mfaMaxFails-1)th count must exceed the warn threshold so the SPA
	// shows the visual indicator before lockout.
	if _, warn := mfaThrottleState(email, ip); warn <= mfaWarnThreshold {
		t.Fatalf("fail count %d should exceed warn threshold %d", warn, mfaWarnThreshold)
	}
	_, retry := mfaThrottleFail(email, ip)
	if retry <= 0 || retry > int(mfaLockout.Seconds())+1 {
		t.Fatalf("cooldown = %ds, want ~%d", retry, int(mfaLockout.Seconds()))
	}
	if r, _ := mfaThrottleState(email, ip); r <= 0 {
		t.Fatal("expected an active cooldown after mfaMaxFails")
	}
}

// A cooldown on the ACCOUNT key applies from any IP (per-account limit).
func TestMFAThrottle_PerAccountAcrossIPs(t *testing.T) {
	clearThrottle()
	email := "b@x"
	for i := 0; i < mfaMaxFails-1; i++ {
		mfaThrottleFail(email, "1.1.1.1")
	}
	if _, retry := mfaThrottleFail(email, "2.2.2.2"); retry <= 0 {
		t.Fatal("account should lock after mfaMaxFails across different IPs")
	}
	if r, _ := mfaThrottleState(email, "3.3.3.3"); r <= 0 {
		t.Fatal("account lockout must apply from a fresh IP too")
	}
}

// A cooldown on the IP key applies to any account (per-IP limit).
func TestMFAThrottle_PerIPAcrossAccounts(t *testing.T) {
	clearThrottle()
	ip := "9.9.9.9"
	for i := 0; i < mfaMaxFails; i++ {
		mfaThrottleFail("u"+strconv.Itoa(i)+"@x", ip)
	}
	if r, _ := mfaThrottleState("brand-new@x", ip); r <= 0 {
		t.Fatal("IP lockout must apply to any account from that IP")
	}
}

func TestMFAThrottle_ResetOnSuccess(t *testing.T) {
	clearThrottle()
	email, ip := "c@x", "5.5.5.5"
	mfaThrottleFail(email, ip)
	mfaThrottleFail(email, ip)
	mfaThrottleReset(email, ip)
	if _, f := mfaThrottleState(email, ip); f != 0 {
		t.Fatalf("reset should clear the fail count, got %d", f)
	}
}

func TestMFAThrottle_CooldownExpires(t *testing.T) {
	clearThrottle()
	email, ip := "d@x", "6.6.6.6"
	for i := 0; i < mfaMaxFails; i++ {
		mfaThrottleFail(email, ip)
	}
	if r, _ := mfaThrottleState(email, ip); r <= 0 {
		t.Fatal("should be locked")
	}
	// Fast-forward past the cooldown without sleeping.
	mfaThrottleMu.Lock()
	for _, a := range mfaAttempts {
		a.lockedUntil = time.Now().Add(-time.Second)
	}
	mfaThrottleMu.Unlock()
	if r, _ := mfaThrottleState(email, ip); r != 0 {
		t.Fatalf("cooldown should have expired, still %ds", r)
	}
}

func TestClientIPForRequest(t *testing.T) {
	r := httptest.NewRequest("POST", "/x", nil)
	r.Header.Set("X-Forwarded-For", "203.0.113.7, 10.0.0.1")
	if got := clientIPForRequest(r); got != "203.0.113.7" {
		t.Fatalf("XFF client ip = %q, want the leftmost hop", got)
	}
	r2 := httptest.NewRequest("POST", "/x", nil)
	r2.RemoteAddr = "192.0.2.5:4444"
	if got := clientIPForRequest(r2); got != "192.0.2.5" {
		t.Fatalf("RemoteAddr ip = %q, want host without port", got)
	}
}
