package daemon

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
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

// serveServerConsole serves the embedded SPA. Real files (index.html,
// assets/*) are served as-is; any other path falls back to index.html so a
// deep link or reload of a client-side view still loads the app.
func serveServerConsole(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if p == "" {
		p = "index.html"
	}
	if _, err := fs.Stat(serverConsoleRoot, p); err != nil {
		p = "index.html" // SPA fallback
	}

	// The console is a self-contained bundle: same-origin scripts/fonts, with
	// an inline <style> in index.html. It talks to no third party.
	w.Header().Set("Content-Security-Policy",
		"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "+
			"img-src 'self' data:; font-src 'self' data:; connect-src 'self'")
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")

	r2 := r.Clone(r.Context())
	r2.URL.Path = "/" + p
	http.FileServer(http.FS(serverConsoleRoot)).ServeHTTP(w, r2)
}
