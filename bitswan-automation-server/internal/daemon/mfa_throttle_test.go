package daemon

import (
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"
)

func clearThrottle() {
	mfaThrottleMu.Lock()
	mfaAttempts = map[string]*mfaAttempt{}
	mfaThrottleMu.Unlock()
}

// expireLockouts fast-forwards every armed cooldown into the past without
// sleeping, leaving lastFail recent so the idle decay does NOT also fire.
func expireLockouts() {
	mfaThrottleMu.Lock()
	for _, a := range mfaAttempts {
		a.lockedUntil = time.Now().Add(-time.Second)
		a.lastFail = time.Now()
	}
	mfaThrottleMu.Unlock()
}

// Attempts below the cap are allowed and raise the count (for the
// > mfaWarnThreshold indicator); the mfaMaxFails-th is still honoured but arms
// the cooldown, and the one after it is refused outright.
func TestMFAThrottle_LocksAfterMaxFails(t *testing.T) {
	clearThrottle()
	email, ip := "a@x", "10.0.0.1"
	for i := 1; i < mfaMaxFails; i++ {
		fails, retry, ok := mfaThrottleBegin(email, ip)
		if !ok {
			t.Fatalf("refused early at attempt %d", i)
		}
		if retry != 0 {
			t.Fatalf("locked early at attempt %d (retry=%d)", i, retry)
		}
		if fails != i {
			t.Fatalf("fail count = %d, want %d", fails, i)
		}
	}
	// The pre-lockout count must exceed the warn threshold so the SPA shows the
	// visual indicator before the user is locked out.
	if _, warn := mfaThrottleState(email, ip); warn <= mfaWarnThreshold {
		t.Fatalf("fail count %d should exceed warn threshold %d", warn, mfaWarnThreshold)
	}
	fails, retry, ok := mfaThrottleBegin(email, ip)
	if !ok {
		t.Fatal("the mfaMaxFails-th attempt should still be honoured")
	}
	if retry <= 0 {
		t.Fatal("expected a cooldown once mfaMaxFails is reached")
	}
	// Regression: the fail count must NOT be zeroed when the lockout arms, or
	// the response and gate-state report "0 failed attempts" while locked and
	// the indicator disappears exactly when it matters.
	if fails < mfaMaxFails {
		t.Fatalf("fail count at lockout = %d, want >= %d", fails, mfaMaxFails)
	}
	if _, _, ok := mfaThrottleBegin(email, ip); ok {
		t.Fatal("attempts after the cooldown arms must be refused")
	}
}

// The security property from #188: check-and-reserve is atomic, so concurrent
// requests cannot all slip past a clear counter. Without atomicity the limit
// degrades to the caller's concurrency.
func TestMFAThrottle_ConcurrentAttemptsBounded(t *testing.T) {
	clearThrottle()
	email, ip := "race@x", "10.0.0.9"
	const goroutines = 200

	var wg sync.WaitGroup
	var mu sync.Mutex
	allowed := 0
	start := make(chan struct{})
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start // maximise overlap
			if _, _, ok := mfaThrottleBegin(email, ip); ok {
				mu.Lock()
				allowed++
				mu.Unlock()
			}
		}()
	}
	close(start)
	wg.Wait()

	if allowed != mfaMaxFails {
		t.Fatalf("%d of %d concurrent attempts were allowed, want exactly %d",
			allowed, goroutines, mfaMaxFails)
	}
}

// #188 asks for exponential backoff: each consecutive lockout must last longer
// than the last, so a fixed guess rate can't be sustained indefinitely.
func TestMFAThrottle_LockoutEscalates(t *testing.T) {
	clearThrottle()
	email, ip := "esc@x", "10.0.0.2"
	burn := func() int {
		var retry int
		for i := 0; i < mfaMaxFails; i++ {
			_, r, ok := mfaThrottleBegin(email, ip)
			if !ok {
				t.Fatalf("refused mid-burst at attempt %d", i)
			}
			retry = r
		}
		return retry
	}
	first := burn()
	if first <= 0 {
		t.Fatal("first burst should arm a cooldown")
	}
	expireLockouts()
	second := burn()
	if second <= first {
		t.Fatalf("second cooldown = %ds, want longer than the first (%ds)", second, first)
	}
	expireLockouts()
	if third := burn(); third <= second {
		t.Fatalf("third cooldown = %ds, want longer than the second (%ds)", third, second)
	}
}

func TestMFAThrottle_LockoutCap(t *testing.T) {
	if got := mfaLockoutFor(99); got != mfaLockoutMax {
		t.Fatalf("escalation should cap at %v, got %v", mfaLockoutMax, got)
	}
	if got := mfaLockoutFor(1); got != mfaLockoutBase {
		t.Fatalf("first lockout = %v, want %v", got, mfaLockoutBase)
	}
}

// A cooldown on the ACCOUNT key applies from any IP (per-account limit).
func TestMFAThrottle_PerAccountAcrossIPs(t *testing.T) {
	clearThrottle()
	email := "b@x"
	for i := 0; i < mfaMaxFails; i++ {
		mfaThrottleBegin(email, "1.1.1."+strconv.Itoa(i))
	}
	if _, retry, ok := mfaThrottleBegin(email, "2.2.2.2"); ok || retry <= 0 {
		t.Fatal("account should stay locked from a fresh IP")
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
		mfaThrottleBegin("u"+strconv.Itoa(i)+"@x", ip)
	}
	if r, _ := mfaThrottleState("brand-new@x", ip); r <= 0 {
		t.Fatal("IP lockout must apply to any account from that IP")
	}
	if _, _, ok := mfaThrottleBegin("brand-new@x", ip); ok {
		t.Fatal("a fresh account from a locked IP must be refused")
	}
}

func TestMFAThrottle_ResetOnSuccess(t *testing.T) {
	clearThrottle()
	email, ip := "c@x", "5.5.5.5"
	mfaThrottleBegin(email, ip)
	mfaThrottleBegin(email, ip)
	mfaThrottleReset(email, ip)
	if _, f := mfaThrottleState(email, ip); f != 0 {
		t.Fatalf("reset should clear the fail count, got %d", f)
	}
	// A success also clears the escalation, so a fumbling user starts fresh.
	for i := 0; i < mfaMaxFails; i++ {
		mfaThrottleBegin(email, ip)
	}
	mfaThrottleReset(email, ip)
	expireLockouts()
	if _, retry, ok := mfaThrottleBegin(email, ip); !ok || retry != 0 {
		t.Fatalf("after a success the next burst should start clean (ok=%v retry=%d)", ok, retry)
	}
}

func TestMFAThrottle_CooldownExpires(t *testing.T) {
	clearThrottle()
	email, ip := "d@x", "6.6.6.6"
	for i := 0; i < mfaMaxFails; i++ {
		mfaThrottleBegin(email, ip)
	}
	if r, _ := mfaThrottleState(email, ip); r <= 0 {
		t.Fatal("should be locked")
	}
	expireLockouts()
	if r, _ := mfaThrottleState(email, ip); r != 0 {
		t.Fatalf("cooldown should have expired, still %ds", r)
	}
	if _, _, ok := mfaThrottleBegin(email, ip); !ok {
		t.Fatal("attempts should be allowed again once the cooldown lapses")
	}
}

// An idle key decays so a user who failed once last week isn't part-way to a
// lockout today.
func TestMFAThrottle_IdleDecay(t *testing.T) {
	clearThrottle()
	email, ip := "idle@x", "7.7.7.7"
	for i := 0; i < mfaMaxFails-1; i++ {
		mfaThrottleBegin(email, ip)
	}
	mfaThrottleMu.Lock()
	for _, a := range mfaAttempts {
		a.lastFail = time.Now().Add(-2 * mfaFailWindow)
	}
	mfaThrottleMu.Unlock()
	if _, f := mfaThrottleState(email, ip); f != 0 {
		t.Fatalf("idle counters should decay, still %d", f)
	}
	if fails, _, ok := mfaThrottleBegin(email, ip); !ok || fails != 1 {
		t.Fatalf("after decay the next failure is the first again (ok=%v fails=%d)", ok, fails)
	}
}

// X-Forwarded-For is client-settable and proxies APPEND to it, so the leftmost
// entry is attacker-controlled. By default we must ignore XFF entirely and key
// on the real peer; only an explicit trusted-hop count may consult it, counting
// from the right.
func TestClientIPForRequest_IgnoresUntrustedXFF(t *testing.T) {
	r := httptest.NewRequest("POST", "/x", nil)
	r.RemoteAddr = "192.0.2.5:4444"
	r.Header.Set("X-Forwarded-For", "203.0.113.7, 10.0.0.1")
	if got := clientIPForRequest(r); got != "192.0.2.5" {
		t.Fatalf("client ip = %q, want the peer 192.0.2.5 — a spoofable XFF hop must not key the limiter", got)
	}
}

func TestClientIPForRequest_TrustedHops(t *testing.T) {
	t.Setenv("BITSWAN_TRUSTED_PROXY_HOPS", "1")
	r := httptest.NewRequest("POST", "/x", nil)
	r.RemoteAddr = "192.0.2.5:4444"
	// One trusted proxy appended "10.0.0.1"; "203.0.113.7" is caller-supplied.
	r.Header.Set("X-Forwarded-For", "203.0.113.7, 10.0.0.1")
	if got := clientIPForRequest(r); got != "10.0.0.1" {
		t.Fatalf("client ip = %q, want the rightmost trusted hop 10.0.0.1", got)
	}

	// A chain shorter than the configured hop count falls back to the peer
	// rather than believing a caller-supplied value.
	r2 := httptest.NewRequest("POST", "/x", nil)
	r2.RemoteAddr = "192.0.2.6:5555"
	r2.Header.Set("X-Forwarded-For", "")
	if got := clientIPForRequest(r2); got != "192.0.2.6" {
		t.Fatalf("client ip = %q, want peer fallback 192.0.2.6", got)
	}
}

func TestClientIPForRequest_NoXFFUsesPeer(t *testing.T) {
	r := httptest.NewRequest("POST", "/x", nil)
	r.RemoteAddr = "192.0.2.5:4444"
	if got := clientIPForRequest(r); got != "192.0.2.5" {
		t.Fatalf("RemoteAddr ip = %q, want host without port", got)
	}
}
