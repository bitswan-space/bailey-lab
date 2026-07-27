package daemon

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Host-scoped device trust: the SSO redirect dance.
//
// Each protected host holds its OWN host-only _bailey_device cookie (see
// setDeviceCookie) — there is no parent-domain credential that every workspace
// / BP subdomain would receive in its request headers. Trust is propagated
// between hosts NOT by a shared cookie but by a short-lived, single-use,
// HMAC-signed "grant" carried in the URL, exactly like an OIDC code:
//
//   1. An untrusted host `foo` (enforceMFAGate) stashes the origin and 303s the
//      browser to  https://<onboard>/bailey/api/device-grant .
//   2. device-grant runs on the onboarding host — the single source of trust.
//      If THIS browser is already a trusted device there (its own host-only
//      cookie), it mints a grant bound to foo and 303s to
//      https://foo/bailey/api/device-claim?grant=… ; otherwise it sends the
//      browser to the pairing SPA (which bounces back via _bailey_origin once
//      the device is trusted at onboard).
//   3. device-claim runs on foo, verifies the grant (signature, host, freshness,
//      single-use), sets foo's own host-only cookie, and 303s to the stashed
//      origin.
//
// The grant references the SAME device row as the onboard cookie, so revoking a
// device (deleting the row) still ends trust on every host at once.

// grantTTL bounds the window a grant is valid. It only has to outlive two 303
// redirects, so it is deliberately short: the grant lives in a URL (browser
// history, Referer, access logs), and the claim endpoint mints a long-lived
// device cookie, so a leaked long-lived grant would be a standing device-trust
// bypass. single-use (deviceGrants) closes the common case; this TTL closes the
// minted-but-never-claimed case.
const grantTTL = 2 * time.Minute

// deviceGrants tracks outstanding (minted, not-yet-claimed) grant nonces so each
// grant is single-use AND bound to this process — a replay, or a grant minted by
// a prior daemon instance, is rejected. Losing the set on restart only means an
// in-flight dance re-runs (invisible to the user), which fails safe.
var deviceGrants = &grantStore{outstanding: map[string]time.Time{}}

type grantStore struct {
	mu          sync.Mutex
	outstanding map[string]time.Time // nonce -> expiry
}

func (g *grantStore) register(nonce string, exp time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.evictExpiredLocked()
	g.outstanding[nonce] = exp
}

// consume removes the nonce and reports whether it was present and unexpired.
func (g *grantStore) consume(nonce string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	exp, ok := g.outstanding[nonce]
	if !ok {
		return false
	}
	delete(g.outstanding, nonce)
	return time.Now().Before(exp)
}

// evictExpiredLocked drops lapsed nonces so the map can't grow without bound.
func (g *grantStore) evictExpiredLocked() {
	now := time.Now()
	for n, exp := range g.outstanding {
		if now.After(exp) {
			delete(g.outstanding, n)
		}
	}
}

// mintGrant signs a single-use grant that lets `host` trust `deviceID` for
// `email`. Format: b64url(email).b64url(host).deviceID.issuedAtUnix.nonce.hex(hmac).
// email and host are base64url-encoded so their '.'/'@' can't collide with the
// field separator.
func mintGrant(email, host, deviceID string) (string, error) {
	key, err := signingKey()
	if err != nil {
		return "", err
	}
	nonceBytes := make([]byte, 16)
	if _, err := rand.Read(nonceBytes); err != nil {
		return "", err
	}
	nonce := hex.EncodeToString(nonceBytes)
	now := time.Now()
	body := grantBody(email, host, deviceID, now.Unix(), nonce)
	sig := grantMAC(key, body)
	deviceGrants.register(nonce, now.Add(grantTTL))
	return body + "." + sig, nil
}

func grantBody(email, host, deviceID string, issuedAt int64, nonce string) string {
	return strings.Join([]string{
		base64.RawURLEncoding.EncodeToString([]byte(email)),
		base64.RawURLEncoding.EncodeToString([]byte(host)),
		deviceID,
		strconv.FormatInt(issuedAt, 10),
		nonce,
	}, ".")
}

func grantMAC(key []byte, body string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(body))
	return hex.EncodeToString(mac.Sum(nil))
}

type deviceGrant struct {
	email, host, deviceID, nonce string
}

// verifyGrant checks the signature and freshness of a grant. It does NOT consume
// the nonce (the caller does that only once every other check passes). Returns
// false on any tampering, malformed field, or expiry.
func verifyGrant(token string) (deviceGrant, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 6 {
		return deviceGrant{}, false
	}
	body := strings.Join(parts[:5], ".")
	sig := parts[5]
	key, err := signingKey()
	if err != nil {
		return deviceGrant{}, false
	}
	want := grantMAC(key, body)
	if subtle.ConstantTimeCompare([]byte(want), []byte(sig)) != 1 {
		return deviceGrant{}, false
	}
	emailB, err1 := base64.RawURLEncoding.DecodeString(parts[0])
	hostB, err2 := base64.RawURLEncoding.DecodeString(parts[1])
	issuedAt, err3 := strconv.ParseInt(parts[3], 10, 64)
	if err1 != nil || err2 != nil || err3 != nil {
		return deviceGrant{}, false
	}
	if time.Since(time.Unix(issuedAt, 0)) > grantTTL {
		return deviceGrant{}, false
	}
	return deviceGrant{
		email:    string(emailB),
		host:     string(hostB),
		deviceID: parts[2],
		nonce:    parts[4],
	}, true
}

// handleDeviceGrant serves GET /bailey/api/device-grant on the onboarding host.
func (s *Server) handleDeviceGrant(w http.ResponseWriter, r *http.Request, email string) {
	if email == "" {
		writeJSONError(w, "no identity", http.StatusUnauthorized)
		return
	}
	host := originHostFromRequest(r)
	if host == "" {
		// Nothing meaningful to grant for → just land the user on the console.
		http.Redirect(w, r, safeOriginTarget(""), http.StatusSeeOther)
		return
	}
	if dev := currentDeviceForRequest(r, email); dev != nil {
		grant, err := mintGrant(email, host, dev.ID)
		if err != nil {
			writeJSONError(w, "mint grant: "+err.Error(), http.StatusInternalServerError)
			return
		}
		claim := "https://" + host + "/bailey/api/device-claim?grant=" + url.QueryEscape(grant)
		http.Redirect(w, r, claim, http.StatusSeeOther)
		return
	}
	// This browser isn't trusted at the onboarding host yet → render the pairing
	// scene. The SPA bounces back to the stashed origin once trust is minted,
	// which re-enters this dance (now trusted) for the origin host.
	http.Redirect(w, r, onboardSPARoot(), http.StatusSeeOther)
}

// handleDeviceClaim serves GET /bailey/api/device-claim on the ORIGIN host.
func (s *Server) handleDeviceClaim(w http.ResponseWriter, r *http.Request, email string) {
	if email == "" {
		writeJSONError(w, "no identity", http.StatusUnauthorized)
		return
	}
	// Idempotency + loop backstop: if this host is already trusted, don't
	// re-process a (possibly stale) grant — just go home.
	if currentDeviceForRequest(r, email) != nil {
		clearTrustLoop(w)
		originRedirect(w, r)
		return
	}
	g, ok := verifyGrant(r.URL.Query().Get("grant"))
	if !ok || !strings.EqualFold(g.email, email) || !strings.EqualFold(g.host, requestEndpointHost(r)) {
		http.Error(w, "invalid or expired device-trust grant", http.StatusForbidden)
		return
	}
	if !deviceGrants.consume(g.nonce) {
		http.Error(w, "device-trust grant already used", http.StatusForbidden)
		return
	}
	// Bind THIS host's cookie to the grant's device row so a later revoke of that
	// row ends trust everywhere at once.
	if err := setDeviceCookie(w, r, email, g.deviceID); err != nil {
		writeJSONError(w, "set device cookie: "+err.Error(), http.StatusInternalServerError)
		return
	}
	touchDevice(email, g.deviceID)
	clearTrustLoop(w)
	originRedirect(w, r)
}

// originHostFromRequest reads the stashed origin (_bailey_origin), validates it
// stays same-site, and returns just its hostname (empty for a bare-path or
// missing origin, which carries no host to trust).
func originHostFromRequest(r *http.Request) string {
	c, err := r.Cookie(gateOriginCookie)
	if err != nil || c.Value == "" {
		return ""
	}
	target := safeOriginTarget(c.Value)
	if !strings.HasPrefix(target, "https://") {
		return ""
	}
	u, err := url.Parse(target)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// onboardSPARoot is the onboarding host root, where the gate SPA renders the
// pairing scene. Falls back to "/" when no protected domain is configured.
func onboardSPARoot() string {
	dom := protectedHostnameDomain()
	if dom == "" {
		return "/"
	}
	return "https://" + serverConsoleOnboardHost(dom) + "/"
}

// onboardDeviceGrantURL is where enforceMFAGate sends an untrusted browser to
// begin the dance: the device-grant endpoint on the onboarding host.
func onboardDeviceGrantURL() string {
	dom := protectedHostnameDomain()
	if dom == "" {
		return "/"
	}
	return "https://" + serverConsoleOnboardHost(dom) + "/bailey/api/device-grant"
}

const (
	trustLoopCookie     = "_bailey_trustloop"
	maxTrustDanceRounds = 3
)

// trustDanceExhausted increments a short-lived, host-only round counter each time
// this host bounces an untrusted browser into the trust dance, and returns true
// once the dance has run maxTrustDanceRounds times without this host ending up
// with a device cookie — i.e. the browser is refusing to keep the cookie. It
// lets enforceMFAGate show an error instead of ping-ponging forever. A
// successful claim clears the counter (clearTrustLoop), so the budget resets per
// failure streak.
func trustDanceExhausted(w http.ResponseWriter, r *http.Request) bool {
	n := 0
	if c, err := r.Cookie(trustLoopCookie); err == nil {
		n, _ = strconv.Atoi(c.Value)
	}
	if n >= maxTrustDanceRounds {
		clearTrustLoop(w)
		return true
	}
	http.SetCookie(w, &http.Cookie{
		Name: trustLoopCookie, Value: strconv.Itoa(n + 1), Path: "/",
		MaxAge: 60, HttpOnly: true,
		Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
		SameSite: http.SameSiteStrictMode,
	})
	return false
}

func clearTrustLoop(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: trustLoopCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
}

// writeTrustLoopError renders a plain, un-wrapped explanation when the dance
// can't converge (cookies blocked for the site).
func writeTrustLoopError(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusForbidden)
	_, _ = w.Write([]byte(`<!doctype html><meta charset="utf-8"><title>Device trust</title>` +
		`<div style="font:16px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5">` +
		`<h1 style="font-size:1.25rem">Couldn't establish device trust</h1>` +
		`<p>Your browser isn't keeping the device-trust cookie, so this device can't be confirmed. ` +
		`This usually means cookies are blocked for this site — allow cookies for it and reload.</p>` +
		`</div>`))
}
