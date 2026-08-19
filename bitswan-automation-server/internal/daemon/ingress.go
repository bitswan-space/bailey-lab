package daemon

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"net/url"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/docker"
	"github.com/bitswan-space/bitswan-workspaces/internal/dockercompose"
	"github.com/bitswan-space/bitswan-workspaces/internal/traefikapi"
	"github.com/bitswan-space/bitswan-workspaces/internal/util"
)

// IngressInitRequest represents the request to initialize ingress
type IngressInitRequest struct {
	Verbose bool `json:"verbose"`
	// BindAddress narrows the host address Traefik publishes :80/:443 on
	// (see config.Config.IngressBindAddress). Three states, which is why it is
	// a pointer: nil leaves the stored value alone (every existing caller),
	// a pointer to an address sets it, and a pointer to "" clears it back to
	// every interface. Stating it forces the reconfigure path even when Traefik
	// is already running, since the point of the call is to change how it binds.
	BindAddress *string `json:"bind_address,omitempty"`
	// TLSMode selects the certificate backend as part of the same call. It exists
	// so registration can settle the mode BEFORE the ingress first comes up:
	// setting it afterwards means Traefik starts on the default, opens an ACME
	// order that a bring-your-own-certificate server can never complete, and the
	// operator meets that as a failure rather than as a choice they already made.
	// nil leaves the stored mode alone.
	TLSMode *string `json:"tls_mode,omitempty"`
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
	WorkspaceName string `json:"workspace_name"`
	// BusinessProcess scopes the reconcile to one BP (per-BP deploy repos): the
	// prune only removes gitops routes tagged with this BP, never a sibling's.
	// Empty = legacy whole-workspace reconcile (every gitops route is prunable).
	BusinessProcess string                   `json:"business_process,omitempty"`
	Routes          []IngressAddRouteRequest `json:"routes"`
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
	case path == "update":
		s.handleIngressUpdate(w, r)
	case path == "provision-protected-proxy":
		s.handleIngressProvisionProtectedProxy(w, r)
	case path == "wait":
		s.handleIngressWait(w, r)
	case path == "tls":
		s.handleIngressTLS(w, r)
	case path == "tls/install-cert":
		s.handleIngressTLSInstallCert(w, r)
	case path == "tls/remove-cert":
		s.handleIngressTLSRemoveCert(w, r)
	default:
		writeJSONError(w, "not found", http.StatusNotFound)
	}
}

// handleIngressWait handles POST /ingress/wait — block until Traefik serves the
// given hostname, or the timeout expires.
//
// The probe has to run in the daemon: it dials Traefik by its container name on
// the docker network, which the host cannot resolve. Disaster recovery gates the
// steps that need the AOC on this, and register could too.
func (s *Server) handleIngressWait(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Hostname string `json:"hostname"`
		Seconds  int    `json:"seconds,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Hostname == "" {
		writeJSONError(w, "hostname is required", http.StatusBadRequest)
		return
	}
	timeout := ingressWaitDefault
	if req.Seconds > 0 {
		timeout = time.Duration(req.Seconds) * time.Second
	}
	if err := waitForIngress(req.Hostname, timeout); err != nil {
		writeJSONError(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, map[string]interface{}{"serving": true, "hostname": req.Hostname})
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

	// A stated bind address is a change to HOW Traefik listens, so persist it
	// and take the reconfigure path directly: initIngress short-circuits when
	// the container is already up, which would silently accept the new address
	// and never apply it.
	forceReconfigure := false
	if req.TLSMode != nil {
		mode, err := ParseTLSMode(*req.TLSMode)
		if err != nil {
			writeJSONError(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := validateTLSModeChoice(mode); err != nil {
			writeJSONError(w, err.Error(), http.StatusBadRequest)
			return
		}
		cfg := config.NewAutomationServerConfig()
		if cfg.GetTLSMode() != string(mode) {
			if err := cfg.SetTLSMode(string(mode)); err != nil {
				writeJSONError(w, "failed to persist TLS mode: "+err.Error(),
					http.StatusInternalServerError)
				return
			}
			forceReconfigure = true
		}
	}
	if req.BindAddress != nil {
		addr := strings.TrimSpace(*req.BindAddress)
		if err := validateIngressBindAddress(addr); err != nil {
			writeJSONError(w, err.Error(), http.StatusBadRequest)
			return
		}
		cfg := config.NewAutomationServerConfig()
		if cfg.GetIngressBindAddress() != addr {
			if err := cfg.SetIngressBindAddress(addr); err != nil {
				writeJSONError(w, "failed to persist ingress bind address: "+err.Error(),
					http.StatusInternalServerError)
				return
			}
			forceReconfigure = true
		}
	}

	var newlyInitialized bool
	var err error
	if forceReconfigure {
		newlyInitialized, err = initTraefikIngressFn(req.Verbose)
	} else {
		newlyInitialized, err = initIngress(req.Verbose)
	}
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

// initIngress initializes the Traefik ingress proxy. If Traefik is already
// running it just refreshes its file-provider config; otherwise it starts it.
func initIngress(verbose bool) (bool, error) {
	// Skip only if Traefik is actually RUNNING. Probe the container directly:
	// InitTraefik no longer pushes to Traefik's REST API (it renders the
	// file-provider config to disk) so it always succeeds and can't tell us
	// whether Traefik is up. If it's running, just refresh its config.
	if containerRunning("traefik") {
		_ = traefikapi.InitTraefik()
		return false, nil
	}
	return initTraefikIngress(verbose)
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

// emptyTraefikDynamicConfig seeds a workspace sub-traefik's file-provider config
// before any route exists — the volume-subpath mount requires the file present.
// The daemon rewrites it with real routes via the traefikapi state on push.
const emptyTraefikDynamicConfig = `http:
  routers: {}
  services: {}
`

// workspaceTraefikStaticConfig is the per-workspace sub-traefik's static config.
// The API/dashboard is intentionally omitted: routes come from the file provider
// (dynamic.yml), so Traefik's HTTP API is unused, and enabling it would serve this
// workspace's full cross-stage route table unauthenticated on the implicit :8080
// entrypoint. forwardedHeaders.insecure only trusts the upstream gate's
// X-Forwarded-* headers on the web entrypoint — unrelated to the API.
const workspaceTraefikStaticConfig = `entryPoints:
  web:
    address: ":80"
    forwardedHeaders:
      insecure: true
providers:
  file:
    filename: /etc/traefik/dynamic.yml
    watch: true
`

func renderTraefikStaticConfig(acmeEmail string, dnsChallenge bool) string {
	return renderTraefikStaticConfigForMode(acmeEmail, dnsChallenge, DefaultTLSMode)
}

// renderTraefikStaticConfigForMode renders the static config for a mode that
// needs no further parameters.
func renderTraefikStaticConfigForMode(acmeEmail string, dnsChallenge bool, mode TLSMode) string {
	return renderTraefikStaticConfigOpts(traefikStaticOptions{
		ACMEEmail:    acmeEmail,
		DNSChallenge: dnsChallenge,
		Mode:         mode,
	})
}

// traefikStaticOptions is everything the static config depends on. A struct
// because the variations are no longer one boolean: which CA backend, whose DNS,
// and whether a DNS-01 resolver is wanted at all.
type traefikStaticOptions struct {
	ACMEEmail string
	// DNSChallenge asks for a DNS-01 wildcard resolver (the server has a domain).
	DNSChallenge bool
	Mode         TLSMode
	// DNSProvider is the lego provider id for custom-dns mode.
	DNSProvider string
}

// renderTraefikStaticConfigOpts renders the global Traefik static configuration.
// A mode that contacts no CA gets NO certificatesResolvers at all — not even the
// HTTP-01 one — so a route that somehow kept a resolver name cannot quietly start
// an ACME order that could never succeed, and nothing on the server waits on a
// challenge that will never be answered.
func renderTraefikStaticConfigOpts(o traefikStaticOptions) string {
	acmeEmail, dnsChallenge, mode := o.ACMEEmail, o.DNSChallenge, o.Mode
	cfg := `entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
# API/dashboard DISABLED: the daemon manages every route via the file provider
# (dynamic.yml), so Traefik's HTTP API is unused. Leaving it enabled serves the
# full routing topology UNAUTHENTICATED on the implicit :8080 entrypoint — a data
# leak the instant that port is published or forwarded. There is no reason to run it.
providers:
  file:
    filename: /etc/traefik/dynamic.yml
    watch: true
  docker:
    exposedByDefault: false
    network: bitswan_network
`

	if !mode.usesACME() {
		// Certificates come from the file-provider TLS store (see
		// traefikapi.InstallTLSCerts); Traefik picks them by SNI.
		return cfg
	}

	cfg += fmt.Sprintf(`certificatesResolvers:
  letsencrypt:
    acme:
      email: %s
      storage: /acme/acme.json
      httpChallenge:
        entryPoint: web
`, acmeEmail)

	if dnsChallenge && mode.usesCustomDNSProvider() {
		// The operator's own provider. Two deliberate differences from the AOC
		// bridge below: lego's propagation pre-flight is LEFT ON, because against a
		// real provider API it is a correct and useful check (the bridge disables it
		// only because it already waits for the record to be live, and because a
		// NAT'd server often cannot reach arbitrary nameservers on :53); and the
		// resolver keeps the same name and storage file as aoc-dns, so switching
		// between the two modes needs no route migration and re-uses the existing
		// ACME account and certificates.
		cfg += fmt.Sprintf(`  %s:
    acme:
      email: %s
      storage: /acme/acme-dns.json
      dnsChallenge:
        provider: %s
`, dnsCertResolverName, acmeEmail, o.DNSProvider)
		return cfg
	}

	if dnsChallenge {
		// disablePropagationCheck: lego's default pre-flight queries the zone's
		// authoritative nameservers directly (UDP :53) to confirm the TXT is
		// visible before asking Let's Encrypt to validate. A NAT'd / proxied
		// server frequently CAN'T reach arbitrary external nameservers on :53
		// (egress-filtered), so that self-check times out and the whole issuance
		// fails — even though the AOC created the TXT correctly and Let's Encrypt
		// itself can see it. We skip lego's poll and instead the AOC bridge blocks
		// the ACME 'present' call until the TXT is INSYNC on every Route53
		// nameserver, so by the time lego proceeds LE can already validate.
		// delayBeforeCheck is therefore only a small safety buffer, not the old
		// blind 120s floor that dominated issuance time.
		cfg += fmt.Sprintf(`  %s:
    acme:
      email: %s
      storage: /acme/acme-dns.json
      dnsChallenge:
        provider: httpreq
        delayBeforeCheck: 5s
        disablePropagationCheck: true
`, dnsCertResolverName, acmeEmail)
	}

	return cfg
}

// initTraefikIngressFn is the reconfigure step, indirected through a var so tests
// can replace it — the same reason ingressProbe and ingressWaitPoll are vars.
//
// This is not stylistic. initTraefikIngress runs `docker compose -p
// bitswan-traefik up -d`, and both the project name and the `bitswan` named
// volume it mounts are fixed — so a test that reaches it does not create a
// sandboxed Traefik, it RECREATES the one belonging to whatever Bailey is
// installed on the machine running the test. It reads the real config files
// (they live in that volume) but with whatever the test asked for, which for a
// bind-address test means republishing a live server's ingress on loopback and
// taking it off the network until someone notices. A temp HOME does not protect
// against this: the volume and the project name are not derived from HOME.
var initTraefikIngressFn = initTraefikIngress

// validateIngressBindAddress rejects anything that isn't a bare IP literal.// validateIngressBindAddress rejects anything that isn't a bare IP literal.
//
// The value is interpolated into a docker-compose port mapping
// ("<addr>:443:443"), so a hostname or a stray colon would either fail at
// container-create time with an opaque Docker error or, worse, change which
// port is published. An IP is also the only thing that is stable enough to bind
// to: publishing follows the address, not the interface name. Empty is valid and
// means "every interface".
func validateIngressBindAddress(addr string) error {
	if addr == "" {
		return nil
	}
	ip := net.ParseIP(addr)
	if ip == nil {
		return fmt.Errorf(
			"ingress bind address %q is not an IP address; pass the address Traefik should "+
				"publish on (e.g. the server's VPN address, 10.8.0.7), or \"\" for every interface",
			addr)
	}
	// A publish bound to a v6 address needs brackets in the mapping; we don't
	// render those, so refuse rather than emit a mapping Docker misreads.
	if ip.To4() == nil {
		return fmt.Errorf(
			"ingress bind address %q is IPv6; only IPv4 bind addresses are supported today",
			addr)
	}
	return nil
}

// localAddressExists reports whether addr is assigned to an interface on this
// machine. Used only to explain a failure, never to decide behaviour — an
// interface that is merely late (a VPN tunnel coming up after boot) must not
// change how the ingress is published.
func localAddressExists(addr string) bool {
	want := net.ParseIP(addr)
	if want == nil {
		return false
	}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return true // can't tell; don't claim a problem we haven't observed
	}
	for _, a := range addrs {
		var ip net.IP
		switch v := a.(type) {
		case *net.IPNet:
			ip = v.IP
		case *net.IPAddr:
			ip = v.IP
		}
		if ip != nil && ip.Equal(want) {
			return true
		}
	}
	return false
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
	//
	// A mode that contacts no CA gets none of this: no bridge credentials in
	// Traefik's environment, and no resolver in the static config.
	tlsMode := currentTLSMode()
	wildcardDomain := getWildcardCertDomain()
	// The DNS-01 resolver is only configured when the challenge can actually be
	// written. For custom-dns that is the operator's own provider; for aoc-dns it
	// also requires the AOC to manage the zone, because the bridge writes into the
	// AOC's own hosted zone and refuses anything outside it. Rendering the resolver
	// for a domain it can never write to gives Traefik an order that 502s forever,
	// with the bridge credentials in its environment for no reason.
	dnsChallenge := wildcardDomain != "" && canIssueWildcard(tlsMode)

	var traefikEnv map[string]string
	dnsProvider := ""
	switch {
	case dnsChallenge && tlsMode.usesAOCBridge():
		secret, err := getOrCreateACMEBridgeSecret(traefikConfig)
		if err != nil {
			return false, err
		}
		traefikEnv = map[string]string{
			"HTTPREQ_ENDPOINT": acmeBridgeEndpoint(),
			"HTTPREQ_USERNAME": acmeBridgeUsername,
			"HTTPREQ_PASSWORD": secret,
		}
	case dnsChallenge && tlsMode.usesCustomDNSProvider():
		// The operator's provider credentials, and ONLY those: the AOC bridge
		// secret has no business in Traefik's environment in this mode, and a
		// leftover HTTPREQ_ENDPOINT would point lego at a bridge that cannot write
		// to this zone.
		dns := config.NewAutomationServerConfig().GetTLSDNS()
		if err := validateCustomDNS(dns); err != nil {
			// Refuse to render a resolver that cannot work. Falling back to the AOC
			// bridge would be worse than failing: on a customer-owned zone it cannot
			// succeed, and the failure would look like a DNS problem rather than a
			// misconfiguration here.
			return false, fmt.Errorf("TLS mode %s is selected but its DNS provider is not usable: %w",
				tlsMode, err)
		}
		dnsProvider = dns.Provider
		traefikEnv = map[string]string{}
		for k, v := range dns.Credentials {
			traefikEnv[k] = v
		}
	}

	traefikStaticConfig := renderTraefikStaticConfigOpts(traefikStaticOptions{
		ACMEEmail:    acmeEmail,
		DNSChallenge: dnsChallenge,
		Mode:         tlsMode,
		DNSProvider:  dnsProvider,
	})

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

	bindAddress := config.NewAutomationServerConfig().GetIngressBindAddress()
	// Diagnose the one failure mode a narrowed publish adds, BEFORE Docker turns
	// it into an opaque "cannot assign requested address". We deliberately do not
	// widen back to every interface as a fallback: on a private server that would
	// silently start publishing on the public one, which is the exact outcome the
	// bind address exists to prevent. Fail closed, but say why.
	if bindAddress != "" && !localAddressExists(bindAddress) {
		fmt.Printf("Warning: ingress bind address %s is not configured on any interface of this "+
			"machine, so Traefik cannot publish on it. If this is a VPN address, bring the tunnel up "+
			"(the container's restart policy will keep retrying until then); if the machine's address "+
			"changed, re-point it with 'bitswan ingress init --bind-address <addr>'.\n", bindAddress)
	}
	traefikDockerCompose, err := dockercompose.CreateTraefikDockerComposeFile(
		traefikConfigForCompose, traefikEnv, bindAddress)
	if err != nil {
		return false, fmt.Errorf("failed to create ingress docker-compose file: %w", err)
	}

	traefikConfigFilePath := traefikConfig + "/traefik.yml"
	traefikDockerComposePath := traefikConfig + "/docker-compose.yml"

	// Skip the restart only if Traefik is actually RUNNING with matching config —
	// nothing to do then. Probe the CONTAINER directly: the old probe used
	// InitTraefik's REST push (which failed when Traefik was down), but routes
	// now go through the file provider so InitTraefik just writes a local file
	// and always succeeds — it can no longer tell whether Traefik is up. If the
	// config has drifted (e.g. the DNS-01 resolver was just enabled), fall
	// through and recreate the container.
	if containerRunning("traefik") {
		currentConfig, _ := os.ReadFile(traefikConfigFilePath)
		currentCompose, _ := os.ReadFile(traefikDockerComposePath)
		if string(currentConfig) == traefikStaticConfig && string(currentCompose) == traefikDockerCompose {
			// Running and unchanged — just refresh the file-provider config from
			// the saved state in case it drifted, then leave it. The route table is
			// still reconciled onto the configured TLS mode: a route added while the
			// mode was something else would otherwise keep the wrong backend
			// forever, and this is the cheap, idempotent place to catch that.
			_ = traefikapi.InitTraefik()
			reconcileTLSMode()
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

	// Put the live route table on the backend the configured mode implies: the
	// shared wildcard certificate under aoc-dns, no ACME at all under manual.
	reconcileTLSMode()
	// Nothing renews an operator-installed certificate, so boot is the earliest
	// anyone can be told one is running out.
	warnAboutInstalledCertExpiry()

	return true, nil
}

// bitswanNetworkAllowCIDRs resolves bitswan_network's subnet(s) — the ONLY
// source range from which the daemon gate reaches a workspace sub-traefik. Every
// stage bridge (dev/staging/production) uses a disjoint subnet, so allowlisting
// exactly this on the sub-traefik routers (traefikapi.SetIngressAllowCIDRs) lets
// the gate through while rejecting any stage-network peer that tries to route a
// cross-stage Host directly — finding C1. Returns nil (⇒ fail-closed default) if
// the network can't be inspected.
func bitswanNetworkAllowCIDRs() []string {
	out, err := exec.Command("docker", "network", "inspect", "bitswan_network",
		"--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}").Output()
	if err != nil {
		fmt.Printf("Warning: could not resolve bitswan_network subnet for the sub-traefik ingress ACL: %v\n", err)
		return nil
	}
	var cidrs []string
	for _, f := range strings.Fields(string(out)) {
		if strings.Contains(f, "/") {
			cidrs = append(cidrs, f)
		}
	}
	return cidrs
}

// initWorkspaceTraefik initializes a traefik proxy for a workspace.
func initWorkspaceTraefik(workspaceName, domain string, verbose bool) (bool, error) {
	homeDir := os.Getenv("HOME")
	workspaceConfig := fmt.Sprintf("%s/.config/bitswan/workspaces/%s", homeDir, workspaceName)
	traefikConfig := workspaceConfig + "/traefik"

	traefikProjectName := fmt.Sprintf("bitswan-%s-traefik", workspaceName)
	containerName := fmt.Sprintf("%s__traefik", workspaceName)

	// Check if workspace traefik container already exists.
	traefikContainerId, err := exec.Command("docker", "ps", "-q", "-f", fmt.Sprintf("name=%s", containerName)).Output()
	if err != nil {
		return false, fmt.Errorf("failed to check if workspace traefik container exists: %w", err)
	}
	if strings.TrimSpace(string(traefikContainerId)) != "" {
		// A sub-traefik created before the file-provider migration mounts only
		// traefik.yml and serves the in-memory REST provider — it ignores the
		// dynamic.yml this daemon now writes routes into, so every new route goes
		// stale on it (and never recovers, since this function used to just skip
		// when the container existed). Detect that by the absence of the
		// dynamic.yml mount and recreate it on the current (file-provider) config;
		// an already-migrated sub-traefik has the mount and is a no-op.
		mounts, err := exec.Command("docker", "inspect", "--format",
			"{{range .Mounts}}{{.Destination}}\n{{end}}", containerName).Output()
		if err != nil {
			return false, fmt.Errorf("failed to inspect workspace traefik mounts: %w", err)
		}
		// Also recreate a sub-traefik still running with IP forwarding enabled: a
		// container created before the ip_forward=0 sysctl can bridge stage nets at
		// L3. `docker inspect` exposes the applied sysctls, so an already-hardened
		// one reads net.ipv4.ip_forward:0 and stays a no-op.
		sysctls, _ := exec.Command("docker", "inspect", "--format",
			"{{index .HostConfig.Sysctls \"net.ipv4.ip_forward\"}}", containerName).Output()
		hardened := strings.TrimSpace(string(sysctls)) == "0"
		if strings.Contains(string(mounts), "/etc/traefik/dynamic.yml") && hardened {
			return false, nil // up to date — reads dynamic.yml already + can't forward
		}
		if out, rmErr := exec.Command("docker", "rm", "-f", containerName).CombinedOutput(); rmErr != nil {
			return false, fmt.Errorf("failed to remove stale workspace traefik %s: %w: %s", containerName, rmErr, strings.TrimSpace(string(out)))
		}
		// Fall through to recreate with the file provider + dynamic.yml mount + the
		// no-forwarding sysctl.
	}

	// Create workspace traefik config directory
	if err := os.MkdirAll(traefikConfig, 0755); err != nil {
		return false, fmt.Errorf("failed to create workspace traefik config directory: %w", err)
	}

	// Traefik static config: web entrypoint (HTTP only for the workspace
	// sub-traefik) + the FILE provider (durable across restarts). Routes are
	// written to /etc/traefik/dynamic.yml (a bitswan-volume subpath shared with
	// the daemon) and reloaded by Traefik on change — no in-memory REST push.
	traefikStaticConfig := workspaceTraefikStaticConfig

	traefikConfigFilePath := traefikConfig + "/traefik.yml"
	if err := os.WriteFile(traefikConfigFilePath, []byte(traefikStaticConfig), 0755); err != nil {
		return false, fmt.Errorf("failed to write workspace traefik.yml: %w", err)
	}

	// The file provider needs dynamic.yml to exist before the sub-traefik mounts
	// it (volume-subpath mounts are strict). Seed an empty one if absent; the
	// daemon rewrites it with the real routes via modifyState when routes are
	// pushed — and never clobbers an existing one with routes.
	workspaceDynamicFilePath := traefikConfig + "/dynamic.yml"
	if _, err := os.Stat(workspaceDynamicFilePath); os.IsNotExist(err) {
		if err := os.WriteFile(workspaceDynamicFilePath, []byte(emptyTraefikDynamicConfig), 0644); err != nil {
			return false, fmt.Errorf("failed to write workspace dynamic.yml: %w", err)
		}
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
		dynamicFilePathHost := traefikConfigForCompose + "/dynamic.yml"
		if _, err := os.Stat(dynamicFilePathHost); os.IsNotExist(err) {
			if err := os.WriteFile(dynamicFilePathHost, []byte(emptyTraefikDynamicConfig), 0644); err != nil {
				return false, fmt.Errorf("failed to write workspace dynamic.yml on host: %w", err)
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

	// Per-(workspace, stage) network isolation: create the stage networks and
	// multi-home the workspace sub-traefik across them + bitswan_network. The
	// sub-traefik is the SOLE bridge from the ingress to stage-isolated
	// automations (which live ONLY on their {workspace}-{stage} network, never
	// on bitswan_network — see gitops generate_docker_compose and
	// network_security_model.md). Without this, automations could reach gitops /
	// the dashboard / the daemon directly.
	stageNetworks := []string{
		workspaceName + "-dev",
		workspaceName + "-staging",
		workspaceName + "-production",
	}
	for _, net := range stageNetworks {
		if _, err := docker.EnsureDockerNetwork(net, verbose); err != nil {
			return false, fmt.Errorf("failed to ensure stage network %s: %w", net, err)
		}
	}
	// The platform-facing HostRegexp catch-all (emitted by
	// CreateWorkspaceTraefikDockerComposeFile whenever a domain is given) makes
	// the GLOBAL traefik route every {workspace}-*.{domain} host straight to
	// this sub-traefik. That is correct only in the bare two-tier topology. In
	// the protected/wrap topology the global traefik must route those hosts
	// through bitswan-protected-proxy (oauth) → daemon gate, and the gate
	// reaches this sub-traefik internally ({ws}__traefik:80, recorded by
	// saveProtectedRoute). The catch-all router outranks the proxy routes
	// (longer rule → higher priority) and would serve workspace hosts with NO
	// authentication — so suppress it by withholding the domain. The
	// sub-traefik stays internal-only (HTTP :80 over bitswan_network); its
	// inner→container routes come from the REST provider, not docker labels.
	catchAllDomain := domain
	if containerRunning("bitswan-protected-proxy") {
		catchAllDomain = ""
	}
	traefikDockerCompose, err := dockercompose.CreateWorkspaceTraefikDockerComposeFile(workspaceName, traefikConfigForCompose, catchAllDomain, wildcardResolver, stageNetworks)
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

	// Seed the workspace sub-traefik's file-provider state (dynamic.yml). This is
	// a FILE write, not an HTTP call — Traefik's API is disabled — so it no longer
	// depends on the sub-traefik being reachable on :8080 (which no longer exists).
	// Do NOT mutate the process-global BITSWAN_TRAEFIK_HOST: it is shared by every
	// concurrent request, so a global route push racing this window would be
	// redirected into this sub-traefik and dump the entire global route table here.
	if err := traefikapi.InitWorkspaceTraefik(workspaceName); err != nil {
		if verbose {
			fmt.Printf("Warning: failed to seed workspace traefik file-provider state: %v\n", err)
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

	workspaceName := resolveWorkspaceName(req, jwtToken)

	if err := addRouteTraefik(req, workspaceName); err != nil {
		return err
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
	// membership to the workspace's dashboard endpoint, so every member
	// of the workspace can reach what is deployed there at the role they
	// hold on the dashboard — owners own it, access members can open it
	// (see roleFor; delegation never upgrades access→owner). The
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
// repushWorkspaceRoutesToSubTraefik re-applies ALL of a workspace's recorded
// routes (dashboard, gitops, every BP/stage) to its per-workspace sub-traefik.
// The sub-traefik keeps its dynamic config in memory via the REST provider, so
// a freshly-(re)created sub-traefik starts empty; without this re-push only the
// routes touched by the current reconcile would resolve and every other host
// would 404. Idempotent — AddRouteWithTraefik upserts. Cert install is skipped
// (certs were already provisioned when the route was first added).
func repushWorkspaceRoutesToSubTraefik(workspaceName string) {
	// Iterate the protected_routes table — every recorded hostname→upstream —
	// NOT listAllEndpoints: site services (gitops/dashboard/editor) are routes
	// but not owned endpoints, so they're absent from the endpoints table and
	// were the hosts that 404'd through a fresh sub-traefik.
	routes, err := listProtectedRoutes()
	if err != nil {
		return
	}
	subURL := traefikapi.GetWorkspaceTraefikBaseURL(workspaceName)
	// Mirror addRouteTraefik's sub-traefik routes for the active topology:
	//   - protected wrap: the sub-traefik serves the INNER host only (the
	//     platform serves the outer host's wrap and the gate forwards the
	//     post-auth inner request here);
	//   - bare two-tier (no wrap): the sub-traefik serves BOTH outer and inner,
	//     because the platform's HostRegexp catch-all sends every
	//     {workspace}-* host straight here. Restoring inner-only there would
	//     404 every outer host (gitops, dashboard, frontends) until its next
	//     deploy.
	wrapAvailable := containerRunning("bitswan-protected-proxy")
	for _, r := range routes {
		if r.Upstream == "" {
			continue
		}
		label, _, _ := strings.Cut(toOuterHost(r.Hostname), ".")
		if workspaceFromLabel(label) != workspaceName {
			continue
		}
		_ = traefikapi.AddRouteWithTraefik(toInnerHost(r.Hostname), r.Upstream, subURL)
		if !wrapAvailable {
			_ = traefikapi.AddRouteWithTraefik(toOuterHost(r.Hostname), r.Upstream, subURL)
		}
	}
}

// reapplyWorkspaceIngressACLs re-renders every workspace sub-traefik's dynamic
// config so the ingress-only ACL (finding C1) lands on routes written by an
// older daemon — without re-adding routes (traefikapi.EnsureIngressACL is a
// no-op state rewrite, so no route churns). Idempotent: the emitted config is
// identical once applied, so running it on every boot is cheap and safe.
func reapplyWorkspaceIngressACLs() {
	routes, err := listProtectedRoutes()
	if err != nil {
		return
	}
	// One domain per workspace (any of its routes) — needed to recreate a
	// sub-traefik that predates the no-forward sysctl.
	domainByWs := map[string]string{}
	for _, r := range routes {
		label, dom, ok := strings.Cut(toOuterHost(r.Hostname), ".")
		if !ok || dom == "" {
			continue
		}
		ws := workspaceFromLabel(label)
		if ws == "" {
			continue
		}
		if _, dup := domainByWs[ws]; !dup {
			domainByWs[ws] = dom
		}
	}
	for ws, dom := range domainByWs {
		// Recreate the sub-traefik if it predates the ip_forward=0 sysctl (drift
		// check inside initWorkspaceTraefik); a no-op once hardened. The durable
		// file-provider dynamic.yml is preserved across the recreate, so routes
		// survive it.
		if _, ierr := initWorkspaceTraefik(ws, dom, false); ierr != nil {
			fmt.Printf("Warning: could not harden sub-traefik for workspace %q: %v\n", ws, ierr)
		}
		// Ensure the C1 ingress ACL is in the dynamic config (idempotent, no
		// route churn).
		if err := traefikapi.EnsureIngressACL(traefikapi.GetWorkspaceTraefikBaseURL(ws)); err != nil {
			fmt.Printf("Warning: could not apply sub-traefik ingress ACL to workspace %q: %v\n", ws, err)
			continue
		}
		fmt.Printf("Applied stage isolation (ingress ACL + no IP forwarding) to workspace %q\n", ws)
	}
}

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
		// Record the REAL upstream (the container), not the sub-traefik. The
		// gate forwards workspace hosts to the sub-traefik via workspaceFromLabel,
		// not via this record, so protected_routes is consumed only by the
		// sub-traefik re-push and the reconcile in-sync check — both of which
		// want the real container upstream (recording the sub-traefik here would
		// make the re-push push a self-referential route).
		if err := saveProtectedRoute(outer, req.Upstream); err != nil {
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
		// Record the REAL upstream (not the sub-traefik) so repushWorkspace-
		// RoutesToSubTraefik can rebuild this route after the sub-traefik is
		// (re)created — otherwise the platform catch-all captures the host with
		// nothing behind it in the sub-traefik (404). The gate is absent in this
		// topology, so this record is consumed only by the re-push.
		if err := saveProtectedRoute(outer, req.Upstream); err != nil {
			fmt.Printf("Warning: failed to record protected route for %s: %v\n", outer, err)
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
		// its canonical name.
		for _, h := range []string{outer, inner} {
			if err := traefikapi.AddRouteWithTLSDomains(h, req.Upstream, "", certResolver, tlsDomains); err != nil {
				return fmt.Errorf("failed to add route for %s: %w", h, err)
			}
		}
		// Record the upstream so that if a workspace sub-traefik is created
		// later (e.g. the first staged-network deploy), the re-push can rebuild
		// this route through it instead of leaving the catch-all host dangling.
		if err := saveProtectedRoute(outer, req.Upstream); err != nil {
			fmt.Printf("Warning: failed to record protected route for %s: %v\n", outer, err)
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

	_ = traefikapi.RemoveRoute(inner)
	err := traefikapi.RemoveRoute(outer)
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

// UpdateIngress updates the Traefik ingress proxy to the latest version.
// It exports routes, stops the container, regenerates config, restarts, and re-adds routes.
func UpdateIngress(verbose bool) error {
	return updateTraefik(verbose)
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
// upstream the route resolves to changes. The rewrite reuses addRouteTraefik,
// so it is correct across every routing topology (protected wrap, workspace
// sub-traefik, or direct) and replaces the upstream in place.
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

	if err := addRouteTraefik(req, workspaceName); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
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

	// Ensure the per-workspace sub-traefik exists before we push routes to it.
	// It is the multi-homed bridge (bitswan_network + {workspace}-{stage}) that
	// reaches stage-isolated automations the gate itself cannot. initWorkspaceTraefik
	// is idempotent (returns immediately if the container already exists) and
	// also (re)creates the stage networks. Domain is taken from a desired route.
	if len(req.Routes) > 0 {
		if _, dom, ok := strings.Cut(toOuterHost(req.Routes[0].Hostname), "."); ok && dom != "" {
			created, err := initWorkspaceTraefik(req.WorkspaceName, dom, false)
			if err != nil {
				resp.Warnings = append(resp.Warnings, "init workspace sub-traefik: "+err.Error())
			}
			// A freshly (re)created sub-traefik starts with NO routes (its REST
			// config is in-memory), so re-push ALL of this workspace's recorded
			// routes — not just the ones in THIS reconcile — or the dashboard /
			// gitops / other-stage hosts 404 through the gate until their next
			// deploy. Do this ONLY on an actual (re)creation: the steady-state
			// routes are kept current by addRouteTraefik on each deploy, so
			// re-pushing on every reconcile is redundant — it churns the
			// sub-traefik's router table and opens a window where a route can
			// briefly resolve to the wrong upstream mid-reconcile.
			if created {
				repushWorkspaceRoutesToSubTraefik(req.WorkspaceName)
			}
		}
	}

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
		if err := setEndpointSourceBP(outer, "gitops", req.BusinessProcess); err != nil {
			resp.Warnings = append(resp.Warnings,
				fmt.Sprintf("mark %s gitops: %v", outer, err))
		}
		resp.Applied++
	}

	// 2. Prune gitops-managed routes for this workspace that are no longer
	//    desired. Manual routes are not in this list, so they're never pruned.
	//    For a per-BP reconcile only this BP's tagged routes are candidates, so a
	//    one-BP deploy never removes a sibling BP's (or an untagged) route.
	managed, err := listGitopsManagedHosts(req.WorkspaceName, req.BusinessProcess)
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

	var routeInfos []RouteInfo

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
