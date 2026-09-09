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
		// CRITICAL: the push runs the post-receive hook (`bitswan infra-driver
		// apply`) as a CGI grandchild, and a CGI child gets ONLY the meta-vars +
		// Env above — none of the serve process's BITSWAN_* env. But the
		// compiler reads these from os.Getenv to build the compose (e.g.
		// BITSWAN_VOLUME_NAME selects the volume-subpath live-dev /app mount;
		// without it the compiler falls back to a container-path bind that
		// resolves to an empty dir on the host → live-dev /app is unmounted).
		// Inherit them so the hook compiles identically to the serve process.
		InheritEnv: hookInheritedEnv(),
	}
}

// hookInheritedEnv is what the post-receive hook is given.
//
// A named function rather than a literal so it can be asserted against what the
// compilers actually read: the hook is a CGI grandchild with a scrubbed
// environment, and a setting missing from this list fails only on the push
// path, as an apply that refuses over configuration the serve process has.
func hookInheritedEnv() []string {
	return []string{
		"BITSWAN_VOLUME_NAME",
		"BITSWAN_GITOPS_DIR_HOST",
		"BITSWAN_WORKSPACE_DIR_HOST",
		"BITSWAN_WORKSPACE_REPO_DIR",
		"BITSWAN_CERTS_DIR",
		"BITSWAN_ALLOWED_GROUP",
		"BITSWAN_ADMIN_GROUP",
		"BITSWAN_AUTH_MODE",
		"BITSWAN_EGRESS_GATEWAY_IMAGE",
		"BITSWAN_INGRESS_URL",
		"BITSWAN_INGRESS_SOCKET",
		"BITSWAN_INFRA_DRIVER_TOKEN",
		"KEYCLOAK_URL",
		// The hook is a CGI grandchild, so an in-cluster client can only be
		// built from what is listed here: the service-account token and CA
		// are files it inherits, but these two are environment-only, and
		// without them the Kubernetes backend fails to find its API server
		// on the push path while working perfectly under `serve`.
		"KUBERNETES_SERVICE_HOST",
		"KUBERNETES_SERVICE_PORT",
		"BITSWAN_INFRA_DRIVER_KIND",
		"BITSWAN_K8S_NAMESPACE",
		"BITSWAN_INGRESS_TOKEN",
		// Everything else the Kubernetes compiler reads. These are the exact
		// counterpart of BITSWAN_VOLUME_NAME above and fail the same way:
		// the serve process has them, the hook does not, so a build works
		// and the apply that follows it refuses — with an error about
		// configuration, on a path where the configuration is right.
		"BITSWAN_K8S_VOLUME_CLAIM",
		"BITSWAN_K8S_REGISTRY",
		"BITSWAN_K8S_PULL_POLICY",
		"BITSWAN_BUILDKIT_ADDR",
		"BITSWAN_POSTGRES_IMAGE",
		"BITSWAN_GARAGE_IMAGE",
		"BITSWAN_TOOLS_IMAGE",
		"BITSWAN_K8S_POSTGRES_STORAGE",
		"BITSWAN_K8S_GARAGE_STORAGE",
		"BITSWAN_WORKSPACE_NAME",
		// Build settings and the perf log. These reach the hook for the same
		// reason as everything above, and a test asserts this list stays a
		// superset of what the compilers actually read.
		"BITSWAN_BUILD_NETWORK",
		"BITSWAN_GOPROXY",
		"BITSWAN_NPM_REGISTRY",
		"BITSWAN_PERF_LOG",
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
