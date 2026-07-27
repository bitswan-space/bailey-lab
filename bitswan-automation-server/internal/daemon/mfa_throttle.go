package daemon

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Second-factor brute-force throttle (issue #188 / BSY-12).
//
// TOTP verification, backup-code consumption and recovery all check a small
// 6-digit space, so an unthrottled endpoint is online-brute-forceable. We keep
// a per-ACCOUNT and per-IP failed-attempt counter and, every mfaMaxFails
// failures on EITHER key, impose a cooldown on that key — blocking further
// attempts from that account or that address regardless of the other. Counters
// live in-memory in the single daemon process (the 2FA gate is served
// in-process); they reset on a successful verification and decay after
// mfaFailWindow of inactivity. Every failure is mirrored to the SIEM via
// recordEvent, and the current fail count is surfaced to the SPA so it can warn
// the user past mfaWarnThreshold.
//
// Two properties are load-bearing and easy to regress:
//
//  1. CHECK AND RESERVE ARE ATOMIC. mfaThrottleBegin consumes an attempt slot
//     in the SAME critical section that tests the cooldown. A read-only check
//     followed by a later increment (around the code comparison) would let any
//     number of concurrent requests all observe a clear counter and all proceed
//     — making the effective limit the caller's concurrency rather than
//     mfaMaxFails. Callers MUST reserve via mfaThrottleBegin before comparing a
//     code, not merely pre-check.
//
//  2. THE COOLDOWN ESCALATES. #188 asks for exponential backoff: a fixed
//     cooldown that re-arms identically leaves a permanent steady-state guess
//     rate (mfaMaxFails per cooldown, indefinitely). lockCount survives each
//     lockout so the next one is longer; only a success or a full idle window
//     clears it.
const (
	mfaMaxFails      = 5                // failures on a key before a cooldown engages
	mfaLockoutBase   = 25 * time.Second // first cooldown; doubles per consecutive lockout
	mfaLockoutMax    = 15 * time.Minute // ceiling for the escalating cooldown
	mfaFailWindow    = 15 * time.Minute // a key's counters decay after this idle time
	mfaWarnThreshold = 3                // > this many fails → the SPA shows a visual indicator
)

type mfaAttempt struct {
	fails       int       // failures since the last success / idle decay (monotonic; drives the indicator)
	lockCount   int       // consecutive cooldowns on this key; escalates the next duration
	lastFail    time.Time // for idle decay
	lockedUntil time.Time
}

var (
	mfaThrottleMu sync.Mutex
	mfaAttempts   = map[string]*mfaAttempt{}
)

// mfaLockoutFor returns the cooldown for the nth consecutive lockout on a key:
// mfaLockoutBase doubled per prior lockout, capped at mfaLockoutMax.
func mfaLockoutFor(lockCount int) time.Duration {
	if lockCount < 1 {
		lockCount = 1
	}
	d := mfaLockoutBase
	for i := 1; i < lockCount && d < mfaLockoutMax; i++ {
		d *= 2
	}
	if d > mfaLockoutMax {
		d = mfaLockoutMax
	}
	return d
}

// mfaThrottleKeys returns the per-account and per-IP keys to rate-limit a
// request under. Either may be empty (no identity / no address), in which case
// it's skipped — we never collapse distinct principals onto one bucket.
func mfaThrottleKeys(email, ip string) []string {
	keys := make([]string, 0, 2)
	if e := strings.ToLower(strings.TrimSpace(email)); e != "" {
		keys = append(keys, "acct:"+e)
	}
	if ip != "" {
		keys = append(keys, "ip:"+ip)
	}
	return keys
}

// mfaAttemptLocked fetches a key's record, applying idle decay. An ACTIVE
// cooldown is never decayed away (an escalated lockout can outlive
// mfaFailWindow). Caller holds mfaThrottleMu.
func mfaAttemptLocked(key string, now time.Time) *mfaAttempt {
	a := mfaAttempts[key]
	if a == nil {
		a = &mfaAttempt{}
		mfaAttempts[key] = a
	}
	if !a.lockedUntil.After(now) && !a.lastFail.IsZero() && now.Sub(a.lastFail) > mfaFailWindow {
		a.fails, a.lockCount = 0, 0
	}
	return a
}

// mfaThrottleState reports the current cooldown (seconds remaining, 0 if none)
// and the highest live fail count across the request's account/IP keys — the
// latter drives the SPA's "> 3 failed attempts" indicator. Read-only: it never
// creates or mutates a record, so it is safe for gate-state.
func mfaThrottleState(email, ip string) (retryAfter, fails int) {
	now := time.Now()
	mfaThrottleMu.Lock()
	defer mfaThrottleMu.Unlock()
	for _, k := range mfaThrottleKeys(email, ip) {
		a := mfaAttempts[k]
		if a == nil {
			continue
		}
		if a.lockedUntil.After(now) {
			if s := int(a.lockedUntil.Sub(now).Seconds()) + 1; s > retryAfter {
				retryAfter = s
			}
		} else if !a.lastFail.IsZero() && now.Sub(a.lastFail) > mfaFailWindow {
			continue // decayed; report nothing
		}
		if a.fails > fails {
			fails = a.fails
		}
	}
	return
}

// mfaThrottleBegin atomically tests the cooldown and consumes one attempt slot.
// It is THE security boundary for #188 — see property (1) in the file comment.
//
// ok=false means the caller is in cooldown and MUST NOT compare a code;
// retryAfter carries the remaining seconds. ok=true means one attempt was
// counted against both keys: the caller should compare the code, then call
// mfaThrottleReset on success or mfaGateThrottleFail on failure. When the
// consumed attempt is itself the one that trips mfaMaxFails, ok stays true (this
// attempt is honoured) and retryAfter reports the cooldown now blocking the next.
func mfaThrottleBegin(email, ip string) (fails, retryAfter int, ok bool) {
	now := time.Now()
	mfaThrottleMu.Lock()
	defer mfaThrottleMu.Unlock()

	// Test every key BEFORE consuming anything, so a locked key can't be
	// charged an attempt it was never allowed to make.
	for _, k := range mfaThrottleKeys(email, ip) {
		a := mfaAttemptLocked(k, now)
		if a.lockedUntil.After(now) {
			if s := int(a.lockedUntil.Sub(now).Seconds()) + 1; s > retryAfter {
				retryAfter = s
			}
			if a.fails > fails {
				fails = a.fails
			}
		}
	}
	if retryAfter > 0 {
		return fails, retryAfter, false
	}

	for _, k := range mfaThrottleKeys(email, ip) {
		a := mfaAttemptLocked(k, now)
		a.fails++
		a.lastFail = now
		// Arm (or re-arm, longer) every mfaMaxFails-th failure. fails is NOT
		// zeroed: it keeps driving the indicator and makes the escalation
		// legible.
		if a.fails%mfaMaxFails == 0 {
			a.lockCount++
			a.lockedUntil = now.Add(mfaLockoutFor(a.lockCount))
		}
		if a.fails > fails {
			fails = a.fails
		}
		if a.lockedUntil.After(now) {
			if s := int(a.lockedUntil.Sub(now).Seconds()) + 1; s > retryAfter {
				retryAfter = s
			}
		}
	}
	mfaThrottleSweepLocked(now)
	return fails, retryAfter, true
}

// mfaThrottleReset clears the counters for a request's keys after a successful
// verification, so a legitimate user who fumbled a few codes isn't left throttled.
func mfaThrottleReset(email, ip string) {
	mfaThrottleMu.Lock()
	defer mfaThrottleMu.Unlock()
	for _, k := range mfaThrottleKeys(email, ip) {
		delete(mfaAttempts, k)
	}
}

// mfaThrottleSweepLocked evicts keys whose cooldown has lapsed and whose window
// is idle, bounding the map. Caller holds mfaThrottleMu.
func mfaThrottleSweepLocked(now time.Time) {
	for k, a := range mfaAttempts {
		if !a.lockedUntil.After(now) && !a.lastFail.IsZero() && now.Sub(a.lastFail) > mfaFailWindow {
			delete(mfaAttempts, k)
		}
	}
}

// mfaTrustedProxyHops is how many proxy hops in FRONT of this listener append to
// X-Forwarded-For and may be believed (BITSWAN_TRUSTED_PROXY_HOPS). Default 0:
// trust nothing and use RemoteAddr.
func mfaTrustedProxyHops() int {
	n, err := strconv.Atoi(strings.TrimSpace(os.Getenv("BITSWAN_TRUSTED_PROXY_HOPS")))
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// clientIPForRequest is the originating client address for rate-limiting.
//
// SECURITY: X-Forwarded-For is a request HEADER — any client can set it, and
// proxies APPEND rather than overwrite, so the LEFTMOST entry is whatever the
// caller supplied. Keying a rate limiter on it lets an attacker land in a fresh
// bucket per request. We therefore default to RemoteAddr (the actual peer) and
// only consult XFF when BITSWAN_TRUSTED_PROXY_HOPS says how many trailing hops
// were appended by proxies we control — counting from the RIGHT, never the left.
func clientIPForRequest(r *http.Request) string {
	peer := r.RemoteAddr
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		peer = host
	}
	hops := mfaTrustedProxyHops()
	if hops == 0 {
		return peer
	}
	xff := r.Header.Get("X-Forwarded-For")
	if xff == "" {
		return peer
	}
	parts := strings.Split(xff, ",")
	// The rightmost entry was appended by the nearest trusted proxy; step back
	// one further per additional trusted hop to reach the first address that
	// proxy chain itself observed.
	idx := len(parts) - hops
	if idx < 0 {
		// Fewer entries than trusted hops: the chain is shorter than
		// configured, so nothing here is attacker-controlled — but nothing is
		// usable either. Fall back to the peer.
		return peer
	}
	if candidate := strings.TrimSpace(parts[idx]); candidate != "" {
		return candidate
	}
	return peer
}

// mfaGateThrottlePrecheck is a cheap READ-ONLY reject at the top of a 2FA
// verification handler: if the caller is already in cooldown we answer 429
// without touching the datastore. It does NOT reserve an attempt — the caller
// must still call mfaThrottleBegin before comparing a code (see property (1)).
func mfaGateThrottlePrecheck(w http.ResponseWriter, r *http.Request, email string) (ip string, ok bool) {
	ip = clientIPForRequest(r)
	if retry, fails := mfaThrottleState(email, ip); retry > 0 {
		writeJSONThrottled(w, mfaThrottledMessage, http.StatusTooManyRequests, fails, retry)
		return ip, false
	}
	return ip, true
}

// mfaThrottledMessage is the single user-facing cooldown wording (kept vague on
// purpose: it must not reveal whether the account or the address is throttled).
const mfaThrottledMessage = "Too many attempts — wait a moment before trying again."

// mfaGateThrottleReject answers a JSON verification request that was refused by
// mfaThrottleBegin, recording the blocked attempt for the SIEM.
func mfaGateThrottleReject(w http.ResponseWriter, email, ip, endpoint string, fails, retry int) {
	_ = recordEvent(email, audit2FALockout, endpoint+" ip="+ip+" blocked")
	writeJSONThrottled(w, mfaThrottledMessage, http.StatusTooManyRequests, fails, retry)
}

// mfaGateThrottleFail reports a failed 2FA verification whose attempt was
// already counted by mfaThrottleBegin: it mirrors the failure (and any lockout
// the attempt triggered) to the SIEM and writes the error response carrying the
// fail count + cooldown so the SPA can render the indicator. Status is 429 once
// locked, else the caller's intended 401.
func mfaGateThrottleFail(w http.ResponseWriter, email, ip, endpoint, msg string, fails, retry int) {
	target := endpoint + " ip=" + ip
	_ = recordEvent(email, audit2FAFailed, target)
	status := http.StatusUnauthorized
	if retry > 0 {
		_ = recordEvent(email, audit2FALockout, target)
		status = http.StatusTooManyRequests
		msg = mfaThrottledMessage
	}
	writeJSONThrottled(w, msg, status, fails, retry)
}

// writeJSONThrottled writes a verification-failure body the SPA understands:
// the human message plus failed_attempts (drives the > 3 warning) and
// retry_after seconds (drives the cooldown countdown). Sets Retry-After when
// locked.
func writeJSONThrottled(w http.ResponseWriter, msg string, status, fails, retryAfter int) {
	if retryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error":           msg,
		"failed_attempts": fails,
		"retry_after":     retryAfter,
	})
}

// mfaHTMLThrottled writes the 429 headers/status for a server-rendered (HTML)
// 2FA page; the caller then renders its own form with mfaThrottledMessage so the
// user keeps their context instead of getting a bare error.
func mfaHTMLThrottled(w http.ResponseWriter, retryAfter int) {
	if retryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
	}
	w.Header().Set("Content-Type", "text/html")
	w.WriteHeader(http.StatusTooManyRequests)
}
