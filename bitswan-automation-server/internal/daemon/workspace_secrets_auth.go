package daemon

import (
	"crypto/subtle"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// hostRootDir is where the daemon container sees the host filesystem
// (mounted by `bitswan automation-server-daemon init` as -v /:/host).
// Overridable in tests.
var hostRootDir = "/host"

// hostCLIToken returns the local-server token from the HOST user's CLI
// config (~/.config/bitswan/automation_server_config.toml on the host,
// reached through the /host mount + HOST_HOME). The daemon's own config
// lives in a Docker volume, so this is a DIFFERENT store: it is the token
// the host CLI sends as its bearer token. Empty when the daemon runs
// without the host mount (e.g. directly on the host, where s.token and the
// CLI token are already the same file) or when the host has no config yet.
func hostCLIToken() string {
	hostHome := os.Getenv("HOST_HOME")
	if hostHome == "" {
		return ""
	}
	dir := filepath.Join(hostRootDir, hostHome, ".config", "bitswan")
	token, err := config.NewAutomationServerConfigWithDir(dir).GetLocalServerToken()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(token)
}

// callerHasAdminToken reports whether the request carries a bearer token that
// proves host-admin (or daemon-internal) identity. Unlike authMiddleware —
// which trusts any unix-socket peer because the socket is deliberately open
// to every workspace's gitops/infra-driver container for ingress/memory/role
// calls — this check does NOT trust the transport. It gates responses that
// contain workspace secrets (issue #128): a workspace container has no way
// to read either token store, while the host CLI always sends its host-config
// token and the daemon itself (or `docker exec` into it) can send s.token.
func (s *Server) callerHasAdminToken(r *http.Request) bool {
	_, ok := s.callerAdminPrincipal(r)
	return ok
}

// Admin-credential labels for audit attribution. These are deliberately NOT
// email addresses: the admin token proves possession of a credential, not the
// identity of a person, so an audit row must not claim a named user performed
// the action (issue #189 — "record the real caller"). eventRecord.Actor already
// tolerates non-email values ("" means system).
const (
	adminPrincipalHostCLI = "host-cli"     // the host operator's CLI token, from the host config via /host
	adminPrincipalDaemon  = "daemon-token" // the daemon's own token: the daemon, or `docker exec` into it
)

// callerAdminPrincipal reports WHICH admin credential a request carries, so
// privileged handlers can attribute the action to the credential that was
// actually used instead of to the root-admin account. ok=false means no valid
// admin token was presented.
//
// Both branches are checked with a constant-time comparison: a plain == exits
// on the first differing byte, so its timing leaks how much of the secret was
// guessed correctly.
func (s *Server) callerAdminPrincipal(r *http.Request) (principal string, ok bool) {
	authHeader := r.Header.Get("Authorization")
	parts := strings.SplitN(authHeader, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
		return "", false
	}
	token := strings.TrimSpace(parts[1])
	if token == "" {
		return "", false
	}
	if s.token != "" && subtle.ConstantTimeCompare([]byte(token), []byte(s.token)) == 1 {
		return adminPrincipalDaemon, true
	}
	if host := hostCLIToken(); host != "" && subtle.ConstantTimeCompare([]byte(token), []byte(host)) == 1 {
		return adminPrincipalHostCLI, true
	}
	return "", false
}
