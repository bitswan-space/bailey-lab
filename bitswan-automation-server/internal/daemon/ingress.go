package daemon

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"net/url"

	"github.com/bitswan-space/bitswan-workspaces/internal/caddyapi"
	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/dockercompose"
	"github.com/bitswan-space/bitswan-workspaces/internal/traefikapi"
	"github.com/bitswan-space/bitswan-workspaces/internal/util"
)

// IngressType represents which ingress proxy is in use
type IngressType string

const (
	IngressCaddy   IngressType = "caddy"
	IngressTraefik IngressType = "traefik"
)

// IngressInitRequest represents the request to initialize ingress
type IngressInitRequest struct {
	Verbose     bool   `json:"verbose"`
	IngressType string `json:"ingress_type,omitempty"` // "caddy" or "traefik" (default: auto-detect)
}

// IngressInitResponse represents the response from initializing ingress
type IngressInitResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

// IngressAddRouteRequest represents the request to add a route
type IngressAddRouteRequest struct {
	Hostname      string `json:"hostname"`
	Upstream      string `json:"upstream"`
	Mkcert        bool   `json:"mkcert"`
	CertsDir      string `json:"certs_dir,omitempty"`
	Secret        string `json:"secret,omitempty"`
	WorkspaceName string `json:"workspace_name,omitempty"`
	// OwnerEmail is the deployer's email — the user whose action caused
	// this route to be registered. When set, the daemon records the
	// hostname in the Bailey ACL with this user as the original owner,
	// so the endpoint is access-controlled and shareable from the
	// moment it exists. Empty means the caller doesn't know who the
	// deployer is (e.g. server-internal routes registered at boot); the
	// endpoint then stays open until something registers an owner.
	OwnerEmail string `json:"owner_email,omitempty"`
	// DisplayName is a friendly label for the endpoint shown in Bailey
	// UIs. If empty, the hostname is used.
	DisplayName string `json:"display_name,omitempty"`
	// ParentEndpoint is the hostname of the endpoint this route's
	// Bailey ACL delegates membership to — for workspace-spawned routes
	// that's the workspace dashboard. When empty, the daemon resolves
	// it from the workspace's recorded metadata (dashboard-url).
	ParentEndpoint string `json:"parent_endpoint,omitempty"`
	// Kind classifies the endpoint for the Bailey launcher: "frontend"
	// (an exposed business-process app), "service" (gitops/editor and other
	// infrastructure), or "workspace". Callers pass it as explicit data —
	// e.g. gitops marks exposed automations "frontend" and everything else
	// "service". The daemon overrides it to "workspace" for a route that
	// resolves to a top-level (parentless) dashboard. Empty is treated as
	// "service" for parented routes.
	Kind string `json:"kind,omitempty"`
	// Stage is the deployment stage of the backing automation ("production",
	// "staging", "dev", "live-dev"). Explicit data — stored on the endpoint so
	// launcher/admin views can filter (e.g. only production frontends).
	Stage string `json:"stage,omitempty"`
}

// IngressAddRouteResponse represents the response from adding a route
type IngressAddRouteResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

// IngressReconcileRequest is the declarative ingress apply: the COMPLETE set of
// gitops-managed routes a workspace should have. The daemon converges to it —
// upserts each route (marking it source='gitops'), then prunes any gitops route
// for the workspace that is NOT in the set. Manual routes are never touched.
// This is the "kubectl apply" of ingress: re-sending the same set is a no-op.
type IngressReconcileRequest struct {
	WorkspaceName string                   `json:"workspace_name"`
	Routes        []IngressAddRouteRequest `json:"routes"`
}

// IngressReconcileResponse reports what converging did.
type IngressReconcileResponse struct {
	Success  bool     `json:"success"`
	Applied  int      `json:"applied"`
	Pruned   []string `json:"pruned"`
	Warnings []string `json:"warnings,omitempty"`
}

// IngressListRoutesResponse represents the response from listing routes
type IngressListRoutesResponse struct {
	Routes []RouteInfo `json:"routes"`
}

// RouteInfo represents simplified route information
type RouteInfo struct {
	ID       string `json:"id"`
	Hostname string `json:"hostname"`
	Upstream string `json:"upstream"`
	Terminal bool   `json:"terminal"`
}

// IngressRemoveRouteResponse represents the response from removing a route
type IngressRemoveRouteResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

// DetectIngressType checks which ingress proxy is currently running.
// Returns IngressTraefik if Traefik is running, IngressCaddy if Caddy is running.
// If neither is running, returns IngressTraefik (default for new installs).
func DetectIngressType() IngressType {
	// Check for Traefik container
	traefikId, err := exec.Command("docker", "ps", "-q", "-f", "name=^traefik$").Output()
	if err == nil && strings.TrimSpace(string(traefikId)) != "" {
		return IngressTraefik
	}

	// Check for Caddy container
	caddyId, err := exec.Command("docker", "ps", "-q", "-f", "name=^caddy$").Output()
	if err == nil && strings.TrimSpace(string(caddyId)) != "" {
		return IngressCaddy
	}

	// Neither running — default to Traefik for new installs
	return IngressTraefik
}

// handleIngress routes ingress-related requests
func (s *Server) handleIngress(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/ingress")
	path = strings.TrimPrefix(path, "/")

	switch {
	case path == "init":
		s.handleIngressInit(w, r)
	case path == "add-route":
		s.handleIngressAddRoute(w, r)
	case path == "repoint-route":
		s.handleIngressRepointRoute(w, r)
	case path == "reconcile":
		s.handleIngressReconcile(w, r)
	case path == "list-routes":
		s.handleIngressListRoutes(w, r)
	case strings.HasPrefix(path, "remove-route/"):
		hostname := strings.TrimPrefix(path, "remove-route/")
		s.handleIngressRemoveRoute(w, r, hostname)
	case path == "type":
		s.handleIngressType(w, r)
	case path == "migrate":
		s.handleIngressMigrate(w, r)
	case path == "update":
		s.handleIngressUpdate(w, r)
	case path == "provision-protected-proxy":
		s.handleIngressProvisionProtectedProxy(w, r)
	default:
		writeJSONError(w, "not found", http.StatusNotFound)
	}
}

// handleIngressType handles GET /ingress/type — returns the current ingress type
func (s *Server) handleIngressType(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"type": string(DetectIngressType())})
}

// handleIngressMigrate handles POST /ingress/migrate — migrates from Caddy to Traefik
func (s *Server) handleIngressMigrate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Verbose bool `json:"verbose"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	if err := MigrateCaddyToTraefik(req.Verbose); err != nil {
		writeJSONError(w, "migration failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "Successfully migrated from Caddy to Traefik",
	})
}

// handleIngressUpdate handles POST /ingress/update — updates the ingress proxy to the latest version
func (s *Server) handleIngressUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Verbose bool `json:"verbose"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	if err := UpdateIngress(req.Verbose); err != nil {
		writeJSONError(w, "update failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "Successfully updated ingress proxy",
	})
}

// handleIngressInit handles POST /ingress/init
func (s *Server) handleIngressInit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req IngressInitRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}

	// If ingress_type is specified, set it as env var for initIngress
	if req.IngressType != "" {
		os.Setenv("BITSWAN_INGRESS_TYPE", req.IngressType)
		defer os.Unsetenv("BITSWAN_INGRESS_TYPE")
	}

	newlyInitialized, err := initIngress(req.Verbose)
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	var message string
	if newlyInitialized {
		message = "Ingress proxy is ready!"
	} else {
		message = "Ingress proxy is already initialized."
	}
	json.NewEncoder(w).Encode(IngressInitResponse{
		Success: true,
		Message: message,
	})
}

// initIngress initializes the ingress proxy.
// It first checks if an existing ingress (Caddy or Traefik) is already running.
// For new installs, it starts Traefik (unless BITSWAN_INGRESS_TYPE=caddy).
func initIngress(verbose bool) (bool, error) {
	ingressType := DetectIngressType()

	switch ingressType {
	case IngressCaddy:
		// Caddy is already running, keep using it
		return false, nil
	case IngressTraefik:
		// Check if Traefik is already running and functional
		if err := traefikapi.InitTraefik(); err == nil {
			return false, nil
		}
		// Nothing running — check if user wants to force Caddy
		if strings.EqualFold(os.Getenv("BITSWAN_INGRESS_TYPE"), "caddy") {
			return initCaddyIngress(verbose)
		}
		// Default: start Traefik
		return initTraefikIngress(verbose)
	}

	return false, fmt.Errorf("unknown ingress type")
}

// initCaddyIngress starts a new Caddy ingress proxy.
func initCaddyIngress(verbose bool) (bool, error) {
	homeDir := os.Getenv("HOME")
	bitswanConfig := homeDir + "/.config/bitswan/"
	caddyConfig := bitswanConfig + "caddy"
	caddyCertsDir := caddyConfig + "/certs"

	caddyProjectName := "bitswan-caddy"

	// If caddy container already exists, return
	caddyContainerId, err := exec.Command("docker", "ps", "-q", "-f", "name=caddy").Output()
	if err != nil {
		return false, fmt.Errorf("failed to check if caddy container exists: %w", err)
	}
	if strings.TrimSpace(string(caddyContainerId)) != "" {
		return false, nil
	}

	if err := os.MkdirAll(bitswanConfig, 0755); err != nil {
		return false, fmt.Errorf("failed to create bitswan config directory: %w", err)
	}
	if err := os.MkdirAll(caddyConfig, 0755); err != nil {
		return false, fmt.Errorf("failed to create ingress config directory: %w", err)
	}

	caddyfile := `
		{
			email info@bitswan.space
			admin 0.0.0.0:2019
		}`

	caddyfilePath := caddyConfig + "/Caddyfile"
	if err := os.WriteFile(caddyfilePath, []byte(caddyfile), 0755); err != nil {
		return false, fmt.Errorf("failed to write Caddyfile: %w", err)
	}

	hostHomeDir := os.Getenv("HOST_HOME")
	caddyConfigForCompose := caddyConfig
	if hostHomeDir != "" && homeDir != hostHomeDir && strings.HasPrefix(caddyConfig, homeDir) {
		caddyConfigForCompose = strings.Replace(caddyConfig, homeDir, hostHomeDir, 1)

		if err := os.MkdirAll(caddyConfigForCompose, 0755); err != nil {
			return false, fmt.Errorf("failed to create ingress config directory on host: %w", err)
		}
		if err := os.MkdirAll(caddyConfigForCompose+"/data", 0755); err != nil {
			return false, fmt.Errorf("failed to create ingress data directory on host: %w", err)
		}
		if err := os.MkdirAll(caddyConfigForCompose+"/config", 0755); err != nil {
			return false, fmt.Errorf("failed to create ingress config subdirectory on host: %w", err)
		}
		if err := os.MkdirAll(caddyConfigForCompose+"/certs", 0755); err != nil {
			return false, fmt.Errorf("failed to create ingress certs directory on host: %w", err)
		}

		caddyfilePathHost := caddyConfigForCompose + "/Caddyfile"
		if _, err := os.Stat(caddyfilePathHost); os.IsNotExist(err) {
			if err := os.WriteFile(caddyfilePathHost, []byte(caddyfile), 0755); err != nil {
				return false, fmt.Errorf("failed to write Caddyfile on host: %w", err)
			}
		}
	}

	caddyDockerCompose, err := dockercompose.CreateCaddyDockerComposeFile(caddyConfigForCompose)
	if err != nil {
		return false, fmt.Errorf("failed to create ingress docker-compose file: %w", err)
	}

	caddyDockerComposePath := caddyConfig + "/docker-compose.yml"
	if err := os.WriteFile(caddyDockerComposePath, []byte(caddyDockerCompose), 0755); err != nil {
		return false, fmt.Errorf("failed to write ingress docker-compose file: %w", err)
	}

	caddyDockerComposeCom := exec.Command("docker", "compose", "-p", caddyProjectName, "up", "-d")
	caddyDockerComposeCom.Dir = caddyConfig

	if _, err := os.Stat(caddyCertsDir); os.IsNotExist(err) {
		if err := os.MkdirAll(caddyCertsDir, 0740); err != nil {
			return false, fmt.Errorf("failed to create ingress certs directory: %w", err)
		}
	}

	if err := util.RunCommandVerbose(caddyDockerComposeCom, verbose); err != nil {
		return false, fmt.Errorf("failed to start ingress: %w", err)
	}

	time.Sleep(5 * time.Second)
	if err := caddyapi.InitCaddy(); err != nil {
		return false, fmt.Errorf("failed to init ingress: %w", err)
	}

	return true, nil
}

// renderTraefikStaticConfig renders the global Traefik static configuration.
// When dnsChallenge is true, an additional cert resolver is included that
// issues certificates via the ACME DNS-01 challenge using lego's httpreq
// provider (pointed at the daemon's AOC bridge through HTTPREQ_* env vars in
// the Traefik container) — used for wildcard certificates, which HTTP-01
// cannot issue.
// traefikDynamicConfig is loaded by the file provider (see
// renderTraefikStaticConfig). It forces the TLS edge to negotiate HTTP/1.1
// only. The protected-ingress upstream chain (oauth2-proxy -> bailey gate ->
// app) is HTTP/1.1 and cannot carry RFC 8441 WebSocket-over-HTTP/2, so if the
// edge offered h2 the browser would open h2 websockets whose upgrade Traefik
// can't bridge to the h1 chain — breaking the dashboard's coding-agent
// terminal and the vite HMR sockets. Offering only http/1.1 in ALPN makes
// browsers use HTTP/1.1 websocket upgrades, which the chain carries. The h2
// multiplexing given up is irrelevant for these internal dev surfaces.
const traefikDynamicConfig = `tls:
  options:
    default:
      alpnProtocols:
        - http/1.1
`

func renderTraefikStaticConfig(acmeEmail string, dnsChallenge bool) string {
	cfg := fmt.Sprintf(`entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
api:
  insecure: true
providers:
  file:
    filename: /etc/traefik/dynamic.yml
  rest:
    insecure: true
  docker:
    exposedByDefault: false
    network: bitswan_network
certificatesResolvers:
  letsencrypt:
    acme:
      email: %s
      storage: /acme/acme.json
      httpChallenge:
        entryPoint: web
`, acmeEmail)

	if dnsChallenge {
		cfg += fmt.Sprintf(`  %s:
    acme:
      email: %s
      storage: /acme/acme-dns.json
      dnsChallenge:
        provider: httpreq
`, dnsCertResolverName, acmeEmail)
	}

	return cfg
}

// initTraefikIngress starts a new Traefik ingress proxy, or reconfigures a
// running one when the desired configuration has changed (e.g. the
// automation server registered with the AOC and was assigned a domain, so
// Traefik must be told to obtain a DNS-01 wildcard certificate).
func initTraefikIngress(verbose bool) (bool, error) {
	homeDir := os.Getenv("HOME")
	bitswanConfig := homeDir + "/.config/bitswan/"
	traefikConfig := bitswanConfig + "traefik"
	traefikCertsDir := traefikConfig + "/certs"

	traefikProjectName := "bitswan-traefik"

	if err := os.MkdirAll(bitswanConfig, 0755); err != nil {
		return false, fmt.Errorf("failed to create bitswan config directory: %w", err)
	}
	if err := os.MkdirAll(traefikConfig, 0755); err != nil {
		return false, fmt.Errorf("failed to create ingress config directory: %w", err)
	}

	// Create acme directory for Let's Encrypt certificate storage
	acmeDir := traefikConfig + "/acme"
	if err := os.MkdirAll(acmeDir, 0700); err != nil {
		return false, fmt.Errorf("failed to create acme directory: %w", err)
	}

	acmeEmail := os.Getenv("BITSWAN_ACME_EMAIL")
	if acmeEmail == "" {
		acmeEmail = "noreply@bitswan.space"
	}

	// When the AOC has assigned this automation server a domain, configure a
	// DNS-01 cert resolver so Traefik can obtain a *.<domain> wildcard
	// certificate. Traefik's httpreq provider authenticates against the
	// daemon's bridge endpoints with basic auth using a shared secret.
	wildcardDomain := getWildcardCertDomain()
	var traefikEnv map[string]string
	if wildcardDomain != "" {
		secret, err := getOrCreateACMEBridgeSecret(traefikConfig)
		if err != nil {
			return false, err
		}
		traefikEnv = map[string]string{
			"HTTPREQ_ENDPOINT": acmeBridgeEndpoint(),
			"HTTPREQ_USERNAME": acmeBridgeUsername,
			"HTTPREQ_PASSWORD": secret,
		}
	}

	traefikStaticConfig := renderTraefikStaticConfig(acmeEmail, wildcardDomain != "")

	hostHomeDir := os.Getenv("HOST_HOME")
	traefikConfigForCompose := traefikConfig
	if hostHomeDir != "" && homeDir != hostHomeDir && strings.HasPrefix(traefikConfig, homeDir) {
		traefikConfigForCompose = strings.Replace(traefikConfig, homeDir, hostHomeDir, 1)

		if err := os.MkdirAll(traefikConfigForCompose, 0755); err != nil {
			return false, fmt.Errorf("failed to create ingress config directory on host: %w", err)
		}
		if err := os.MkdirAll(traefikConfigForCompose+"/certs", 0755); err != nil {
			return false, fmt.Errorf("failed to create ingress certs directory on host: %w", err)
		}
		if err := os.MkdirAll(traefikConfigForCompose+"/acme", 0700); err != nil {
			return false, fmt.Errorf("failed to create ingress acme directory on host: %w", err)
		}
	}

	traefikDockerCompose, err := dockercompose.CreateTraefikDockerComposeFile(traefikConfigForCompose, traefikEnv)
	if err != nil {
		return false, fmt.Errorf("failed to create ingress docker-compose file: %w", err)
	}

	traefikConfigFilePath := traefikConfig + "/traefik.yml"
	traefikDockerComposePath := traefikConfig + "/docker-compose.yml"

	// Check if Traefik is already running with REST provider support and
	// matching configuration — nothing to do then. If the configuration has
	// drifted (e.g. the DNS-01 resolver was just enabled), fall through and
	// recreate the container; InitTraefik re-pushes the saved routes after.
	if err := traefikapi.InitTraefik(); err == nil {
		currentConfig, _ := os.ReadFile(traefikConfigFilePath)
		currentCompose, _ := os.ReadFile(traefikDockerComposePath)
		if string(currentConfig) == traefikStaticConfig && string(currentCompose) == traefikDockerCompose {
			return false, nil
		}
		if verbose {
			fmt.Println("Traefik configuration changed — restarting Traefik to apply it...")
		}
	}

	// Traefik is not running, lacks REST provider support, or has stale
	// configuration. Stop and remove any existing container named "traefik"
	// so we can start a fresh one. The filter is anchored so workspace
	// sub-traefik containers ({ws}__traefik) are not matched.
	existingIdBytes, _ := exec.Command("docker", "ps", "-q", "-f", "name=^traefik$").Output()
	if existingId := strings.TrimSpace(string(existingIdBytes)); existingId != "" {
		exec.Command("docker", "stop", existingId).Run()
		exec.Command("docker", "rm", existingId).Run()
	}

	if err := os.WriteFile(traefikConfigFilePath, []byte(traefikStaticConfig), 0755); err != nil {
		return false, fmt.Errorf("failed to write traefik.yml: %w", err)
	}
	// Dynamic config (TLS ALPN = http/1.1) loaded by the file provider.
	if err := os.WriteFile(traefikConfig+"/dynamic.yml", []byte(traefikDynamicConfig), 0644); err != nil {
		return false, fmt.Errorf("failed to write traefik dynamic.yml: %w", err)
	}
	if traefikConfigForCompose != traefikConfig {
		traefikConfigFilePathHost := traefikConfigForCompose + "/traefik.yml"
		if err := os.WriteFile(traefikConfigFilePathHost, []byte(traefikStaticConfig), 0755); err != nil {
			return false, fmt.Errorf("failed to write traefik.yml on host: %w", err)
		}
		if err := os.WriteFile(traefikConfigForCompose+"/dynamic.yml", []byte(traefikDynamicConfig), 0644); err != nil {
			return false, fmt.Errorf("failed to write traefik dynamic.yml on host: %w", err)
		}
	}

	// 0600: when the DNS-01 resolver is enabled, the compose file carries the
	// ACME bridge secret in the traefik service environment.
	if err := os.WriteFile(traefikDockerComposePath, []byte(traefikDockerCompose), 0600); err != nil {
		return false, fmt.Errorf("failed to write ingress docker-compose file: %w", err)
	}
	if err := os.Chmod(traefikDockerComposePath, 0600); err != nil {
		return false, fmt.Errorf("failed to set ingress docker-compose file permissions: %w", err)
	}

	traefikDockerComposeCom := exec.Command("docker", "compose", "-p", traefikProjectName, "up", "-d")
	traefikDockerComposeCom.Dir = traefikConfig

	if _, err := os.Stat(traefikCertsDir); os.IsNotExist(err) {
		if err := os.MkdirAll(traefikCertsDir, 0740); err != nil {
			return false, fmt.Errorf("failed to create ingress certs directory: %w", err)
		}
	}

	if err := util.RunCommandVerbose(traefikDockerComposeCom, verbose); err != nil {
		return false, fmt.Errorf("failed to start ingress: %w", err)
	}

	time.Sleep(5 * time.Second)
	// InitTraefik pushes the saved dynamic config (rest-state.json) back to
	// the REST provider, restoring all routes after the restart.
	if err := traefikapi.InitTraefik(); err != nil {
		return false, fmt.Errorf("failed to init ingress: %w", err)
	}

	// Switch any existing ACME routes under the wildcard domain to the
	// shared wildcard certificate.
	if wildcardDomain != "" {
		if err := traefikapi.ApplyWildcardCertResolver(wildcardDomain, dnsCertResolverName); err != nil {
			fmt.Printf("Warning: failed to apply wildcard cert resolver to existing routes: %v\n", err)
		}
	}

	return true, nil
}

// initWorkspaceTraefik initializes a traefik proxy for a workspace.
func initWorkspaceTraefik(workspaceName, domain string, verbose bool) (bool, error) {
	homeDir := os.Getenv("HOME")
	workspaceConfig := fmt.Sprintf("%s/.config/bitswan/workspaces/%s", homeDir, workspaceName)
	traefikConfig := workspaceConfig + "/traefik"

	traefikProjectName := fmt.Sprintf("bitswan-%s-traefik", workspaceName)
	containerName := fmt.Sprintf("%s__traefik", workspaceName)

	// Check if workspace traefik container already exists
	traefikContainerId, err := exec.Command("docker", "ps", "-q", "-f", fmt.Sprintf("name=%s", containerName)).Output()
	if err != nil {
		return false, fmt.Errorf("failed to check if workspace traefik container exists: %w", err)
	}
	if strings.TrimSpace(string(traefikContainerId)) != "" {
		return false, nil
	}

	// Create workspace traefik config directory
	if err := os.MkdirAll(traefikConfig, 0755); err != nil {
		return false, fmt.Errorf("failed to create workspace traefik config directory: %w", err)
	}

	// Traefik static config enabling REST provider and web entrypoint (HTTP only for workspace)
	traefikStaticConfig := `entryPoints:
  web:
    address: ":80"
api:
  insecure: true
providers:
  rest:
    insecure: true
`

	traefikConfigFilePath := traefikConfig + "/traefik.yml"
	if err := os.WriteFile(traefikConfigFilePath, []byte(traefikStaticConfig), 0755); err != nil {
		return false, fmt.Errorf("failed to write workspace traefik.yml: %w", err)
	}

	// For docker-compose, use HOST_HOME if available
	hostHomeDir := os.Getenv("HOST_HOME")
	traefikConfigForCompose := traefikConfig
	if hostHomeDir != "" && homeDir != hostHomeDir && strings.HasPrefix(traefikConfig, homeDir) {
		traefikConfigForCompose = strings.Replace(traefikConfig, homeDir, hostHomeDir, 1)

		if err := os.MkdirAll(traefikConfigForCompose, 0755); err != nil {
			return false, fmt.Errorf("failed to create workspace traefik config directory on host: %w", err)
		}

		traefikConfigFilePathHost := traefikConfigForCompose + "/traefik.yml"
		if _, err := os.Stat(traefikConfigFilePathHost); os.IsNotExist(err) {
			if err := os.WriteFile(traefikConfigFilePathHost, []byte(traefikStaticConfig), 0755); err != nil {
				return false, fmt.Errorf("failed to write workspace traefik.yml on host: %w", err)
			}
		}
	}

	// Use the shared wildcard certificate when the workspace domain is the
	// automation server's AOC-assigned domain — sub-traefik hostnames are
	// {workspace}-{service}.{domain}, exactly one level under it.
	wildcardResolver := ""
	if wildcardDomain := getWildcardCertDomain(); wildcardDomain != "" && strings.EqualFold(strings.TrimSuffix(domain, "."), wildcardDomain) {
		wildcardResolver = dnsCertResolverName
	}

	// No stage networks — just bitswan_network for backward compatibility
	traefikDockerCompose, err := dockercompose.CreateWorkspaceTraefikDockerComposeFile(workspaceName, traefikConfigForCompose, domain, wildcardResolver, nil)
	if err != nil {
		return false, fmt.Errorf("failed to create workspace traefik docker-compose file: %w", err)
	}

	traefikDockerComposePath := traefikConfig + "/docker-compose.yml"
	if err := os.WriteFile(traefikDockerComposePath, []byte(traefikDockerCompose), 0755); err != nil {
		return false, fmt.Errorf("failed to write workspace traefik docker-compose file: %w", err)
	}

	traefikDockerComposeCom := exec.Command("docker", "compose", "-p", traefikProjectName, "up", "-d")
	traefikDockerComposeCom.Dir = traefikConfig

	if err := util.RunCommandVerbose(traefikDockerComposeCom, verbose); err != nil {
		return false, fmt.Errorf("failed to start workspace traefik: %w", err)
	}

	// Wait for workspace traefik to be up and verify it's running
	time.Sleep(5 * time.Second)

	checkCmd := exec.Command("docker", "ps", "-q", "-f", fmt.Sprintf("name=%s", containerName))
	output, err := checkCmd.Output()
	if err != nil || len(output) == 0 {
		return false, fmt.Errorf("workspace traefik container failed to start")
	}

	// Initialize workspace traefik via API
	workspaceTraefikURL := fmt.Sprintf("http://%s:8080", containerName)

	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(workspaceTraefikURL)
	if err == nil {
		defer resp.Body.Close()
		originalTraefikHost := os.Getenv("BITSWAN_TRAEFIK_HOST")
		os.Setenv("BITSWAN_TRAEFIK_HOST", workspaceTraefikURL)
		defer func() {
			if originalTraefikHost != "" {
				os.Setenv("BITSWAN_TRAEFIK_HOST", originalTraefikHost)
			} else {
				os.Unsetenv("BITSWAN_TRAEFIK_HOST")
			}
		}()

		if err := traefikapi.InitWorkspaceTraefik(); err != nil {
			if verbose {
				fmt.Printf("Warning: failed to init workspace traefik API: %v\n", err)
			}
		}
	} else {
		if verbose {
			fmt.Printf("Cannot connect directly to workspace traefik, skipping API initialization\n")
		}
	}

	return true, nil
}

// parseJWTToken extracts workspace ID or workspace name from a JWT token
func parseJWTToken(tokenString string) (workspaceID string, workspaceName string, err error) {
	parts := strings.Split(tokenString, ".")
	if len(parts) != 3 {
		return "", "", fmt.Errorf("invalid JWT token format")
	}

	payload := parts[1]
	if len(payload)%4 != 0 {
		payload += strings.Repeat("=", 4-len(payload)%4)
	}

	decoded, err := base64.URLEncoding.DecodeString(payload)
	if err != nil {
		return "", "", fmt.Errorf("failed to decode JWT payload: %w", err)
	}

	var claims map[string]interface{}
	if err := json.Unmarshal(decoded, &claims); err != nil {
		return "", "", fmt.Errorf("failed to parse JWT claims: %w", err)
	}

	if id, ok := claims["workspace-id"].(string); ok {
		workspaceID = id
	}
	if id, ok := claims["workspace_id"].(string); ok && workspaceID == "" {
		workspaceID = id
	}
	if name, ok := claims["workspace-name"].(string); ok {
		workspaceName = name
	}
	if name, ok := claims["workspace_name"].(string); ok && workspaceName == "" {
		workspaceName = name
	}

	if workspaceID == "" && workspaceName == "" {
		return "", "", fmt.Errorf("neither workspace-id nor workspace-name found in JWT token")
	}

	return workspaceID, workspaceName, nil
}

// resolveWorkspaceName extracts workspace name from the request or JWT token.
func resolveWorkspaceName(req IngressAddRouteRequest, jwtToken string) string {
	if req.WorkspaceName != "" {
		return req.WorkspaceName
	}

	if jwtToken == "" {
		jwtToken = req.Secret
	}

	if jwtToken != "" {
		workspaceID, workspaceNameFromToken, err := parseJWTToken(jwtToken)
		if err == nil {
			if workspaceNameFromToken != "" {
				return workspaceNameFromToken
			}
			if workspaceID != "" {
				name, err := findWorkspaceNameByID(workspaceID)
				if err == nil {
					return name
				}
			}
		}
	}

	return ""
}

// addRouteToIngress adds a route using whichever ingress is running.
// For Traefik with a workspace name, it sets up two-tier routing
// (platform traefik → workspace sub-traefik → container).
func addRouteToIngress(req IngressAddRouteRequest, jwtToken string) error {
	if req.Hostname == "" {
		return fmt.Errorf("hostname is required")
	}
	if req.Upstream == "" {
		return fmt.Errorf("upstream is required")
	}

	ingressType := DetectIngressType()
	workspaceName := resolveWorkspaceName(req, jwtToken)

	switch ingressType {
	case IngressCaddy:
		if err := addRouteCaddy(req); err != nil {
			return err
		}
	case IngressTraefik:
		if err := addRouteTraefik(req, workspaceName); err != nil {
			return err
		}
	default:
		return fmt.Errorf("no ingress proxy detected")
	}

	// Every hostname routed through the protected chain needs its OAuth
	// callback URIs (outer + inner) on the shared Keycloak client —
	// otherwise the first session-less request to it dead-ends on a
	// Keycloak "Invalid parameter: redirect_uri" page. This must NOT be
	// owner-gated: gitops registers automation/live-dev routes without
	// knowing the deployer. Best-effort — a failure here doesn't unwind
	// the route registration above.
	outer := toOuterHost(req.Hostname)
	if err := registerProtectedRedirectURI(outer); err != nil {
		fmt.Printf("Warning: AOC didn't accept protected-client redirect URI for %s: %v\n", outer, err)
	}

	// Record the hostname in the Bailey ACL so it is access-controlled
	// and shows up on the owner's share index.
	//
	// Parent linkage: workspace-spawned routes (gitops deploying
	// automations / business processes / live-dev services) delegate
	// membership to the workspace's dashboard endpoint, so everyone in
	// the workspace can share what they deploy there (see roleFor). The
	// association is explicit data: the caller states it via
	// req.ParentEndpoint, or the daemon reads the dashboard hostname
	// recorded in the workspace's own metadata.
	//
	// Owner: the caller-supplied email (workspace init, the add-route
	// CLI), falling back to the parent endpoint's owner for workspace-
	// spawned routes. Routes that are neither owned nor part of a
	// workspace stay open until something claims them.
	parent := req.ParentEndpoint
	if parent == "" && workspaceName != "" {
		parent = workspaceDashboardEndpoint(workspaceName)
	}
	if strings.EqualFold(parent, outer) {
		parent = "" // the dashboard itself has no parent
	}
	ownerEmail := req.OwnerEmail
	if ownerEmail == "" && parent != "" {
		if parentEp, err := getEndpoint(parent); err == nil && parentEp != nil {
			ownerEmail = parentEp.OwnerEmail
		}
	}
	if ownerEmail != "" {
		display := req.DisplayName
		if display == "" {
			display = outer
		}
		// A parentless route is a workspace dashboard (a top-level launcher
		// entry); otherwise honour the caller's explicit kind, defaulting a
		// parented route to "service" when unspecified.
		kind := req.Kind
		if parent == "" {
			kind = endpointKindWorkspace
		} else if kind == "" {
			kind = endpointKindService
		}
		if _, err := registerEndpoint(outer, ownerEmail, display, parent, kind, req.Stage); err != nil {
			fmt.Printf("Warning: failed to register Bailey endpoint for %s: %v\n", outer, err)
		}
	}
	return nil
}

// workspaceDashboardEndpoint returns the hostname of a workspace's
// dashboard endpoint as recorded in the workspace's metadata (the
// dashboard-url written at workspace init), or "" when the workspace
// has no dashboard or no metadata.
func workspaceDashboardEndpoint(workspaceName string) string {
	metadata, err := config.GetWorkspaceMetadata(workspaceName)
	if err != nil || metadata.DashboardURL == nil {
		return ""
	}
	u, err := url.Parse(*metadata.DashboardURL)
	if err != nil || u.Hostname() == "" {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

// addRouteCaddy adds a route to Caddy.
//
// Caddy deployments don't run the protected-ingress chain (no
// bitswan-protected-proxy container in the Caddy path), so there is no
// outer→wrap / inner→upstream split here. To keep the two-subdomain
// contract stable for clients that hit either hostname form, the inner
// sibling is registered pointing at the *same* upstream. Anything that
// wants the wrap should use Traefik.
func addRouteCaddy(req IngressAddRouteRequest) error {
	if isInnerHost(req.Hostname) {
		return fmt.Errorf("addRouteCaddy: refusing to register inner hostname %q directly — pass the outer hostname; the inner pair is registered automatically", req.Hostname)
	}
	outer := req.Hostname
	inner := toInnerHost(outer)

	if req.Mkcert {
		for _, h := range []string{outer, inner} {
			parts := strings.Split(h, ".")
			if len(parts) < 2 {
				return fmt.Errorf("invalid hostname format: must contain at least one dot")
			}
			domain := strings.Join(parts[1:], ".")
			if err := caddyapi.GenerateAndInstallCertsForHostname(h, domain); err != nil {
				return fmt.Errorf("failed to generate and install certificates for %s: %w", h, err)
			}
			if err := caddyapi.InstallTLSCertsForHostname(h, domain, "default"); err != nil {
				return fmt.Errorf("failed to install TLS policies for %s: %w", h, err)
			}
		}
	} else if req.CertsDir != "" {
		caddyConfig := os.Getenv("HOME") + "/.config/bitswan/caddy"
		for _, h := range []string{outer, inner} {
			if err := caddyapi.InstallCertsFromDir(req.CertsDir, h, caddyConfig); err != nil {
				return fmt.Errorf("failed to install certificates from directory for %s: %w", h, err)
			}
		}
	}

	if err := caddyapi.AddRoute(outer, req.Upstream); err != nil {
		return fmt.Errorf("add outer route: %w", err)
	}
	if err := caddyapi.AddRoute(inner, req.Upstream); err != nil {
		return fmt.Errorf("add inner route: %w", err)
	}
	return nil
}

// isWorkspaceTraefikRunning checks if a workspace sub-traefik container is running.
func isWorkspaceTraefikRunning(workspaceName string) bool {
	containerName := fmt.Sprintf("%s__traefik", workspaceName)
	out, err := exec.Command("docker", "ps", "-q", "-f", fmt.Sprintf("name=%s", containerName)).Output()
	return err == nil && strings.TrimSpace(string(out)) != ""
}

// addRouteTraefik adds a route to Traefik.
//
// Two-subdomain protected-ingress topology — for hostname "foo.<domain>"
// we register BOTH:
//
//   - foo.<domain> (OUTER): platform-traefik → bitswan-protected-proxy
//     → protected gate (chrome-wrap HTML). The gate serves only the
//     wrap on this hostname; no app content ever reaches it.
//
//   - foo--inner.<domain> (INNER): platform-traefik →
//     bitswan-protected-proxy → protected gate (ACL + CSP injection) →
//     workspace traefik → service. The wrap iframe loads this URL.
//     Direct visits work too; they show the bare app behind the same
//     oauth.
//
// req.Hostname must be the OUTER hostname; the inner pair is derived.
// Both subdomains are covered by the *.<domain> wildcard certificate
// when DNS-01 is configured (certResolverForHostname).
//
// The split only works when the bitswan-protected-proxy container is
// running. In bare environments (CI without protected ingress, dev
// hosts) the route falls back to single-tier: both hostnames resolve
// to the upstream directly, with no auth wrap to layer on top.
func addRouteTraefik(req IngressAddRouteRequest, workspaceName string) error {
	if isInnerHost(req.Hostname) {
		return fmt.Errorf("addRouteTraefik: refusing to register inner hostname %q directly — pass the outer hostname; the inner pair is registered automatically", req.Hostname)
	}
	outer := req.Hostname
	inner := toInnerHost(outer)

	certResolver := ""
	var tlsDomains []traefikapi.TLSDomain
	if !req.Mkcert && req.CertsDir == "" && !strings.HasSuffix(outer, ".localhost") {
		certResolver, tlsDomains = certResolverForHostname(outer)
	}

	// TLS — both subdomains need certificates. (With the DNS-01
	// wildcard resolver this is a single shared *.<domain> cert.)
	if req.Mkcert {
		for _, h := range []string{outer, inner} {
			if err := traefikapi.InstallTLSCerts(h, true, ""); err != nil {
				return fmt.Errorf("failed to generate and install certificates for %s: %w", h, err)
			}
		}
	} else if req.CertsDir != "" {
		for _, h := range []string{outer, inner} {
			if err := traefikapi.InstallTLSCerts(h, false, req.CertsDir); err != nil {
				return fmt.Errorf("failed to install certificates from directory for %s: %w", h, err)
			}
		}
	}

	wrapAvailable := containerRunning("bitswan-protected-proxy")
	if wrapAvailable && workspaceName != "" && isWorkspaceTraefikRunning(workspaceName) {
		// INNER hostname carries the actual app content: route it in
		// the workspace's own traefik and through the auth chain in
		// platform-traefik. The gate forwards post-auth inner traffic
		// to the sub-traefik (recorded below), which can reach
		// containers on the workspace's own networks.
		workspaceTraefikURL := traefikapi.GetWorkspaceTraefikBaseURL(workspaceName)
		if err := traefikapi.AddRouteWithTraefik(inner, req.Upstream, workspaceTraefikURL); err != nil {
			return fmt.Errorf("failed to add inner route to workspace sub-traefik: %w", err)
		}
		if err := traefikapi.AddRouteWithTLSDomains(inner, "bitswan-protected-proxy:80", "", certResolver, tlsDomains); err != nil {
			return fmt.Errorf("failed to add inner route to platform traefik: %w", err)
		}
		// OUTER hostname serves only the wrap.
		if err := traefikapi.AddRouteWithTLSDomains(outer, "bitswan-protected-proxy:80", "", certResolver, tlsDomains); err != nil {
			return fmt.Errorf("failed to add outer route to platform traefik: %w", err)
		}
		if err := saveProtectedRoute(outer, workspaceName+"__traefik:80"); err != nil {
			fmt.Printf("Warning: failed to record protected route for %s: %v\n", outer, err)
		}
	} else if workspaceName != "" && isWorkspaceTraefikRunning(workspaceName) {
		// Two-tier routing without the wrap: platform-traefik →
		// workspace sub-traefik → container, for both hostnames.
		workspaceTraefikURL := traefikapi.GetWorkspaceTraefikBaseURL(workspaceName)
		workspaceTraefikUpstream := fmt.Sprintf("%s__traefik:80", workspaceName)
		for _, h := range []string{outer, inner} {
			if err := traefikapi.AddRouteWithTraefik(h, req.Upstream, workspaceTraefikURL); err != nil {
				return fmt.Errorf("failed to add route to workspace sub-traefik for %s: %w", h, err)
			}
			if err := traefikapi.AddRouteWithTLSDomains(h, workspaceTraefikUpstream, "", certResolver, tlsDomains); err != nil {
				return fmt.Errorf("failed to add route to platform traefik for %s: %w", h, err)
			}
		}
	} else if wrapAvailable {
		// No workspace sub-traefik but the protected chain is up:
		// route BOTH hostnames through it. The gate resolves the
		// post-auth upstream from the protected_routes record, so the
		// service must be reachable from the daemon (bitswan_network —
		// true for all workspace services today).
		for _, h := range []string{outer, inner} {
			if err := traefikapi.AddRouteWithTLSDomains(h, "bitswan-protected-proxy:80", "", certResolver, tlsDomains); err != nil {
				return fmt.Errorf("failed to add route for %s: %w", h, err)
			}
		}
		if err := saveProtectedRoute(outer, req.Upstream); err != nil {
			fmt.Printf("Warning: failed to record protected route for %s: %v\n", outer, err)
		}
	} else {
		// Bare environment (no protected proxy): single-tier direct
		// routes for both hostnames so the service stays reachable at
		// its canonical name (matches what addRouteCaddy does).
		for _, h := range []string{outer, inner} {
			if err := traefikapi.AddRouteWithTLSDomains(h, req.Upstream, "", certResolver, tlsDomains); err != nil {
				return fmt.Errorf("failed to add route for %s: %w", h, err)
			}
		}
	}

	return nil
}

// containerRunning reports whether a docker container with the given
// name is currently running.
func containerRunning(name string) bool {
	out, err := exec.Command("docker", "ps", "-q", "-f", fmt.Sprintf("name=^%s$", name)).Output()
	return err == nil && strings.TrimSpace(string(out)) != ""
}

// removeRouteFromIngress removes a route from whichever ingress is
// running. The inner sibling registered by addRouteToIngress and the
// Bailey ACL row are cleaned up alongside (both keyed by the outer
// hostname).
func removeRouteFromIngress(hostname string) error {
	outer := toOuterHost(hostname)
	inner := toInnerHost(outer)

	var err error
	switch DetectIngressType() {
	case IngressCaddy:
		_ = caddyapi.RemoveRoute(inner)
		err = caddyapi.RemoveRoute(outer)
	case IngressTraefik:
		_ = traefikapi.RemoveRoute(inner)
		err = traefikapi.RemoveRoute(outer)
	default:
		return fmt.Errorf("no ingress proxy detected")
	}
	if err == nil {
		if derr := deleteEndpoint(outer); derr != nil {
			fmt.Printf("Warning: failed to remove Bailey endpoint for %s: %v\n", outer, derr)
		}
		if derr := deleteProtectedRoute(outer); derr != nil {
			fmt.Printf("Warning: failed to remove protected route record for %s: %v\n", outer, derr)
		}
	}
	return err
}

// MigrateCaddyToTraefik migrates from Caddy to Traefik.
// It exports routes from Caddy, stops Caddy, starts Traefik, and re-adds the routes.
func MigrateCaddyToTraefik(verbose bool) error {
	if DetectIngressType() != IngressCaddy {
		return fmt.Errorf("caddy is not running, nothing to migrate")
	}

	// Step 1: Export existing routes from Caddy
	fmt.Println("Exporting routes from Caddy...")
	routes, err := caddyapi.ListRoutes()
	if err != nil {
		return fmt.Errorf("failed to list Caddy routes: %w", err)
	}

	type routeExport struct {
		hostname string
		upstream string
	}
	var exported []routeExport
	for _, route := range routes {
		var hostname, upstream string
		for _, match := range route.Match {
			if len(match.Host) > 0 {
				hostname = match.Host[0]
			}
		}
		for _, handle := range route.Handle {
			if handle.Handler == "reverse_proxy" {
				for _, u := range handle.Upstreams {
					upstream = u.Dial
				}
			}
			// Also check subroutes (Caddy wraps in subroute handler)
			for _, subRoute := range handle.Routes {
				for _, subHandle := range subRoute.Handle {
					if subHandle.Handler == "reverse_proxy" {
						for _, u := range subHandle.Upstreams {
							upstream = u.Dial
						}
					}
				}
			}
		}
		if hostname != "" && upstream != "" {
			exported = append(exported, routeExport{hostname: hostname, upstream: upstream})
		}
	}

	if verbose {
		fmt.Printf("Exported %d routes from Caddy\n", len(exported))
	}

	// Step 2: Stop Caddy
	fmt.Println("Stopping Caddy...")
	stopCmd := exec.Command("docker", "compose", "-p", "bitswan-caddy", "down")
	homeDir := os.Getenv("HOME")
	caddyConfig := homeDir + "/.config/bitswan/caddy"
	stopCmd.Dir = caddyConfig
	if err := util.RunCommandVerbose(stopCmd, verbose); err != nil {
		// Try force remove if compose down fails
		exec.Command("docker", "rm", "-f", "caddy").Run()
	}

	// Step 3: Start Traefik
	fmt.Println("Starting Traefik...")
	if _, err := initTraefikIngress(verbose); err != nil {
		return fmt.Errorf("failed to start Traefik: %w", err)
	}

	// Step 4: Re-add routes to Traefik
	fmt.Println("Migrating routes to Traefik...")
	for _, route := range exported {
		certResolver, tlsDomains := certResolverForHostname(route.hostname)
		if err := traefikapi.AddRouteWithTLSDomains(route.hostname, route.upstream, "", certResolver, tlsDomains); err != nil {
			fmt.Printf("Warning: failed to migrate route %s -> %s: %v\n", route.hostname, route.upstream, err)
		} else if verbose {
			fmt.Printf("Migrated route: %s -> %s\n", route.hostname, route.upstream)
		}
	}

	fmt.Printf("Migration complete: %d routes migrated from Caddy to Traefik\n", len(exported))
	return nil
}

// UpdateIngress updates the ingress proxy to the latest version.
// It exports routes, stops the container, regenerates config, restarts, and re-adds routes.
func UpdateIngress(verbose bool) error {
	ingressType := DetectIngressType()

	switch ingressType {
	case IngressTraefik:
		return updateTraefik(verbose)
	case IngressCaddy:
		return updateCaddy(verbose)
	}

	return fmt.Errorf("no ingress proxy detected")
}

// updateTraefik updates the Traefik proxy to the latest version
func updateTraefik(verbose bool) error {
	// Step 1: Export existing routes
	fmt.Println("Exporting routes from Traefik...")
	routes, err := traefikapi.ListRoutes()
	if err != nil {
		return fmt.Errorf("failed to list Traefik routes: %w", err)
	}

	type routeExport struct {
		hostname string
		upstream string
	}
	var exported []routeExport
	for _, route := range routes {
		var hostname, upstream string
		for _, match := range route.Match {
			if len(match.Host) > 0 {
				hostname = match.Host[0]
			}
		}
		for _, handle := range route.Handle {
			if handle.Handler == "reverse_proxy" {
				for _, u := range handle.Upstreams {
					upstream = u.Dial
				}
			}
		}
		if hostname != "" && upstream != "" {
			exported = append(exported, routeExport{hostname: hostname, upstream: upstream})
		}
	}

	if verbose {
		fmt.Printf("Exported %d routes from Traefik\n", len(exported))
	}

	// Step 2: Stop Traefik
	fmt.Println("Stopping Traefik...")
	stopCmd := exec.Command("docker", "compose", "-p", "bitswan-traefik", "down")
	homeDir := os.Getenv("HOME")
	traefikConfig := homeDir + "/.config/bitswan/traefik"
	stopCmd.Dir = traefikConfig
	if err := util.RunCommandVerbose(stopCmd, verbose); err != nil {
		// Try force remove if compose down fails
		exec.Command("docker", "rm", "-f", "traefik").Run()
	}

	// Step 3: Pull latest image and regenerate config
	fmt.Println("Pulling latest Traefik image...")
	pullCmd := exec.Command("docker", "pull", "traefik:v3.6")
	if err := util.RunCommandVerbose(pullCmd, verbose); err != nil {
		fmt.Printf("Warning: failed to pull latest image: %v\n", err)
	}

	// Step 4: Start Traefik with new config
	fmt.Println("Starting Traefik...")
	if _, err := initTraefikIngress(verbose); err != nil {
		return fmt.Errorf("failed to start Traefik: %w", err)
	}

	// Step 5: Re-add routes
	fmt.Println("Restoring routes to Traefik...")
	for _, route := range exported {
		certResolver, tlsDomains := certResolverForHostname(route.hostname)
		if err := traefikapi.AddRouteWithTLSDomains(route.hostname, route.upstream, "", certResolver, tlsDomains); err != nil {
			fmt.Printf("Warning: failed to restore route %s -> %s: %v\n", route.hostname, route.upstream, err)
		} else if verbose {
			fmt.Printf("Restored route: %s -> %s\n", route.hostname, route.upstream)
		}
	}

	fmt.Printf("Update complete: %d routes restored\n", len(exported))
	return nil
}

// updateCaddy updates the Caddy proxy to the latest version
func updateCaddy(verbose bool) error {
	// Step 1: Export existing routes
	fmt.Println("Exporting routes from Caddy...")
	routes, err := caddyapi.ListRoutes()
	if err != nil {
		return fmt.Errorf("failed to list Caddy routes: %w", err)
	}

	type routeExport struct {
		hostname string
		upstream string
	}
	var exported []routeExport
	for _, route := range routes {
		var hostname, upstream string
		for _, match := range route.Match {
			if len(match.Host) > 0 {
				hostname = match.Host[0]
			}
		}
		for _, handle := range route.Handle {
			if handle.Handler == "reverse_proxy" {
				for _, u := range handle.Upstreams {
					upstream = u.Dial
				}
			}
			for _, subRoute := range handle.Routes {
				for _, subHandle := range subRoute.Handle {
					if subHandle.Handler == "reverse_proxy" {
						for _, u := range subHandle.Upstreams {
							upstream = u.Dial
						}
					}
				}
			}
		}
		if hostname != "" && upstream != "" {
			exported = append(exported, routeExport{hostname: hostname, upstream: upstream})
		}
	}

	if verbose {
		fmt.Printf("Exported %d routes from Caddy\n", len(exported))
	}

	// Step 2: Stop Caddy
	fmt.Println("Stopping Caddy...")
	stopCmd := exec.Command("docker", "compose", "-p", "bitswan-caddy", "down")
	homeDir := os.Getenv("HOME")
	caddyConfig := homeDir + "/.config/bitswan/caddy"
	stopCmd.Dir = caddyConfig
	if err := util.RunCommandVerbose(stopCmd, verbose); err != nil {
		exec.Command("docker", "rm", "-f", "caddy").Run()
	}

	// Step 3: Pull latest image
	fmt.Println("Pulling latest Caddy image...")
	pullCmd := exec.Command("docker", "pull", "caddy:2.9")
	if err := util.RunCommandVerbose(pullCmd, verbose); err != nil {
		fmt.Printf("Warning: failed to pull latest image: %v\n", err)
	}

	// Step 4: Start Caddy with new config
	fmt.Println("Starting Caddy...")
	if _, err := initCaddyIngress(verbose); err != nil {
		return fmt.Errorf("failed to start Caddy: %w", err)
	}

	// Step 5: Re-add routes
	fmt.Println("Restoring routes to Caddy...")
	for _, route := range exported {
		if err := caddyapi.AddRoute(route.hostname, route.upstream); err != nil {
			fmt.Printf("Warning: failed to restore route %s -> %s: %v\n", route.hostname, route.upstream, err)
		} else if verbose {
			fmt.Printf("Restored route: %s -> %s\n", route.hostname, route.upstream)
		}
	}

	fmt.Printf("Update complete: %d routes restored\n", len(exported))
	return nil
}

// handleIngressAddRoute handles POST /ingress/add-route
func (s *Server) handleIngressAddRoute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req IngressAddRouteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}

	jwtToken := r.Header.Get("BITSWAN_AUTOMATION_SERVER_DAEMON_TOKEN")

	if err := addRouteToIngress(req, jwtToken); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(IngressAddRouteResponse{
		Success: true,
		Message: fmt.Sprintf("Successfully added route: %s -> %s", req.Hostname, req.Upstream),
	})
}

// handleIngressRepointRoute handles POST /ingress/repoint-route — atomically
// repoints an EXISTING production route's upstream to a different container.
// This is the single primitive behind both zero-downtime promotion (point the
// production hostname at the freshly-deployed app version, same DB) and the DR
// go-live swap (point it at the other slot's containers, other DB). Unlike
// add-route it deliberately does NOT touch TLS certs, the Bailey ACL, or
// OAuth redirect URIs — the route already exists with all of that; only the
// upstream the route resolves to changes. The rewrite reuses addRouteTraefik /
// addRouteCaddy, so it is correct across every routing topology (protected
// wrap, workspace sub-traefik, or direct) and replaces the upstream in place.
func (s *Server) handleIngressRepointRoute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req IngressAddRouteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Hostname == "" || req.Upstream == "" {
		writeJSONError(w, "hostname and upstream are required", http.StatusBadRequest)
		return
	}

	jwtToken := r.Header.Get("BITSWAN_AUTOMATION_SERVER_DAEMON_TOKEN")
	workspaceName := resolveWorkspaceName(req, jwtToken)

	switch DetectIngressType() {
	case IngressTraefik:
		if err := addRouteTraefik(req, workspaceName); err != nil {
			writeJSONError(w, err.Error(), http.StatusInternalServerError)
			return
		}
	case IngressCaddy:
		if err := addRouteCaddy(req); err != nil {
			writeJSONError(w, err.Error(), http.StatusInternalServerError)
			return
		}
	default:
		writeJSONError(w, "no ingress proxy detected", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(IngressAddRouteResponse{
		Success: true,
		Message: fmt.Sprintf("Repointed route: %s -> %s", req.Hostname, req.Upstream),
	})
}

// upstreamsEqual compares the daemon's recorded upstream for a route with a
// desired upstream, ignoring any scheme. Used by reconcile to skip a route that
// is already resolving to the right place (so re-applying an in-sync workspace
// is a fast no-op) while re-applying one that drifted or is missing.
func upstreamsEqual(recorded, desired string) bool {
	if recorded == "" || desired == "" {
		return false
	}
	strip := func(s string) string {
		s = strings.TrimPrefix(s, "http://")
		s = strings.TrimPrefix(s, "https://")
		return strings.TrimSuffix(s, "/")
	}
	return strip(recorded) == strip(desired)
}

// handleIngressReconcile handles POST /ingress/reconcile — the declarative
// ingress apply. It converges the workspace's gitops-managed routes to exactly
// the desired set: upsert each (addRouteToIngress + mark source='gitops'), then
// prune any gitops route for the workspace not in the set. Manual routes (added
// by a human via add-route, or workspace-init infra) are never pruned. Idempotent.
func (s *Server) handleIngressReconcile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req IngressReconcileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.WorkspaceName) == "" {
		writeJSONError(w, "workspace_name is required", http.StatusBadRequest)
		return
	}

	jwtToken := r.Header.Get("BITSWAN_AUTOMATION_SERVER_DAEMON_TOKEN")
	resp := IngressReconcileResponse{Success: true, Pruned: []string{}}

	// 1. Upsert every desired route and mark it gitops-managed. Skip the
	//    (multi-write, ~1s) re-apply only when the route is ALREADY resolving to
	//    the right upstream — checked against the daemon's recorded
	//    protected_routes upstream, not a cache. So re-applying an in-sync
	//    workspace is a fast no-op, but a route that drifted (manual repoint) or
	//    went missing (lost on a restart) is re-applied — "re-apply to fix it".
	desired := make(map[string]bool) // outer hostnames in the desired set
	for _, route := range req.Routes {
		if route.WorkspaceName == "" {
			route.WorkspaceName = req.WorkspaceName
		}
		outer := toOuterHost(route.Hostname)
		desired[strings.ToLower(outer)] = true

		live, _ := lookupProtectedRouteUpstream(outer)
		ep, _ := getEndpoint(outer)
		inSync := ep != nil && ep.Source == "gitops" &&
			upstreamsEqual(live, route.Upstream)
		if inSync {
			continue // already resolving to the right upstream — nothing to do
		}
		if err := addRouteToIngress(route, jwtToken); err != nil {
			resp.Warnings = append(resp.Warnings,
				fmt.Sprintf("apply %s: %v", route.Hostname, err))
			continue
		}
		if err := setEndpointSource(outer, "gitops"); err != nil {
			resp.Warnings = append(resp.Warnings,
				fmt.Sprintf("mark %s gitops: %v", outer, err))
		}
		resp.Applied++
	}

	// 2. Prune gitops-managed routes for this workspace that are no longer
	//    desired. Manual routes are not in this list, so they're never pruned.
	managed, err := listGitopsManagedHosts(req.WorkspaceName)
	if err != nil {
		resp.Warnings = append(resp.Warnings, "list managed: "+err.Error())
	}
	for _, host := range managed {
		if desired[strings.ToLower(host)] {
			continue
		}
		if err := removeRouteFromIngress(host); err != nil {
			resp.Warnings = append(resp.Warnings,
				fmt.Sprintf("prune %s: %v", host, err))
			continue
		}
		resp.Pruned = append(resp.Pruned, host)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(resp)
}

// handleIngressListRoutes handles GET /ingress/list-routes
func (s *Server) handleIngressListRoutes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	ingressType := DetectIngressType()
	var routeInfos []RouteInfo

	switch ingressType {
	case IngressCaddy:
		routes, err := caddyapi.ListRoutes()
		if err != nil {
			writeJSONError(w, "failed to list routes: "+err.Error(), http.StatusInternalServerError)
			return
		}
		for _, route := range routes {
			var hostnames []string
			for _, match := range route.Match {
				hostnames = append(hostnames, match.Host...)
			}
			var upstreams []string
			for _, handle := range route.Handle {
				if handle.Handler == "subroute" {
					for _, subRoute := range handle.Routes {
						for _, subHandle := range subRoute.Handle {
							if subHandle.Handler == "reverse_proxy" {
								for _, upstream := range subHandle.Upstreams {
									upstreams = append(upstreams, upstream.Dial)
								}
							}
						}
					}
				}
			}
			if len(hostnames) > 0 && len(upstreams) > 0 {
				routeInfos = append(routeInfos, RouteInfo{
					ID:       route.ID,
					Hostname: hostnames[0],
					Upstream: upstreams[0],
					Terminal: route.Terminal,
				})
			}
		}

	case IngressTraefik:
		routes, err := traefikapi.ListRoutes()
		if err != nil {
			writeJSONError(w, "failed to list routes: "+err.Error(), http.StatusInternalServerError)
			return
		}
		for _, route := range routes {
			var hostnames []string
			for _, match := range route.Match {
				hostnames = append(hostnames, match.Host...)
			}
			var upstreams []string
			for _, handle := range route.Handle {
				if handle.Handler == "reverse_proxy" {
					for _, upstream := range handle.Upstreams {
						upstreams = append(upstreams, upstream.Dial)
					}
				}
			}
			if len(hostnames) > 0 && len(upstreams) > 0 {
				routeInfos = append(routeInfos, RouteInfo{
					ID:       route.ID,
					Hostname: hostnames[0],
					Upstream: upstreams[0],
					Terminal: route.Terminal,
				})
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(IngressListRoutesResponse{
		Routes: routeInfos,
	})
}

// handleIngressRemoveRoute handles DELETE /ingress/remove-route/{hostname}
func (s *Server) handleIngressRemoveRoute(w http.ResponseWriter, r *http.Request, hostname string) {
	if r.Method != http.MethodDelete {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if hostname == "" {
		writeJSONError(w, "hostname is required", http.StatusBadRequest)
		return
	}

	if err := removeRouteFromIngress(hostname); err != nil {
		writeJSONError(w, "failed to remove route: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(IngressRemoveRouteResponse{
		Success: true,
		Message: fmt.Sprintf("Removed route: %s", hostname),
	})
}
