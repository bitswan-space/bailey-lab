package daemon

import (
	"net/http"
	"strings"
)

// chromeWrapMiddleware decides per-request whether to render the
// "Protected by Bitswan Bailey" wrap HTML or pass through to the inner
// handler. The decision is made purely on the request hostname:
//
//   - OUTER hostname (e.g. foo.<domain>): authenticated GET for
//     text/html → serve the wrap. The wrap's iframe src is the paired
//     INNER hostname; CSP on the response pins the iframe to that
//     origin. Anything else on the outer hostname (subresources,
//     POSTs, JSON) is rejected with 404 — the outer host has no app
//     surface, with the narrow exceptions listed below.
//
//   - INNER hostname (e.g. foo--inner.<domain>): always pass through
//     to the inner handler, which proxies to the actual service.
//
// There is no marker, no Referer chain, no Sec-Fetch-Dest. Hostname
// decides everything, so an `<a href="/foo">` inside an upstream app
// can't trigger a double-wrap (the hostname doesn't change) and a link
// to a third-party origin can't end up under the wrap bar (CSP
// frame-src blocks it).
func chromeWrapMiddleware(inner http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := requestEndpointHost(r)
		if isInnerHost(host) {
			inner.ServeHTTP(w, r)
			return
		}

		// Outer hostname. The wrap is meaningful only on a top-level
		// browser GET for HTML; a few same-origin paths are passed
		// through because the wrap page itself depends on them:
		switch {
		case strings.HasPrefix(r.URL.Path, "/oauth2/"):
			// oauth2-proxy is the layer above us — it handles these
			// directly, so they should never reach the daemon. If one
			// somehow does, pass it through unchanged.
			inner.ServeHTTP(w, r)
			return
		case strings.HasPrefix(r.URL.Path, gatePathPrefix+"/api/"):
			// XHR endpoints the wrap itself calls — the share modal's
			// fetch hits /2fa-gate/api/share/<host> on the outer origin
			// (the wrap's CSP only allows connect-src 'self').
			inner.ServeHTTP(w, r)
			return
		}

		if r.Method != http.MethodGet || !strings.Contains(r.Header.Get("Accept"), "text/html") {
			http.NotFound(w, r)
			return
		}
		if email, _ := identityFromHeaders(r); email == "" {
			// Should be impossible — oauth2-proxy upstream sets the
			// header. If we get here without it, oauth failed; fall
			// through and let the inner handler reject.
			inner.ServeHTTP(w, r)
			return
		}
		serveBaileyChrome(w, r)
	})
}
