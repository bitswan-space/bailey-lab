package daemon

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The throttle's wire contract: what a refused or failed 2FA attempt actually
// sends back. The SPA drives its warning off failed_attempts and its countdown
// off retry_after, and clients honour Retry-After, so these are behavioural
// assertions rather than coverage filler.

func decodeThrottleBody(t *testing.T, body string) map[string]any {
	t.Helper()
	var got map[string]any
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("response is not JSON (%v): %s", err, body)
	}
	return got
}

func TestGateThrottlePrecheck_PassesWhenClear(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	clearThrottle()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/bailey/api/self-trust", nil)
	r.RemoteAddr = "198.51.100.4:1111"
	ip, ok := mfaGateThrottlePrecheck(w, r, "clear@x")
	if !ok {
		t.Fatal("a caller with no failures must not be pre-rejected")
	}
	if ip != "198.51.100.4" {
		t.Fatalf("resolved ip = %q, want the peer", ip)
	}
}

func TestGateThrottlePrecheck_RejectsWhenLocked(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	clearThrottle()
	email, ip := "locked@x", "198.51.100.5"
	for i := 0; i < mfaMaxFails; i++ {
		mfaThrottleBegin(email, ip)
	}

	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/bailey/api/self-trust", nil)
	r.RemoteAddr = ip + ":2222"
	if _, ok := mfaGateThrottlePrecheck(w, r, email); ok {
		t.Fatal("a locked caller must be pre-rejected")
	}
	if w.Code != 429 {
		t.Fatalf("status = %d, want 429", w.Code)
	}
	if w.Header().Get("Retry-After") == "" {
		t.Fatal("a 429 must carry Retry-After")
	}
	body := decodeThrottleBody(t, w.Body.String())
	if body["retry_after"].(float64) <= 0 {
		t.Fatalf("retry_after = %v, want > 0", body["retry_after"])
	}
	// Regression: the count must still be reported while locked, or the SPA's
	// "> 3 failures" indicator disappears exactly when it's warranted.
	if got := body["failed_attempts"].(float64); got < mfaMaxFails {
		t.Fatalf("failed_attempts = %v, want >= %d while locked", got, mfaMaxFails)
	}
	// The wording must not disclose WHICH key is throttled.
	msg, _ := body["error"].(string)
	if strings.Contains(strings.ToLower(msg), "account") || strings.Contains(msg, ip) {
		t.Fatalf("cooldown message leaks which key is throttled: %q", msg)
	}
}

func TestGateThrottleReject_Writes429(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	clearThrottle()
	w := httptest.NewRecorder()
	mfaGateThrottleReject(w, "rej@x", "198.51.100.6", "self-trust", 7, 19)
	if w.Code != 429 {
		t.Fatalf("status = %d, want 429", w.Code)
	}
	if got := w.Header().Get("Retry-After"); got != "19" {
		t.Fatalf("Retry-After = %q, want 19", got)
	}
	body := decodeThrottleBody(t, w.Body.String())
	if body["failed_attempts"].(float64) != 7 || body["retry_after"].(float64) != 19 {
		t.Fatalf("body did not carry the counters: %v", body)
	}
}

// A failure that has NOT tripped the cooldown keeps the handler's own 401 and
// its specific message, so the user is told the code was wrong rather than that
// they're rate-limited.
func TestGateThrottleFail_UnlockedKeeps401(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	clearThrottle()
	w := httptest.NewRecorder()
	mfaGateThrottleFail(w, "f@x", "198.51.100.7", "self-trust", "that code didn't match", 2, 0)
	if w.Code != 401 {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	if w.Header().Get("Retry-After") != "" {
		t.Fatal("Retry-After must only appear once a cooldown is active")
	}
	body := decodeThrottleBody(t, w.Body.String())
	if body["error"] != "that code didn't match" {
		t.Fatalf("error = %v, want the handler's message", body["error"])
	}
	if body["failed_attempts"].(float64) != 2 {
		t.Fatalf("failed_attempts = %v, want 2", body["failed_attempts"])
	}
}

// Once the attempt trips the cooldown the status escalates to 429 and the
// message switches to the cooldown wording.
func TestGateThrottleFail_LockedBecomes429(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	clearThrottle()
	w := httptest.NewRecorder()
	mfaGateThrottleFail(w, "f2@x", "198.51.100.8", "totp-verify", "that code didn't match", mfaMaxFails, 25)
	if w.Code != 429 {
		t.Fatalf("status = %d, want 429", w.Code)
	}
	if got := w.Header().Get("Retry-After"); got != "25" {
		t.Fatalf("Retry-After = %q, want 25", got)
	}
	if body := decodeThrottleBody(t, w.Body.String()); body["error"] != mfaThrottledMessage {
		t.Fatalf("error = %v, want the cooldown wording", body["error"])
	}
}

// The server-rendered paths answer with HTML so the user keeps their form; the
// helper writes status/headers and hands back the message to render.
func TestHTMLThrottleReject(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	clearThrottle()
	w := httptest.NewRecorder()
	msg := mfaHTMLThrottleReject(w, "h@x", "198.51.100.9", "totp-challenge", 12)
	if w.Code != 429 {
		t.Fatalf("status = %d, want 429", w.Code)
	}
	if got := w.Header().Get("Retry-After"); got != "12" {
		t.Fatalf("Retry-After = %q, want 12", got)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("Content-Type = %q, want text/html", ct)
	}
	if msg != mfaThrottledMessage {
		t.Fatalf("message = %q, want the cooldown wording", msg)
	}
}

func TestHTMLThrottleFail_UnlockedKeepsMessage(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	clearThrottle()
	w := httptest.NewRecorder()
	msg := mfaHTMLThrottleFail(w, "h2@x", "198.51.100.10", "totp-challenge", "Code didn't match — try again.", 0)
	if w.Code != 401 {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	if msg != "Code didn't match — try again." {
		t.Fatalf("message = %q, want the handler's own wording", msg)
	}
}

func TestHTMLThrottleFail_LockedSwitchesMessage(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	clearThrottle()
	w := httptest.NewRecorder()
	msg := mfaHTMLThrottleFail(w, "h3@x", "198.51.100.11", "totp-challenge", "Code didn't match — try again.", 30)
	if w.Code != 429 {
		t.Fatalf("status = %d, want 429", w.Code)
	}
	if msg != mfaThrottledMessage {
		t.Fatalf("message = %q, want the cooldown wording once locked", msg)
	}
}

// mfaLockoutFor is defensive about a zero/negative lockCount so a future caller
// can't accidentally produce a zero-length cooldown.
func TestLockoutFor_ClampsLowCounts(t *testing.T) {
	if got := mfaLockoutFor(0); got != mfaLockoutBase {
		t.Fatalf("mfaLockoutFor(0) = %v, want %v", got, mfaLockoutBase)
	}
	if got := mfaLockoutFor(-3); got != mfaLockoutBase {
		t.Fatalf("mfaLockoutFor(-3) = %v, want %v", got, mfaLockoutBase)
	}
	if got := mfaLockoutFor(2); got != 2*mfaLockoutBase {
		t.Fatalf("mfaLockoutFor(2) = %v, want %v", got, 2*mfaLockoutBase)
	}
}

// The sweep bounds the map: idle keys are evicted, but a key whose cooldown is
// still running must survive even if it has been idle longer than the window.
func TestThrottleSweep_EvictsIdleKeepsLocked(t *testing.T) {
	clearThrottle()
	now := time.Now()
	mfaThrottleMu.Lock()
	mfaAttempts["acct:idle@x"] = &mfaAttempt{fails: 2, lastFail: now.Add(-2 * mfaFailWindow)}
	mfaAttempts["acct:locked@x"] = &mfaAttempt{
		fails:       mfaMaxFails,
		lastFail:    now.Add(-2 * mfaFailWindow),
		lockedUntil: now.Add(mfaLockoutMax),
	}
	mfaThrottleSweepLocked(now)
	_, idleKept := mfaAttempts["acct:idle@x"]
	_, lockedKept := mfaAttempts["acct:locked@x"]
	mfaThrottleMu.Unlock()

	if idleKept {
		t.Error("an idle key past the fail window should be evicted")
	}
	if !lockedKept {
		t.Error("a key with a live cooldown must survive the sweep")
	}
}

// A trusted-hop count larger than the actual chain must fall back to the peer
// rather than believing a caller-supplied entry.
func TestClientIPForRequest_ChainShorterThanTrustedHops(t *testing.T) {
	t.Setenv("BITSWAN_TRUSTED_PROXY_HOPS", "3")
	r := httptest.NewRequest("POST", "/x", nil)
	r.RemoteAddr = "198.51.100.12:3333"
	r.Header.Set("X-Forwarded-For", "203.0.113.9")
	if got := clientIPForRequest(r); got != "198.51.100.12" {
		t.Fatalf("client ip = %q, want peer fallback when the chain is shorter than the trusted hop count", got)
	}
}

func TestTrustedProxyHops_IgnoresGarbage(t *testing.T) {
	t.Setenv("BITSWAN_TRUSTED_PROXY_HOPS", "not-a-number")
	if got := mfaTrustedProxyHops(); got != 0 {
		t.Fatalf("hops = %d, want 0 for unparseable config", got)
	}
	t.Setenv("BITSWAN_TRUSTED_PROXY_HOPS", "-2")
	if got := mfaTrustedProxyHops(); got != 0 {
		t.Fatalf("hops = %d, want 0 for a negative count", got)
	}
}
