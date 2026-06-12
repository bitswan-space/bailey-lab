package daemon

import (
	"fmt"
	"html"
	"net/http"
	"net/url"
)

// Bailey chrome — a thin footer pinned to the bottom of every
// protected app's tab. Tells the user they're inside a Bailey-guarded
// endpoint, who they're signed in as, and gives owners a Share button
// and everyone a Logout button. The actual app lives in a
// full-viewport iframe pointed at the paired inner subdomain; the tab
// origin stays per-app, so browser storage isolation between apps is
// preserved.

// Footer styling follows the workspace dashboard's dark theme (the
// shadcn/zinc palette mirrored from aoc-frontend): zinc-950 surface,
// zinc-800 hairline border, zinc-400 muted text, 6px radii, Roboto.
const (
	chromeFooterPx     = 28
	chromeFooterBg     = "#09090B" // zinc-950 — dashboard dark --background
	chromeFooterBorder = "#27272A" // zinc-800 — dashboard dark --border
	chromeFooterFg     = "#FAFAFA" // dashboard dark --foreground
	chromeFooterMuted  = "#A1A1AA" // zinc-400 — dashboard dark --muted-foreground
)

// chromeShieldSVG is a small lucide-style shield mark for the footer —
// inline so the wrap page needs no external assets (its CSP allows
// none) and renders identically everywhere, unlike an emoji.
const chromeShieldSVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/></svg>`

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
	apiURL := gatePathPrefix + "/api/share/" + url.PathEscape(host)

	shareBtn := ""
	shareModal := ""
	shareScript := ""
	if isOwner {
		shareBtn = `<a class="btn btn-primary" href="#" onclick="window.__baileyShareOpen();return false;">Share</a>`
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
    box-sizing: border-box;
    background: %[1]s; color: %[4]s;
    border-top: 1px solid %[3]s;
    font: 12px/1 Roboto, system-ui, -apple-system, 'Segoe UI', sans-serif;
    display: flex; align-items: center; gap: 8px; padding: 0 10px;
    overflow: hidden; white-space: nowrap; z-index: 2147483647;
  }
  footer.bailey-footer .brand {
    display: inline-flex; align-items: center; gap: 6px;
    color: %[4]s; flex-shrink: 0;
  }
  footer.bailey-footer .brand svg { color: %[5]s; }
  footer.bailey-footer .brand b { color: %[5]s; font-weight: 500; }
  footer.bailey-footer .dot   { color: %[4]s; opacity: 0.5; flex-shrink: 0; }
  footer.bailey-footer .who   { color: %[4]s; flex-shrink: 1; overflow: hidden; text-overflow: ellipsis; }
  footer.bailey-footer .who b { color: %[5]s; font-weight: 500; }
  footer.bailey-footer .spacer { flex: 1; }
  footer.bailey-footer a.btn {
    display: inline-flex; align-items: center; height: 20px;
    padding: 0 10px; border-radius: 6px;
    color: %[4]s; text-decoration: none; flex-shrink: 0; cursor: pointer;
    border: 1px solid transparent;
  }
  footer.bailey-footer a.btn:hover { background: %[3]s; color: %[5]s; }
  footer.bailey-footer a.btn-primary {
    background: %[5]s; color: #18181B; font-weight: 500;
  }
  footer.bailey-footer a.btn-primary:hover { background: #E4E4E7; color: #18181B; }
%[9]s
</style>
</head><body>
<iframe class="bailey-content" src="%[6]s" allow="clipboard-read; clipboard-write; fullscreen; camera; microphone; geolocation"></iframe>
<footer class="bailey-footer">
  <span class="brand">%[7]s Protected by Bitswan <b>Bailey</b></span>
  <span class="dot">·</span>
  <span class="who"><b>%[8]s</b></span>
  <span class="spacer"></span>
  %[10]s
  <a class="btn" href="%[13]s" target="_top">Logout</a>
</footer>
%[11]s
<script>%[12]s</script>
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
		chromeFooterBg, chromeFooterPx, chromeFooterBorder, chromeFooterMuted, chromeFooterFg,
		html.EscapeString(iframeSrc),
		chromeShieldSVG,
		html.EscapeString(emailDisp),
		shareModalCSS,
		shareBtn,
		shareModal,
		shareScript,
		html.EscapeString(logoutURLForHost(host)))
}
