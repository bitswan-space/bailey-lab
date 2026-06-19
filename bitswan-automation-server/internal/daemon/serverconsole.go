package daemon

import (
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
	} else if _, err := fs.Stat(serverConsoleRoot, p); err != nil {
		serve = "/" // SPA fallback → index.html
	}

	// The console is a self-contained bundle: same-origin scripts/fonts, with
	// an inline <style> in index.html. It talks to no third party. It's served
	// on the inner host and framed by the outer chrome wrap, so frame-ancestors
	// must allow that outer origin (and no X-Frame-Options, which would block
	// the cross-origin frame) — mirroring strictInnerCSP for proxied apps.
	// script-src stays 'self' (the SPA's hashed bundle) PLUS the sha256 of the
	// injected nav-sync inline script — so the strict policy permits exactly
	// that one inline script and nothing else (no blanket 'unsafe-inline').
	outer := toOuterHost(requestEndpointHost(r))
	w.Header().Set("Content-Security-Policy",
		"default-src 'self'; script-src 'self' "+navSyncCSPHash+"; style-src 'self' 'unsafe-inline'; "+
			"img-src 'self' data:; font-src 'self' data:; connect-src 'self'; "+
			"frame-ancestors 'self' https://"+outer)
	w.Header().Del("X-Frame-Options")

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
