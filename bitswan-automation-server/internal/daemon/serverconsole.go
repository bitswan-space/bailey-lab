package daemon

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"io/fs"
	"net/http"
	"path"
	"strconv"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// The Bailey Server Console — the server-level admin UI (workspaces, people &
// roles, device approvals, your devices, security & recovery). The built SPA is
// embedded in the daemon binary and served on the reserved bailey.<domain>
// host, behind the same oauth2-proxy + gate as every other protected endpoint.

//go:embed all:serverconsole_dist
var serverConsoleFS embed.FS

// serverConsoleRoot is the embedded dist tree rooted at its top (so paths are
// "index.html", "assets/...").
var serverConsoleRoot, _ = fs.Sub(serverConsoleFS, "serverconsole_dist")

// navSyncCSPHash is the CSP source token ('sha256-…') for the nav-sync inline
// script that serveServerConsole injects, so script-src can stay strict yet
// still allow exactly that one script. Computed once from the script content
// (the bytes between <script> and </script>, which is what the browser hashes).
var navSyncCSPHash = func() string {
	inner := strings.TrimSuffix(strings.TrimPrefix(navSyncScript, "<script>"), "</script>")
	sum := sha256.Sum256([]byte(inner))
	return "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
}()

// isServerConsoleHost reports whether host is the reserved Server Console host
// (bailey.<domain>) for the configured protected domain.
func isServerConsoleHost(host string) bool {
	cfg, err := config.NewAutomationServerConfig().LoadConfig()
	if err != nil || cfg == nil {
		return false
	}
	dom := cfg.ProtectedHostnameDomain()
	if dom == "" {
		return false
	}
	return strings.EqualFold(host, serverConsoleHost(dom))
}

// isServerConsoleOnboardHost reports whether host is the reserved PUBLIC
// device-trust onboarding host (bailey-onboard.<domain>). The onboarding host
// serves the same embedded SPA, but it is device-trust exempt (see
// enforceMFAGate) so an untrusted device can render the gate scene and pair.
func isServerConsoleOnboardHost(host string) bool {
	cfg, err := config.NewAutomationServerConfig().LoadConfig()
	if err != nil || cfg == nil {
		return false
	}
	dom := cfg.ProtectedHostnameDomain()
	if dom == "" {
		return false
	}
	return strings.EqualFold(host, serverConsoleOnboardHost(dom))
}

// serveServerConsole serves the embedded SPA. Real files (index.html,
// assets/*) are served as-is; any other path falls back to index.html so a
// deep link or reload of a client-side view still loads the app.
func serveServerConsole(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")

	// Decide what FileServer should serve. The root and any unknown path
	// (a client-side SPA route) resolve to "/" — FileServer returns
	// index.html with 200 for a directory path. Never serve "/index.html"
	// explicitly: FileServer 301-redirects that to "./", which loops.
	serve := r.URL.Path
	if p == "" || p == "index.html" {
		serve = "/"
	} else if st, err := fs.Stat(serverConsoleRoot, p); err != nil || st.IsDir() {
		// SPA fallback → index.html. Directories must fall back too: a
		// client-side route can shadow a real asset directory (e.g.
		// /handbook is both a console route and the dist's handbook/
		// bundle dir), and letting FileServer see the directory path
		// would render its file listing on reload (#150).
		serve = "/"
	}

	// The console is a self-contained bundle: same-origin scripts/fonts, with
	// an inline <style> in index.html. It talks to no third party. It's served
	// on the inner host and framed by the outer chrome wrap, so frame-ancestors
	// must allow that outer origin (and no X-Frame-Options, which would block
	// the cross-origin frame) — mirroring strictInnerCSP for proxied apps.
	// script-src stays 'self' (the SPA's hashed bundle) PLUS the sha256 of the
	// injected nav-sync inline script — so the strict policy permits exactly
	// that one inline script and nothing else (no blanket 'unsafe-inline').
	host := requestEndpointHost(r)
	outer := toOuterHost(host)
	// The console renders each user's avatar as an <img> and looks up display
	// names from the AOC. The AOC API base is the daemon's configured aoc_url —
	// NOT a sibling of the console host: a Bailey server can live on a different
	// domain than its AOC (e.g. bailey.sandbox.bitswan.ai served by an AOC at
	// api.timssandbox2.bswn.io). We inject that base into the SPA (below) and
	// mirror it into img-src/connect-src here so the fetches are permitted.
	// Falls back to the sibling api.<base> only when no aoc_url is configured.
	aocBase := consoleAOCAPIBase(host)
	aocSrc := ""
	if aocBase != "" {
		aocSrc = " " + aocBase
	}
	w.Header().Set("Content-Security-Policy",
		"default-src 'self'; script-src 'self' "+navSyncCSPHash+"; style-src 'self' 'unsafe-inline'; "+
			"img-src 'self' data:"+aocSrc+"; font-src 'self' data:; connect-src 'self'"+aocSrc+"; "+
			"frame-ancestors 'self' https://"+outer)
	w.Header().Del("X-Frame-Options")
	// The onboarding host can land with an invite token in the query
	// (?invite=…). The SPA strips it via replaceState immediately, but
	// never let it leak through a Referer header in the meantime.
	if isServerConsoleOnboardHost(requestEndpointHost(r)) {
		w.Header().Set("Referrer-Policy", "no-referrer")
	}

	// The SPA shell (serve == "/") is what every top-level navigation and
	// client-side route resolves to. Inject the nav-sync script so the SPA's
	// pushState route changes inside the chrome-wrap iframe are mirrored to the
	// outer address bar (and survive reload). serveServerConsole is called
	// directly by chromeWrapMiddleware, bypassing injectNavSyncMiddleware, so we
	// must do the injection here ourselves — otherwise the console URL never
	// updates as you move between subpages.
	if serve == "/" {
		if raw, err := fs.ReadFile(serverConsoleRoot, "index.html"); err == nil {
			body := appendNavSyncToHTML(raw)
			body = injectAOCAPIBase(body, aocBase)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Content-Length", strconv.Itoa(len(body)))
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(body)
			return
		}
		// On a read error fall through to FileServer (still serves the shell).
	}

	r2 := r.Clone(r.Context())
	r2.URL.Path = serve
	http.FileServer(http.FS(serverConsoleRoot)).ServeHTTP(w, r2)
}

// consoleAOCAPIBase returns the base URL of the AOC API the console should call
// for shared identity data (avatars, the directory). It is the daemon's
// configured aoc_url — the AOC can live on a wholly different domain than this
// Bailey server. Falls back to the sibling api.<base> of the console host only
// when no AOC is configured yet (legacy / same-domain single-box setups).
func consoleAOCAPIBase(host string) string {
	cfg := config.NewAutomationServerConfig()
	if settings, err := cfg.GetAutomationOperationsCenterSettings(); err == nil && settings.AOCUrl != "" {
		return strings.TrimRight(settings.AOCUrl, "/")
	}
	if i := strings.IndexByte(host, '.'); i >= 0 {
		return "https://api." + host[i+1:]
	}
	return ""
}

// injectAOCAPIBase adds a <meta name="bitswan-aoc-api"> tag carrying the AOC
// API base so the SPA can read it (rather than guessing api.<own-host>). Using
// a meta tag keeps the strict script-src CSP intact — no extra inline script to
// hash. No-op when base is empty or there's no <head>.
func injectAOCAPIBase(body []byte, base string) []byte {
	if base == "" {
		return body
	}
	meta := []byte(`<meta name="bitswan-aoc-api" content="` + htmlAttrEscape(base) + `">`)
	if idx := bytes.Index(bytes.ToLower(body), []byte("<head>")); idx >= 0 {
		at := idx + len("<head>")
		out := make([]byte, 0, len(body)+len(meta))
		out = append(out, body[:at]...)
		out = append(out, meta...)
		out = append(out, body[at:]...)
		return out
	}
	return body
}

// htmlAttrEscape escapes the few characters that could break out of a
// double-quoted HTML attribute value.
func htmlAttrEscape(s string) string {
	r := strings.NewReplacer(`&`, "&amp;", `"`, "&quot;", `<`, "&lt;", `>`, "&gt;")
	return r.Replace(s)
}
