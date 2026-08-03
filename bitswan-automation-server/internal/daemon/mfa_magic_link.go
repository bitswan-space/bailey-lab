package daemon

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Magic links (issue #240) — the MIDDLE device-trust tier.
//
// Three levels of device trust now exist:
//  1. Untrusted  — gets you nowhere (the pairing dance).
//  2. Magic-link — endpoint-scoped: a device that redeemed a magic link is
//     device-trusted for ONE endpoint only. The endpoint's ACL still applies,
//     so this alone does not grant access — it only spares an admin from
//     approving a pairing code per device on a low-sensitivity endpoint.
//  3. Trusted    — the full device-trust cookie (devices table): everything.
//
// A magic link is a reusable, revocable, endpoint-scoped invite. Minting is
// deliberately restricted (canMintMagicLink): the caller must be an admin OR
// auditor AND own the endpoint, and the endpoint must be PRODUCTION — never
// staging/dev. Redeeming records endpoint_device_trust for the redeemer's
// device; it never grants any ACL role and never full trust.

const (
	magicLinkCreatePath = gatePathPrefix + "/api/magic-link/create"
	magicLinkRedeemPath = gatePathPrefix + "/api/magic-link/redeem"
	magicLinkListPath   = gatePathPrefix + "/api/magic-link/list"
	magicLinkRevokePath = gatePathPrefix + "/api/magic-link/revoke"

	// magicLinkTTL is how long a freshly-minted link stays valid. Reusable the
	// whole time; revoke ends it sooner.
	magicLinkTTL = 30 * 24 * time.Hour
)

// endpointDeviceTrusted reports whether device is scoped-trusted for host.
func endpointDeviceTrusted(deviceID, host string) bool {
	return dbEndpointDeviceTrusted(deviceID, host)
}

// deviceIDFromRequest returns the device id carried by a valid (HMAC-verified)
// _bailey_device cookie, WITHOUT requiring a full-trust devices row — so the
// gate can recognise a magic-link (endpoint-scoped) device too.
func deviceIDFromRequest(r *http.Request, email string) (string, bool) {
	c, err := r.Cookie(deviceCookieName)
	if err != nil || c.Value == "" {
		return "", false
	}
	return verifyDeviceCookie(email, c.Value)
}

func newDeviceID() (string, error) {
	b := make([]byte, deviceIDLen/2)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// canMintMagicLink enforces issue #240's minting rule: admin OR auditor, AND
// owner of the endpoint, AND the endpoint is production. Returns a user-facing
// reason when denied.
func canMintMagicLink(email string, groups []string, host string) (ok bool, reason string) {
	role, err := roleFor(host, email, groups)
	if err != nil {
		return false, "could not resolve endpoint role"
	}
	if role != roleOwner {
		return false, "only an owner of this endpoint can create a magic link"
	}
	if er := effectiveRole(email); er != "admin" && er != "auditor" {
		return false, "magic links can only be created by an admin or auditor"
	}
	ep, err := getEndpoint(host)
	if err != nil || ep == nil {
		return false, "endpoint not registered"
	}
	if !strings.EqualFold(ep.Stage, "production") {
		return false, "magic links are only allowed for production endpoints"
	}
	return true, ""
}

// magicLinkURL builds the redeemable URL for a token on the endpoint host.
func magicLinkURL(host, token string) string {
	return "https://" + host + magicLinkRedeemPath + "?token=" + url.QueryEscape(token)
}

// handleMagicLinkCreate mints a link for the endpoint named in the request path
// host. POST body/query is unused; the endpoint is the request's outer host.
func handleMagicLinkCreate(w http.ResponseWriter, r *http.Request, email string, groups []string) {
	if email == "" {
		writeJSONErrorStatus(w, "no identity", http.StatusUnauthorized)
		return
	}
	host := toOuterHost(requestEndpointHost(r))
	if ok, reason := canMintMagicLink(email, groups, host); !ok {
		writeJSONErrorStatus(w, reason, http.StatusForbidden)
		return
	}
	token, m, err := dbCreateMagicLink(host, email, magicLinkTTL)
	if err != nil {
		writeJSONErrorStatus(w, "create magic link: "+err.Error(), http.StatusInternalServerError)
		return
	}
	_ = recordEvent(email, auditMagicLinkCreate, host)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"id":         m.ID,
		"host":       host,
		"url":        magicLinkURL(host, token),
		"expires_at": m.ExpiresAt.Format(time.RFC3339),
	})
}

// handleMagicLinkRedeem trusts the redeemer's device for the link's endpoint —
// endpoint-scoped only. The user is already oauth-authenticated (this path is
// device-trust-exempt but still behind oauth2-proxy).
func handleMagicLinkRedeem(w http.ResponseWriter, r *http.Request, email string) {
	if email == "" {
		writeJSONErrorStatus(w, "no identity", http.StatusUnauthorized)
		return
	}
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		http.Error(w, "missing magic-link token", http.StatusBadRequest)
		return
	}
	m, err := dbMagicLinkByTokenHash(hashMagicToken(token))
	if err != nil || m == nil || !m.live(time.Now().UTC()) {
		http.Error(w, "this magic link is invalid, expired, or revoked", http.StatusForbidden)
		return
	}
	// The link is bound to one endpoint and must be redeemed on that host, so
	// the device cookie + scoped-trust land on the right origin.
	if !strings.EqualFold(m.EndpointHost, toOuterHost(requestEndpointHost(r))) {
		http.Redirect(w, r, magicLinkURL(m.EndpointHost, token), http.StatusSeeOther)
		return
	}
	// Reuse this browser's device identity if it already has one; else mint a
	// fresh id and set the cookie. Either way the device is recorded as trusted
	// for THIS endpoint only — never added to the full-trust devices table.
	id, ok := deviceIDFromRequest(r, email)
	if !ok {
		id, err = newDeviceID()
		if err != nil {
			writeJSONErrorStatus(w, "mint device id: "+err.Error(), http.StatusInternalServerError)
			return
		}
		if err := setDeviceCookie(w, r, email, id); err != nil {
			writeJSONErrorStatus(w, "set device cookie: "+err.Error(), http.StatusInternalServerError)
			return
		}
	}
	if err := dbAddEndpointDeviceTrust(id, m.EndpointHost, email); err != nil {
		writeJSONErrorStatus(w, "record trust: "+err.Error(), http.StatusInternalServerError)
		return
	}
	_ = recordEvent(email, auditMagicLinkRedeem, m.EndpointHost)
	http.Redirect(w, r, "https://"+m.EndpointHost+"/", http.StatusSeeOther)
}

// handleMagicLinkList returns the live links for the request's endpoint host —
// owners only (mirrors the Share API).
func handleMagicLinkList(w http.ResponseWriter, r *http.Request, email string, groups []string) {
	host := toOuterHost(requestEndpointHost(r))
	if role, _ := roleFor(host, email, groups); role != roleOwner {
		writeJSONErrorStatus(w, "owners only", http.StatusForbidden)
		return
	}
	links, err := dbListMagicLinks(host)
	if err != nil {
		writeJSONErrorStatus(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out := make([]map[string]any, 0, len(links))
	for _, m := range links {
		out = append(out, map[string]any{
			"id":         m.ID,
			"created_by": m.CreatedBy,
			"created_at": m.CreatedAt.Format(time.RFC3339),
			"expires_at": m.ExpiresAt.Format(time.RFC3339),
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"links": out})
}

// handleMagicLinkRevoke revokes a link by id. Same guard as minting (owner +
// admin/auditor) so a link can't outlive the authority that made it.
func handleMagicLinkRevoke(w http.ResponseWriter, r *http.Request, email string, groups []string) {
	host := toOuterHost(requestEndpointHost(r))
	if ok, reason := canMintMagicLink(email, groups, host); !ok {
		writeJSONErrorStatus(w, reason, http.StatusForbidden)
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if strings.TrimSpace(body.ID) == "" {
		writeJSONErrorStatus(w, "id required", http.StatusBadRequest)
		return
	}
	changed, err := dbRevokeMagicLink(body.ID, host)
	if err != nil {
		writeJSONErrorStatus(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !changed {
		writeJSONErrorStatus(w, "no such live magic link on this endpoint", http.StatusNotFound)
		return
	}
	_ = recordEvent(email, auditMagicLinkRevoke, host)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"revoked": true})
}
