package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/traefikapi"
	"github.com/dchest/uniuri"
)

const (
	// SocketDir is the directory containing the automation server daemon socket
	SocketDir = "/var/run/bitswan"
	// SocketPath is the default path for the automation server daemon socket
	SocketPath = "/var/run/bitswan/automation-server.sock"
)

// Server represents the automation server daemon HTTP server
type Server struct {
	version      string
	startTime    time.Time
	listener     net.Listener
	server       *http.Server
	docsServer   *http.Server
	docsListener net.Listener
	token        string

	// initConfirmCh is used to signal that the user has confirmed the SSH key prompt
	// during workspace init. The daemon blocks until a value is sent on this channel.
	initConfirmMu sync.Mutex
	initConfirmCh chan struct{}
}

// LoadToken reads the token from the config file
func LoadToken() (string, error) {
	cfg := config.NewAutomationServerConfig()
	return cfg.GetLocalServerToken()
}

// StatusResponse represents the response from the /status endpoint
type StatusResponse struct {
	Version   string `json:"version"`
	Uptime    string `json:"uptime"`
	UptimeSec int64  `json:"uptime_sec"`
	StartTime string `json:"start_time"`
}

// NewServer creates a new daemon server
func NewServer(version string) *Server {
	return &Server{
		version:   version,
		startTime: time.Now(),
	}
}

// authMiddleware wraps a handler with bearer token authentication.
// Requests arriving over the Unix socket (RemoteAddr is empty or "@")
// are trusted and skip token verification — access is gated by the
// socket file permissions.
func (s *Server) authMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Unix socket connections have an empty or "@" RemoteAddr
		if r.RemoteAddr == "" || r.RemoteAddr == "@" {
			next(w, r)
			return
		}

		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			http.Error(w, `{"error": "missing Authorization header"}`, http.StatusUnauthorized)
			return
		}

		// Check for "Bearer <token>" format
		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
			http.Error(w, `{"error": "invalid Authorization header format, expected 'Bearer <token>'"}`, http.StatusUnauthorized)
			return
		}

		if parts[1] != s.token {
			http.Error(w, `{"error": "invalid token"}`, http.StatusUnauthorized)
			return
		}

		next(w, r)
	}
}

// setupRoutes configures the HTTP routes
func (s *Server) setupRoutes() *http.ServeMux {
	mux := http.NewServeMux()

	// Health check endpoint (authenticated)
	mux.HandleFunc("/ping", s.authMiddleware(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "pong")
	}))

	// Version endpoint (authenticated)
	mux.HandleFunc("/version", s.authMiddleware(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{
			"version": s.version,
		})
	}))

	// Status endpoint - returns version, uptime, etc. (authenticated)
	mux.HandleFunc("/status", s.authMiddleware(func(w http.ResponseWriter, r *http.Request) {
		uptime := time.Since(s.startTime)

		response := StatusResponse{
			Version:   s.version,
			Uptime:    formatDuration(uptime),
			UptimeSec: int64(uptime.Seconds()),
			StartTime: s.startTime.Format(time.RFC3339),
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(response)
	}))

	// Automation endpoints (authenticated)
	mux.HandleFunc("/automations", s.authMiddleware(s.handleAutomations))
	mux.HandleFunc("/automations/", s.authMiddleware(s.handleAutomations))

	// Workspace endpoints (authenticated)
	mux.HandleFunc("/workspace", s.authMiddleware(s.handleWorkspace))
	mux.HandleFunc("/workspace/", s.authMiddleware(s.handleWorkspace))

	// Certificate authority endpoints (authenticated)
	mux.HandleFunc("/certauthority", s.authMiddleware(s.handleCertAuthority))
	mux.HandleFunc("/certauthority/", s.authMiddleware(s.handleCertAuthority))

	// Ingress endpoints (authenticated)
	mux.HandleFunc("/ingress", s.authMiddleware(s.handleIngress))
	mux.HandleFunc("/ingress/", s.authMiddleware(s.handleIngress))

	// AOC connection config (authenticated) — register persists the freshly
	// obtained token here so the daemon (not the host) owns ~/.config/bitswan.
	mux.HandleFunc("/aoc", s.authMiddleware(s.handleAOC))
	mux.HandleFunc("/aoc/", s.authMiddleware(s.handleAOC))

	// Service endpoints (authenticated)
	mux.HandleFunc("/service", s.authMiddleware(s.handleService))
	mux.HandleFunc("/service/", s.authMiddleware(s.handleService))

	// Job endpoints for interactive operations (authenticated)
	mux.HandleFunc("/jobs", s.authMiddleware(s.handleJobs))
	mux.HandleFunc("/jobs/", s.authMiddleware(s.handleJobs))

	// Bailey device-trust admin (authenticated; socket-trusted). Backs the
	// `bitswan bailey devices` CLI — approve a pending "trust this device"
	// request by code, or list the pending requests.
	mux.HandleFunc("/bailey/devices/approve", s.authMiddleware(s.handleDeviceApprove))
	mux.HandleFunc("/bailey/devices/pending", s.authMiddleware(s.handleDevicesPending))

	// Bailey authoritative role lookup (authenticated; socket-trusted). Lets a
	// trusted backend (gitops, on behalf of the dashboard shim that already
	// verified the user's access token) resolve a user's effectiveRole without
	// re-deriving it from SSO groups. Read-only, keyed by email.
	mux.HandleFunc("/bailey/role", s.authMiddleware(s.handleUserRole))

	// Bailey endpoint access grants (authenticated; socket-trusted, CLI-only —
	// deliberately not exposed on the public gate mux to keep the share UI
	// least-privileged). Backs `bitswan bailey access {grant,revoke,list}`.
	mux.HandleFunc("/bailey/access/grant", s.authMiddleware(s.handleAccessGrant))
	mux.HandleFunc("/bailey/access/revoke", s.authMiddleware(s.handleAccessRevoke))
	mux.HandleFunc("/bailey/access/list", s.authMiddleware(s.handleAccessList))

	// Docs endpoint (unauthenticated - public access)
	mux.HandleFunc("/api-docs", s.handleDocs)

	return mux
}

// formatDuration formats a duration into a human-readable string
func formatDuration(d time.Duration) string {
	days := int(d.Hours()) / 24
	hours := int(d.Hours()) % 24
	minutes := int(d.Minutes()) % 60
	seconds := int(d.Seconds()) % 60

	if days > 0 {
		return fmt.Sprintf("%dd %dh %dm %ds", days, hours, minutes, seconds)
	}
	if hours > 0 {
		return fmt.Sprintf("%dh %dm %ds", hours, minutes, seconds)
	}
	if minutes > 0 {
		return fmt.Sprintf("%dm %ds", minutes, seconds)
	}
	return fmt.Sprintf("%ds", seconds)
}

// Run starts the HTTP server listening on the Unix socket
func (s *Server) Run() error {
	// Load the authentication token. The daemon owns this token now that its
	// config lives in a Docker volume (not a host bind the CLI also writes):
	// generate + persist one if absent, so a fresh install is self-sufficient.
	token, err := LoadToken()
	if err != nil || strings.TrimSpace(token) == "" {
		token = uniuri.NewLen(64)
		if serr := config.NewAutomationServerConfig().SetLocalServerToken(token); serr != nil {
			return fmt.Errorf("failed to initialize authentication token: %w", serr)
		}
		fmt.Println("Generated a new automation-server authentication token")
	}
	s.token = token

	// One-time: migrate existing workspaces' compose from host bind mounts to
	// the named-volume subpath mounts (after the daemon's data volume migration).
	go s.migrateWorkspaceDeploymentsToVolumes()

	// Install all certificates from the registry into the daemon's certificate store
	if err := installAllCertificatesInDaemon(); err != nil {
		fmt.Printf("Warning: Failed to install certificates in daemon: %v\n", err)
	}

	// Ensure the socket directory exists
	if err := os.MkdirAll(SocketDir, 0755); err != nil {
		return fmt.Errorf("failed to create socket directory: %w", err)
	}

	// Remove existing socket file if it exists
	if err := os.Remove(SocketPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to remove existing socket: %w", err)
	}

	// Create Unix socket listener
	listener, err := net.Listen("unix", SocketPath)
	if err != nil {
		return fmt.Errorf("failed to create Unix socket listener: %w", err)
	}
	s.listener = listener

	// Set socket permissions to allow access
	if err := os.Chmod(SocketPath, 0666); err != nil {
		return fmt.Errorf("failed to set socket permissions: %w", err)
	}

	// Create HTTP server for Unix socket
	s.server = &http.Server{
		Handler: s.setupRoutes(),
	}

	// Create HTTP server for docs + Bailey gate pages (TCP port 8080).
	// The protected gate proxies bailey--inner.<domain> here, so the
	// gate's own pages (share, request-access, whoami) must be mounted
	// on this mux — they are what the wrap iframe shows on the Bailey
	// management hostname.
	//
	// SECURITY / STAGE-4 GAP (critical, known): handleBailey and
	// handleGatePathRoot below decide authorization entirely from the
	// request's X-Forwarded-* / X-Auth-Request-* identity headers (see
	// identityFromHeaders). This listener MUST therefore only ever be
	// reachable via the trusted oauth2-proxy/gate chain. Today it is NOT:
	// the listener is bound to all interfaces (net.Listen("tcp", ":8080")
	// below) on the shared bitswan_network, so any container — including
	// user-controlled workspace apps — can connect directly with forged
	// identity headers and impersonate an arbitrary user or admin. The
	// accepted fix is the stage-4 proxy split: bind this listener to
	// loopback / a non-routable daemon<->gate-only network so the gate is
	// the sole reachable path. It is NOT re-bound here because the ACME
	// DNS-01 bridge (acmeBridgePath, served on this same mux) and the
	// docs ingress are reached cross-container by docker DNS name
	// (bitswan-automation-server-daemon:8080); binding to 127.0.0.1
	// without the proxy split would break them. Partial mitigation lives
	// in the gate Director (startProtectedGate) which strips
	// client-supplied identity headers before proxying. TODO(stage-4):
	// split the bailey/gate handlers onto a loopback/internal-network-only
	// listener and route container-to-container calls through an
	// authenticated path.
	docsMux := http.NewServeMux()
	docsMux.HandleFunc(gatePathPrefix+"/", handleGatePathRoot)
	// Bailey management surface (JSON/API + favicon + static + sign-out).
	// The React Server Console (the HTML) is served by serveServerConsole
	// in chromeWrapMiddleware on the console inner host; these are the
	// data endpoints it fetches, proxied here through the gate.
	docsMux.HandleFunc("/bailey", s.handleBailey)
	docsMux.HandleFunc("/bailey/", s.handleBailey)
	docsMux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// "/" on the Bailey hostname is also the post-logout landing
		// page (Keycloak does exact redirect-URI matching). Until the
		// management UI ships (stage 3), send users to the share index.
		if isBaileyHost(requestEndpointHost(r)) {
			http.Redirect(w, r, gatePathPrefix+"/share", http.StatusFound)
			return
		}
		s.handleDocs(w, r)
	})
	docsMux.HandleFunc("/api-docs", s.handleDocs)

	// ACME DNS-01 bridge for Traefik's httpreq provider. Served on the TCP
	// listener so the Traefik container can reach it over bitswan_network;
	// protected by basic auth with the shared bridge secret.
	docsMux.HandleFunc(acmeBridgePath+"/present", s.handleACMEDNSChallenge("present"))
	docsMux.HandleFunc(acmeBridgePath+"/cleanup", s.handleACMEDNSChallenge("cleanup"))
	s.docsServer = &http.Server{
		Handler: docsMux,
	}

	// Start docs HTTP server on port 8080
	docsListener, err := net.Listen("tcp", fmt.Sprintf(":%d", docsPort))
	if err != nil {
		return fmt.Errorf("failed to create docs HTTP listener: %w", err)
	}
	s.docsListener = docsListener

	// Set up ingress route for docs (with retry logic)
	go func() {
		// Wait a bit for Caddy to be ready
		time.Sleep(2 * time.Second)
		maxRetries := 5
		for i := 0; i < maxRetries; i++ {
			if err := s.setupDocsIngress(); err == nil {
				fmt.Printf("Docs available at http://%s\n", docsHostname)
				break
			}
			if i < maxRetries-1 {
				time.Sleep(2 * time.Second)
			}
		}
	}()

	// Reconcile-drop self-heal: on EVERY startup re-push the saved Traefik
	// dynamic config (rest-state.json) to Traefik. The daemon's
	// protected_routes table + the REST state file are the source of truth,
	// but Traefik's REST provider holds its config in memory — so a daemon
	// recreate (or a Traefik restart) can leave Traefik missing every
	// workspace route while the records still say "in sync" (the ingress
	// reconcile compares the recorded upstream, not Traefik, so it skips
	// re-applying). InitTraefik (a no-op modifyState) re-pushes the full
	// saved state, so any restart/recreate self-heals instead of silently
	// dropping all routes. Best-effort with retry — Traefik may not be
	// reachable the instant the daemon boots.
	go func() {
		time.Sleep(2 * time.Second)
		for i := 0; i < 6; i++ {
			if err := traefikapi.InitTraefik(); err == nil {
				fmt.Println("Re-pushed saved Traefik dynamic config on startup")
				break
			} else if i == 5 {
				fmt.Printf("Warning: failed to re-push Traefik state on startup: %v\n", err)
			} else {
				time.Sleep(2 * time.Second)
			}
		}
	}()

	// Protected ingress: start the gate listener and register the
	// Bailey management hostname. Both are no-ops in practice until a
	// domain is configured and the bitswan-protected-proxy container
	// exists (see docs/protected_ingress.md), so this is safe on bare
	// servers.
	go func() {
		time.Sleep(3 * time.Second)
		if err := startProtectedGate(); err != nil {
			fmt.Printf("Warning: protected gate failed to start: %v\n", err)
		}
		setupBaileyRoutes()
	}()

	// Handle shutdown signals
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	// Start servers in goroutines
	errChan := make(chan error, 1)
	go func() {
		fmt.Printf("Automation server daemon listening on %s\n", SocketPath)
		fmt.Printf("Version: %s\n", s.version)
		if err := s.server.Serve(listener); err != nil && err != http.ErrServerClosed {
			errChan <- err
		}
	}()

	go func() {
		fmt.Printf("Docs server listening on :%d\n", docsPort)
		if err := s.docsServer.Serve(docsListener); err != nil && err != http.ErrServerClosed {
			errChan <- err
		}
	}()

	// Wait for shutdown signal or error
	select {
	case err := <-errChan:
		return err
	case sig := <-sigChan:
		fmt.Printf("\nReceived signal %v, shutting down...\n", sig)
	}

	// Graceful shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := s.server.Shutdown(ctx); err != nil {
		return fmt.Errorf("server shutdown error: %w", err)
	}

	if err := s.docsServer.Shutdown(ctx); err != nil {
		return fmt.Errorf("docs server shutdown error: %w", err)
	}

	// Clean up socket file
	os.Remove(SocketPath)

	fmt.Println("Server stopped")
	return nil
}
