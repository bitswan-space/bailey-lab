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

// onboardServableAsset reports whether p is a real file in the embedded bundle
// — i.e. something the PUBLIC onboarding host may answer with directly.
//
// It exists because serveServerConsole falls every unknown path back to
// index.html. That fallback is right for the console host (a reloaded deep link
// must still boot the SPA) and wrong for the onboarding host, where it hands
// the console shell to anyone who asks for any path (#403). Documents are
// redirected to "/" by the caller; everything else must be a file that really
// exists or nothing at all.
func onboardServableAsset(p string) bool {
	clean := strings.TrimPrefix(path.Clean("/"+p), "/")
	if clean == "" || clean == "index.html" {
		return true
	}
	st, err := fs.Stat(serverConsoleRoot, clean)
	return err == nil && !st.IsDir()
}

// consoleModeMeta is the explicit statement of which surface the shell being
// served is allowed to render. The SPA reads it (never its own hostname) and
// refuses to mount the console in "onboarding" mode, so the admin surface is
// not merely redirected away from the onboarding host — it does not exist
// there. The host that serves the document is the only party that knows the
// answer, so the answer travels with the document.
const consoleModeMetaName = "bitswan-console-mode"

// consoleModeForHost returns the mode to stamp into the shell served to host.
func consoleModeForHost(host string) string {
	if isServerConsoleOnboardHost(toOuterHost(host)) {
		return "onboarding"
	}
	return "console"
}

// injectConsoleMode stamps <meta name="bitswan-console-mode" content="…"> into
// the shell's <head>. Mirrors appendNavSyncToHTML: a byte-level insert, so the
// built bundle needs no build-time variant per host.
func injectConsoleMode(body []byte, mode string) []byte {
	tag := []byte(`<meta name="` + consoleModeMetaName + `" content="` + mode + `">`)
	if i := bytes.Index(body, []byte("<head>")); i >= 0 {
		out := make([]byte, 0, len(body)+len(tag))
		out = append(out, body[:i+len("<head>")]...)
		out = append(out, tag...)
		return append(out, body[i+len("<head>"):]...)
	}
	// No <head> to extend. Prepending still puts the tag ahead of the bundle
	// that reads it, and a missing tag is NOT allowed to mean "console" (see
	// consoleMode() in console-app.jsx), so this must not silently no-op.
	return append(append([]byte{}, tag...), body...)
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
	// The console renders each user's avatar as an <img> from the sibling AOC
	// api host (api.<base>) and looks up display names there too. The SPA derives
	// that host from its own window.location (first DNS label → "api."), so mirror
	// the derivation here to keep img-src / connect-src in lockstep.
	aocImg := ""
	if i := strings.IndexByte(host, '.'); i >= 0 {
		aocImg = " https://api." + host[i+1:]
	}
	w.Header().Set("Content-Security-Policy",
		"default-src 'self'; script-src 'self' "+navSyncCSPHash+"; style-src 'self' 'unsafe-inline'; "+
			"img-src 'self' data:"+aocImg+"; font-src 'self' data:; connect-src 'self'"+aocImg+"; "+
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
			body = injectConsoleMode(body, consoleModeForHost(host))
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
