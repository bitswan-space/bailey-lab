package daemon

import (
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Second-factor brute-force throttle (issue #188 / BSY-12).
//
// TOTP verification, backup-code consumption and recovery all check a small
// 6-digit space, so an unthrottled endpoint is online-brute-forceable. We keep
// a per-ACCOUNT and per-IP failed-attempt counter and, after mfaMaxFails
// failures on EITHER key, impose a fixed mfaLockout cooldown on that key —
// blocking further attempts from that account or that address regardless of the
// other. Counters live in-memory in the single daemon process (the 2FA gate is
// served in-process); they reset on a successful verification and decay after
// mfaFailWindow of inactivity. Every failure is mirrored to the SIEM via
// recordEvent, and the current fail count is surfaced to the SPA so it can warn
// the user past mfaWarnThreshold.
const (
	mfaMaxFails      = 5                // failures on a key before the cooldown engages
	mfaLockout       = 25 * time.Second // cooldown once mfaMaxFails is hit
	mfaFailWindow    = 15 * time.Minute // a key's fail counter decays after this idle time
	mfaWarnThreshold = 3                // > this many fails → the SPA shows a visual indicator
)

type mfaAttempt struct {
	fails       int
	windowStart time.Time
	lockedUntil time.Time
}

var (
	mfaThrottleMu sync.Mutex
	mfaAttempts   = map[string]*mfaAttempt{}
)

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

// mfaThrottleState reports the current cooldown (seconds remaining, 0 if none)
// and the highest live fail count across the request's account/IP keys — the
// latter drives the SPA's "> 3 failed attempts" indicator. Read-only.
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
		}
		if now.Sub(a.windowStart) <= mfaFailWindow && a.fails > fails {
			fails = a.fails
		}
	}
	return
}

// mfaThrottleFail records one failed verification against BOTH the account and
// IP keys and returns the resulting highest fail count and cooldown seconds
// (0 if not yet locked). Hitting mfaMaxFails on a key starts its mfaLockout
// cooldown and resets its counter, so lockouts recur per burst rather than
// growing unbounded.
func mfaThrottleFail(email, ip string) (fails, retryAfter int) {
	now := time.Now()
	mfaThrottleMu.Lock()
	defer mfaThrottleMu.Unlock()
	for _, k := range mfaThrottleKeys(email, ip) {
		a := mfaAttempts[k]
		if a == nil || now.Sub(a.windowStart) > mfaFailWindow {
			a = &mfaAttempt{windowStart: now}
			mfaAttempts[k] = a
		}
		a.fails++
		if a.fails >= mfaMaxFails {
			a.lockedUntil = now.Add(mfaLockout)
			a.fails = 0
			a.windowStart = now
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
	return
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
		if !a.lockedUntil.After(now) && now.Sub(a.windowStart) > mfaFailWindow {
			delete(mfaAttempts, k)
		}
	}
}

// clientIPForRequest is the originating client address for rate-limiting: the
// leftmost X-Forwarded-For hop set by the edge proxy chain, else the RemoteAddr
// host.
func clientIPForRequest(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if first := strings.TrimSpace(strings.Split(xff, ",")[0]); first != "" {
			return first
		}
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// mfaGateThrottleGuard is called at the top of a 2FA verification handler. If
// the caller's account or IP is in cooldown it writes a 429 (with Retry-After)
// and returns ok=false so the handler returns without checking the code. It
// returns the resolved client IP for the handler to record failures under.
func mfaGateThrottleGuard(w http.ResponseWriter, r *http.Request, email string) (ip string, ok bool) {
	ip = clientIPForRequest(r)
	if retry, fails := mfaThrottleState(email, ip); retry > 0 {
		writeJSONThrottled(w, "Too many attempts — wait a moment before trying again.", http.StatusTooManyRequests, fails, retry)
		return ip, false
	}
	return ip, true
}

// mfaGateThrottleFail records a failed 2FA verification: it bumps the
// account/IP counters, mirrors the failure (and any triggered lockout) to the
// SIEM via recordEvent, and writes the error response carrying the fail count +
// cooldown so the SPA can render the indicator. Status is 429 once locked,
// else the caller's intended 401.
func mfaGateThrottleFail(w http.ResponseWriter, email, ip, endpoint, msg string) {
	fails, retry := mfaThrottleFail(email, ip)
	target := endpoint + " ip=" + ip
	_ = recordEvent(email, audit2FAFailed, target)
	status := http.StatusUnauthorized
	if retry > 0 {
		_ = recordEvent(email, audit2FALockout, target)
		status = http.StatusTooManyRequests
		msg = "Too many attempts — wait a moment before trying again."
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
