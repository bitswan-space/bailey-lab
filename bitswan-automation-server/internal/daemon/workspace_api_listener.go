package daemon

import (
	"crypto/subtle"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
)

// workspaceAPIPort is where a workspace's own services reach the small set of
// daemon routes they legitimately call.
const workspaceAPIPort = 9079

// startWorkspaceAPI serves the workspace-callable routes over TCP, for the
// services that cannot reach the UNIX socket.
//
// On a Docker host every workspace container mounts /var/run/bitswan and calls
// the daemon over the socket, and authMiddleware trusts whoever reaches it. That
// premise has failed three times already (#128, #189, #234), which is why the
// socket's routes are classified into two lists: the operator-only ones and the
// ones a first-party workspace service legitimately calls.
//
// In a namespace a workspace service is its own pod and cannot share the socket
// at all. Rather than widen the socket's trust, this serves ONLY
// socketWorkspaceCallableRoutes, and only to a caller holding the workspace's
// driver token. The privileged routes are not registered on this mux at all, so
// they are not merely refused here — they are unreachable.
//
// That makes the classification enforced rather than documented, which is the
// half of it that was missing.
func (s *Server) startWorkspaceAPI() error {
	token := strings.TrimSpace(os.Getenv("BITSWAN_INFRA_DRIVER_TOKEN"))
	if token == "" {
		return fmt.Errorf("refusing to serve the workspace API without a token to guard it")
	}

	mux := http.NewServeMux()
	s.registerWorkspaceCallableRoutes(mux)

	guarded := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !bearerEquals(r.Header.Get("Authorization"), token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		mux.ServeHTTP(w, r)
	})

	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", workspaceAPIPort))
	if err != nil {
		return fmt.Errorf("listen for the workspace API: %w", err)
	}
	go func() {
		_ = (&http.Server{Handler: guarded}).Serve(ln)
	}()
	fmt.Printf("workspace API listening on :%d (workspace-callable routes only)\n", workspaceAPIPort)
	return nil
}

func bearerEquals(header, token string) bool {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return false
	}
	got := strings.TrimSpace(strings.TrimPrefix(header, prefix))
	return subtle.ConstantTimeCompare([]byte(got), []byte(token)) == 1
}

// registerWorkspaceCallableRoutes registers exactly the routes a workspace's own
// services may call, and nothing else.
//
// The handlers are the same ones the socket mux serves; what differs is that the
// bearer token has already been checked, so authMiddleware's socket-peer
// reasoning does not apply and is not used.
func (s *Server) registerWorkspaceCallableRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/ingress", s.handleIngress)
	mux.HandleFunc("/ingress/", s.handleIngress)
	mux.HandleFunc("/bailey/role", s.handleUserRole)
	mux.HandleFunc("/memory/admit", s.handleMemoryAdmit)
}

// workspaceCallableRoutePatterns reports what the workspace listener serves, so
// the classification can be asserted rather than trusted.
func workspaceCallableRoutePatterns() []string {
	return []string{"/ingress", "/ingress/", "/bailey/role", "/memory/admit"}
}
