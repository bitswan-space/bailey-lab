package daemon

import (
	"fmt"
	"html"
	"net/http"
	"net/url"
	"strings"
)

// Bailey chrome — a thin footer pinned to the bottom of every
// protected app's tab. Tells the user they're inside a Bailey-guarded
// endpoint, who they're signed in as, and gives owners a Share button
// and everyone a Logout button. The actual app lives in a
// full-viewport iframe pointed at the paired inner subdomain; the tab
// origin stays per-app, so browser storage isolation between apps is
// preserved.

const (
	chromeFooterPx = 22
	chromeFooterBg = "#0D1326"
	chromeFooterFg = "#FAFAFA"
)

// serveBaileyChrome renders the wrap HTML for an outer-hostname
// request. Must only be called for authenticated top-level HTML GETs —
// chromeWrapMiddleware enforces that.
func serveBaileyChrome(w http.ResponseWriter, r *http.Request) {
	email, groups := identityFromHeaders(r)
	host := requestEndpointHost(r) // outer host

	// The iframe loads the paired inner subdomain at the same path the
	// user requested, so deep links land on the right page inside the
	// iframe instead of the inner host's root.
	innerHost := toInnerHost(host)
	innerURL := "https://" + innerHost + r.URL.Path
	if r.URL.RawQuery != "" {
		innerURL += "?" + r.URL.RawQuery
	}

	// The Share button is only shown to owners — non-owners have no
	// authority to change sharing rules, so the button would be a dead
	// end. roleFor returns "" if the endpoint isn't registered yet;
	// treat that as "no Share button". ACL is keyed by the outer host.
	isOwner := false
	if role, _ := roleFor(host, email, groups); role == roleOwner {
		isOwner = true
	}

	// CSP pins the iframe to exactly the paired inner subdomain.
	// Without this an upstream app could (via JS) navigate the iframe
	// to a third-party origin and the "Protected by Bailey" bar would
	// hover over content the server has no authority over.
	//
	// 'unsafe-inline' on script-src is the small share-modal + nav-sync
	// listener we ship inline. No external scripts load on this page —
	// the iframe carries the actual app and has its own CSP.
	// connect-src 'self' lets the share modal's fetch reach
	// /2fa-gate/api/share/<host> on the same outer host (passed through
	// to the gate by the wrap middleware).
	csp := "frame-src https://" + innerHost + "; default-src 'none'; " +
		"script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
		"img-src 'self' data:; font-src data:; connect-src 'self'"
	w.Header().Set("Content-Security-Policy", csp)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	fmt.Fprint(w, baileyChromeHTML(email, host, innerURL, isOwner))
}

func baileyChromeHTML(email, host, iframeSrc string, isOwner bool) string {
	emailDisp := "anonymous"
	if email != "" {
		emailDisp = email
	}
	fence := strings.Repeat("▲", 400)
	apiURL := gatePathPrefix + "/api/share/" + url.PathEscape(host)

	shareBtn := ""
	shareModal := ""
	shareScript := ""
	if isOwner {
		shareBtn = `<a class="btn" href="#" onclick="window.__baileyShareOpen();return false;">Share</a>`
		shareModal = shareModalHTML()
		shareScript = shareModalJS(host, emailDisp, apiURL)
	}

	return fmt.Sprintf(`<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bailey</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%%; overflow: hidden; background: %[1]s; }
  iframe.bailey-content { position: fixed; inset: 0 0 %[2]dpx 0; width: 100vw; height: calc(100vh - %[2]dpx); border: 0; display: block; background: white; }
  footer.bailey-footer {
    position: fixed; left: 0; right: 0; bottom: 0; height: %[2]dpx;
    background: %[1]s; color: %[3]s;
    font: 12px/%[2]dpx -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    display: flex; align-items: center; overflow: hidden; white-space: nowrap; z-index: 2147483647;
  }
  footer.bailey-footer .label   { padding: 0 10px; flex-shrink: 0; }
  footer.bailey-footer .label b { font-weight: 600; }
  footer.bailey-footer .sep     { padding: 0 6px; opacity: 0.55; flex-shrink: 0; }
  footer.bailey-footer .fence   { flex: 1; opacity: 0.45; letter-spacing: 1px; overflow: hidden; }
  footer.bailey-footer a.btn    { padding: 0 12px; color: %[3]s; text-decoration: none; flex-shrink: 0; border-left: 1px solid rgba(255,255,255,0.18); cursor: pointer; }
  footer.bailey-footer a.btn:hover { background: rgba(255,255,255,0.06); }
%[8]s
</style>
</head><body>
<iframe class="bailey-content" src="%[4]s" allow="clipboard-read; clipboard-write; fullscreen; camera; microphone; geolocation"></iframe>
<footer class="bailey-footer">
  <span class="label">🛡 Protected by Bitswan Bailey</span>
  <span class="sep">·</span>
  <span class="label">Logged in as <b>%[5]s</b></span>
  <span class="fence">%[6]s</span>
  %[7]s
  <a class="btn" href="/oauth2/sign_out" target="_top">Logout</a>
</footer>
%[9]s
<script>%[10]s</script>
<script>
(function(){
  // The iframe content posts {type:'bailey-nav', path:'...'} whenever
  // it navigates (see inner_navsync.go). Mirror that path into the
  // outer URL bar so reloads land on the same page. Filter messages
  // to ones that look like a bailey nav payload to avoid acting on
  // chatter from upstream apps' own postMessage use.
  var lastPath = location.pathname + location.search + location.hash;
  window.addEventListener('message', function(ev){
    var d = ev && ev.data;
    if (!d || d.type !== 'bailey-nav' || typeof d.path !== 'string') return;
    if (d.path === lastPath) return;
    lastPath = d.path;
    try { history.replaceState(null, '', d.path); } catch (e) {}
  });
})();
</script>
</body></html>`,
		chromeFooterBg, chromeFooterPx, chromeFooterFg,
		html.EscapeString(iframeSrc),
		html.EscapeString(emailDisp),
		fence,
		shareBtn,
		shareModalCSS,
		shareModal,
		shareScript)
}
