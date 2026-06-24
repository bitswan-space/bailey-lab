package infradriver

import (
	"crypto/subtle"
	"net/http"
	"net/http/cgi"
	"os"
	"strings"
)

// gitHTTPBackend is the stock git smart-HTTP CGI. The driver hosts the deploy
// repo here so gitops can `git push` the resolved bitswan.yaml: the push runs
// the bare repo's post-receive hook IN THE DRIVER (which owns docker.sock),
// which is the whole point — a file:// push would run the hook in gitops, which
// has no socket after the cut-over.
const gitHTTPBackend = "/usr/lib/git-core/git-http-backend"

// gitCGIHandler serves `git http-backend` as CGI with projectRoot as
// GIT_PROJECT_ROOT (the dir containing the bare deploy repo). Mirrors gitops's
// routes/git_http.py.
func gitCGIHandler(projectRoot string) http.Handler {
	backend := os.Getenv("GIT_HTTP_BACKEND")
	if backend == "" {
		backend = gitHTTPBackend
	}
	return &cgi.Handler{
		Path: backend,
		Dir:  projectRoot,
		Env: []string{
			"GIT_PROJECT_ROOT=" + projectRoot,
			// Export without a per-repo `git-daemon-export-ok` marker — the repo
			// is private behind the bearer token + the internal network.
			"GIT_HTTP_EXPORT_ALL=1",
			// Trust the volume-backed repo regardless of owner: the driver runs
			// as root, the repo is user1000-owned, and the receive-pack child
			// doesn't inherit HOME (so ~/.gitconfig's safe.directory wouldn't
			// apply). GIT_CONFIG_* is inherited by the git child processes.
			"GIT_CONFIG_COUNT=1",
			"GIT_CONFIG_KEY_0=safe.directory",
			"GIT_CONFIG_VALUE_0=*",
		},
	}
}

// tokenAuth guards next with a shared bearer token: accepted either as
// `Authorization: Bearer <token>` (the /v1 client) or as the Basic-auth
// password (git, which sends credentials via Basic on http remotes —
// gitops pushes to http://x:<token>@<driver>/<repo>.git). An empty token
// disables the guard (single-host dev/test only).
func tokenAuth(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if token == "" || equalToken(requestToken(r), token) {
			next.ServeHTTP(w, r)
			return
		}
		// Prompt git's credential machinery to supply Basic creds.
		w.Header().Set("WWW-Authenticate", `Basic realm="bitswan-infra-driver"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	})
}

// requestToken extracts the presented secret from a Bearer header or the Basic
// password, returning "" if neither matches. Constant-time compared by caller.
func requestToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	if _, pass, ok := r.BasicAuth(); ok {
		return pass
	}
	return ""
}

// equalToken is a constant-time token comparison.
func equalToken(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
