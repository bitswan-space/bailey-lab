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
	"github.com/bitswan-space/bitswan-workspaces/internal/daemon/backup"
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
	// baileyServer serves the identity-trusting Bailey management + gate handlers
	// on a LOOPBACK-only listener (issue #183), reachable only via the in-process
	// gate — never directly from another container on the shared network.
	baileyServer   *http.Server
	baileyListener net.Listener
	token          string

	// initConfirmCh is used to signal that the user has confirmed the SSH key prompt
	// during workspace init. The daemon blocks until a value is sent on this channel.
	initConfirmMu sync.Mutex
	initConfirmCh chan struct{}

	// relayMu guards relayStarted so the reverse-proxy tunnel is launched at
	// most once, whether triggered at daemon startup or by register after the
	// AOC provisions the proxy path.
	relayMu      sync.Mutex
	relayStarted bool

	// serverUpdateMu serializes browser-driven server self-updates so two admins
	// can't race on the download/swap at once (TryLock → reject the second).
	serverUpdateMu sync.Mutex

	// backupEngine serializes server-level backup runs (nightly scheduler vs
	// run-now) — see internal/daemon/backup.
	backupEngine backup.Engine
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
	s := &Server{
		version:   version,
		startTime: time.Now(),
	}
	// The backup engine stamps the binary version into the server manifest so a
	// recovery can warn about version skew, and calls back for the manifest
	// itself (which needs workspace/route/image data only this package has).
	s.backupEngine.Version = version
	s.backupEngine.ManifestBuilder = s.buildServerManifest
	return s
}

// authMiddleware wraps a handler with bearer token authentication.
// Requests arriving over the Unix socket (RemoteAddr is empty or "@")
// are trusted and skip token verification — access is gated by the
// socket file permissions.
//
// CAUTION: that trust is coarse. The socket dir is bind-mounted into every
// workspace's gitops and infra-driver container (they call /ingress/*,
// /memory/admit, /bailey/role over it), so "came in via the socket" only
// means "some workspace container or host process" — NOT "host admin".
// Handlers that return secrets must therefore add their own proof on top;
// see callerHasAdminToken (workspace_secrets_auth.go) and its use in
// handleWorkspaceList for passwords=true (#128).
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

	// Start the reverse-proxy tunnel on demand (register calls this once the
	// AOC has provisioned the proxy path).
	mux.HandleFunc("/relay/start", s.authMiddleware(s.handleRelayStart))

	// Verify the public endpoint is reachable, publicly trusted, and serving
	// our own certificate (register polls this before printing the URL).
	mux.HandleFunc("/relay/verify", s.authMiddleware(s.handleRelayVerify))

	// Service endpoints (authenticated)
	mux.HandleFunc("/service", s.authMiddleware(s.handleService))
	mux.HandleFunc("/service/", s.authMiddleware(s.handleService))

	// Job endpoints for interactive operations (authenticated)
	mux.HandleFunc("/jobs", s.authMiddleware(s.handleJobs))
	mux.HandleFunc("/jobs/", s.authMiddleware(s.handleJobs))

	// Server-level backup endpoints (authenticated; key/snapshot access
	// additionally demands the admin token — see backup_api.go).
	mux.HandleFunc("/backup/", s.authMiddleware(s.handleBackup))

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

	// Bailey auditor/admin roster (authenticated; socket-trusted). Lets gitops
	// (for the dashboard's Audits panel) list the users a normal member can ask
	// to review a production promotion. Read-only.
	mux.HandleFunc("/bailey/auditors", s.authMiddleware(s.handleWorkspaceAuditors))

	// Memory admission (trusted, socket-auth): gitops calls this to gate a
	// promote against the reserved budget before deploying.
	mux.HandleFunc("/memory/admit", s.authMiddleware(s.handleMemoryAdmit))

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
	// SECURITY / STAGE-4 SPLIT (issue #183 / BSY-05, done): handleBailey and
	// handleGatePathRoot decide authorization entirely from the request's
	// X-Forwarded-* / X-Auth-Request-* identity headers (see identityFromHeaders),
	// so they MUST only ever be reachable via the trusted oauth2-proxy/gate chain.
	// They are therefore served on a SEPARATE loopback-only listener
	// (127.0.0.1:baileyGatePort, gateMux) that no other container on the shared
	// bitswan_network can reach — the in-process gate is the sole path in, and it
	// strips any client-supplied identity headers before proxying (gateDirector).
	// The cross-container endpoints that don't trust identity — the ACME DNS-01
	// bridge (basic-auth) and the docs — stay on the network :8080 listener
	// (docsMux) so Traefik and the docs ingress keep reaching them by container
	// name, which is why we couldn't simply re-bind the single old listener to
	// loopback. When the gate later moves to its own unprivileged container, it
	// reaches this listener via BAILEY_DAEMON_HOST instead of localhost.
	// gateMux — the identity-trusting Bailey management + gate handlers
	// (handleBailey, handleGatePathRoot decide authorization from the request's
	// X-Forwarded-* identity, see identityFromHeaders). It is served ONLY on the
	// loopback listener below (127.0.0.1:baileyGatePort), so the sole reachable
	// path is the in-process gate (startProtectedGate), which proxies the
	// bailey/onboard inner hosts here (upstreamForHost → localhost:baileyGatePort
	// after the trusted oauth2-proxy hop). A peer on bitswan_network can no
	// longer connect directly with forged identity headers.
	gateMux := http.NewServeMux()
	gateMux.HandleFunc(gatePathPrefix+"/", handleGatePathRoot)
	// Bailey management surface (JSON/API + favicon + static + sign-out).
	// The React Server Console (the HTML) is served by serveServerConsole
	// in chromeWrapMiddleware on the console inner host; these are the
	// data endpoints it fetches, proxied here through the gate.
	gateMux.HandleFunc("/bailey", s.handleBailey)
	gateMux.HandleFunc("/bailey/", s.handleBailey)
	gateMux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// "/" on the Bailey hostname is also the post-logout landing
		// page (Keycloak does exact redirect-URI matching). Until the
		// management UI ships (stage 3), send users to the share index.
		if isBaileyHost(requestEndpointHost(r)) {
			http.Redirect(w, r, gatePathPrefix+"/share", http.StatusFound)
			return
		}
		s.handleDocs(w, r)
	})

	// docsMux — the endpoints legitimately reached CROSS-CONTAINER without any
	// identity trust: the API docs and the ACME DNS-01 bridge. These stay on the
	// network :8080 listener so Traefik (httpreq provider) and the docs ingress
	// keep reaching them by container name. No identity-trusting handler lives
	// here anymore (issue #183 / BSY-05, the stage-4 split): a peer that connects
	// straight to :8080 can hit only docs + the basic-auth'd ACME bridge, never
	// /bailey or the gate pages.
	docsMux := http.NewServeMux()
	docsMux.HandleFunc("/api-docs", s.handleDocs)
	docsMux.HandleFunc("/", s.handleDocs)
	// ACME DNS-01 bridge for Traefik's httpreq provider. Served on the TCP
	// listener so the Traefik container can reach it over bitswan_network;
	// protected by basic auth with the shared bridge secret.
	docsMux.HandleFunc(acmeBridgePath+"/present", s.handleACMEDNSChallenge("present"))
	docsMux.HandleFunc(acmeBridgePath+"/cleanup", s.handleACMEDNSChallenge("cleanup"))
	// Published public endpoints, for the dashboard's "Open app" PUBLIC badge (#220).
	docsMux.HandleFunc("/public-endpoints", s.handlePublicEndpointsList)

	s.baileyServer = &http.Server{Handler: gateMux}
	s.docsServer = &http.Server{
		Handler: docsMux,
	}

	// Start docs HTTP server on port 8080
	docsListener, err := net.Listen("tcp", fmt.Sprintf(":%d", docsPort))
	if err != nil {
		return fmt.Errorf("failed to create docs HTTP listener: %w", err)
	}
	s.docsListener = docsListener

	// Loopback-only listener for the identity-trusting Bailey management + gate
	// handlers (issue #183 / BSY-05): reachable solely by the in-process gate,
	// never by another container on the shared bitswan_network.
	baileyListener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", baileyGatePort))
	if err != nil {
		return fmt.Errorf("failed to create bailey gate HTTP listener: %w", err)
	}
	s.baileyListener = baileyListener

	// Set up ingress route for docs (with retry logic)
	go func() {
		// Wait a bit for the ingress to be ready
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

	// Pin the source-IP allowlist every workspace sub-traefik enforces on its
	// routes BEFORE any route is (re)written below: the sub-traefik multi-homes
	// onto all stage bridges to reach upstreams, so only the gate's network
	// (bitswan_network) may reach it — a stage-network peer routing a cross-stage
	// Host is rejected (finding C1). Synchronous + resolved from the live network.
	traefikapi.SetIngressAllowCIDRs(bitswanNetworkAllowCIDRs())

	// One-time migration: apply that ACL to workspaces whose sub-traefik routes
	// predate it (their routers have no middleware yet). Backgrounded — it reads
	// files + repushes routes — and self-skips once applied, so it's a no-op on
	// every subsequent boot. Small delay so the sub-traefiks are up first.
	go func() {
		time.Sleep(5 * time.Second)
		reapplyWorkspaceIngressACLs()
	}()

	// Ensure the global Traefik is on the CURRENT config on startup — not just a
	// dynamic.yml re-render. Re-rendering routes (InitTraefik) is not enough when
	// the daemon UPGRADE changed Traefik's STATIC config: e.g. adding the file
	// provider's `watch: true`. A Traefik created by an older daemon keeps its
	// old static config across restarts (the init used to only run on first
	// setup), so without `watch` it loads dynamic.yml once and never reloads —
	// every route added afterwards (a fresh live-dev frontend) lands in the file
	// but never reaches Traefik, and the public URL 404s. initTraefikIngress is a
	// no-op when the static config already matches and recreates Traefik only on
	// drift, after which it re-renders the dynamic routes itself. Best-effort
	// with retry.
	go func() {
		time.Sleep(2 * time.Second)
		for i := 0; i < 6; i++ {
			if _, err := initTraefikIngress(false); err == nil {
				fmt.Println("Ensured Traefik is on the current static config + routes on startup")
				break
			} else if i == 5 {
				fmt.Printf("Warning: failed to ensure Traefik config on startup: %v\n", err)
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

	// Memory governance sweep: every 5 minutes shed the oldest on-demand
	// instances that push the on-demand pool over budget, and emit over-reservation
	// SIEM events. Always-on services are never touched; evicted ones wake on access.
	go func() {
		t := time.NewTicker(5 * time.Minute)
		defer t.Stop()
		for range t.C {
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
			s.enforceMemoryBudget(ctx)
			cancel()
		}
	}()

	// Self-heal daemon-owned sidecars: if a coding-agent/dashboard container was
	// left down by a restart that interrupted its start (e.g. the server
	// self-update's `docker restart` landing mid-`compose up`), bring it back —
	// once now, then resync periodically. Backgrounded so startup never blocks
	// on Docker; idempotent for anything already running (see
	// service_reconcile.go).
	go startServiceReconciler()

	// Bring an already-running protected-proxy up to the current config if it's
	// stale — e.g. one provisioned before the CSRF per-request cap, which
	// otherwise lets _oauth2_proxy_*_csrf cookies pile up until requests 431. A
	// daemon update never re-provisions the proxy on its own; this closes that
	// gap on boot. Backgrounded + best-effort (see protected_proxy_reconcile.go).
	go reconcileProtectedProxyConfig()

	// Own the shared grype vulnerability DB: create its volume now, download it
	// in the background, and refresh daily. Keeps the ~40s DB download off every
	// workspace's first interactive CVE scan (see grype_db.go).
	startGrypeDBRefresher()

	// Nightly server-level backups (whole workspace trees incl. secrets +
	// DB dumps + server state → one restic repo per server via AOC). Self-
	// enables on AOC-registered servers; catch-up run when the last one is
	// stale (see backup_scheduler.go).
	s.startBackupScheduler(&s.backupEngine)

	// Own the shared read-through build proxies (Go module + npm) so per-BP image
	// builds pull common packages from a warm, persistent, cross-workspace cache
	// instead of the internet (see build_proxy.go). No-op if externally managed.
	startBuildProxies()

	// If this server is on the AOC reverse-proxy path (NAT'd or --force-proxy),
	// keep an outbound tunnel to the relay so the public URL reaches us. No-op
	// otherwise.
	s.startRelayTunnel()

	// Re-assert published public endpoints (issue #220): warm the gate's
	// public-host cache and re-register each public host's traefik route so a
	// restart restores public serving. Idempotent; no-op when none are set.
	reapplyPublicEndpoints()

	// Paranoid end-to-end-TLS self-check for EVERY server with a public domain
	// (proxied or directly-addressed): confirm the certificate the world is
	// served is our own, so any TLS interception in transit is caught and
	// surfaced loudly. No-op on unregistered / domain-less servers.
	s.startEndpointTLSSelfCheck()

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

	go func() {
		fmt.Printf("Bailey management (gate-only) server listening on 127.0.0.1:%d\n", baileyGatePort)
		if err := s.baileyServer.Serve(baileyListener); err != nil && err != http.ErrServerClosed {
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

	if s.baileyServer != nil {
		if err := s.baileyServer.Shutdown(ctx); err != nil {
			return fmt.Errorf("bailey gate server shutdown error: %w", err)
		}
	}

	// Clean up socket file
	os.Remove(SocketPath)

	fmt.Println("Server stopped")
	return nil
}
