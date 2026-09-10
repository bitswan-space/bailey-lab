package daemon

import (
	"crypto/subtle"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
)

const workspaceAPIPort = 9079

const workspaceAPITokenEnv = "BITSWAN_WORKSPACE_API_TOKEN"

func (s *Server) startWorkspaceAPI() error {
	token := strings.TrimSpace(os.Getenv(workspaceAPITokenEnv))
	if token == "" {
		return fmt.Errorf("no %s is set", workspaceAPITokenEnv)
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

func (s *Server) registerWorkspaceCallableRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/ingress", s.handleIngress)
	mux.HandleFunc("/ingress/", s.handleIngress)
	mux.HandleFunc("/bailey/role", s.handleUserRole)
	mux.HandleFunc("/memory/admit", s.handleMemoryAdmit)
}

func workspaceCallableRoutePatterns() []string {
	return []string{"/ingress", "/ingress/", "/bailey/role", "/memory/admit"}
}
