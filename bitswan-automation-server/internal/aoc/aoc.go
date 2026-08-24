package aoc

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// OTPExchangeRequest represents the OTP exchange request
type OTPExchangeRequest struct {
	OTP                string `json:"otp"`
	AutomationServerId string `json:"automation_server_id"`
}

// OTPExchangeResponse represents the OTP exchange response
type OTPExchangeResponse struct {
	AccessToken        string `json:"access_token"`
	AutomationServerId string `json:"automation_server_id"`
	ExpiresAt          string `json:"expires_at"`
}

// AutomationServerInfo represents the automation server information
type AutomationServerInfo struct {
	Id                 int    `json:"id"`
	Name               string `json:"name"`
	AutomationServerId string `json:"automation_server_id"`
	KeycloakOrgId      string `json:"keycloak_org_id"`
	IsConnected        bool   `json:"is_connected"`
	Domain             string `json:"domain"`
	CreatedAt          string `json:"created_at"`
	UpdatedAt          string `json:"updated_at"`
}

// WorkspacePostResponse represents the response from workspace registration
type WorkspacePostResponse struct {
	Id                 string `json:"id"`
	Name               string `json:"name"`
	AutomationServerId string `json:"automation_server_id"`
	CreatedAt          string `json:"created_at"`
	UpdatedAt          string `json:"updated_at"`
}

// WorkspaceListResponse represents the response from workspace listing
type WorkspaceListResponse struct {
	Count    int                     `json:"count"`
	Next     *string                 `json:"next"`
	Previous *string                 `json:"previous"`
	Results  []WorkspacePostResponse `json:"results"`
}

// AOCClient handles AOC API interactions
type AOCClient struct {
	config   *config.AutomationServerConfig
	settings *config.AutomationOperationsCenterSettings
}

// NewAOCClient creates a new AOC client from the automation server config
// Returns an error if AOC is not configured (no access_token)
func NewAOCClient() (*AOCClient, error) {
	cfg := config.NewAutomationServerConfig()

	settings, err := cfg.GetAutomationOperationsCenterSettings()
	if err != nil {
		return nil, fmt.Errorf("failed to load automation server settings: %w", err)
	}

	// Check if AOC is actually configured (has access_token)
	if settings.AccessToken == "" {
		return nil, fmt.Errorf("AOC not configured: access_token is not set")
	}

	return &AOCClient{
		config:   cfg,
		settings: settings,
	}, nil
}

// NewAOCClientWithToken creates a client from values supplied directly, without
// reading any config file.
//
// For disaster recovery, which runs before a daemon exists and needs to ask the
// AOC whether a token it found in a restored config still works — the "resume a
// half-finished recovery" check, which must not spend another one-time password.
func NewAOCClientWithToken(aocUrl, automationServerId, accessToken string) (*AOCClient, error) {
	if aocUrl == "" || automationServerId == "" || accessToken == "" {
		return nil, fmt.Errorf("aoc url, server id and access token are all required")
	}
	return &AOCClient{
		config: config.NewAutomationServerConfig(),
		settings: &config.AutomationOperationsCenterSettings{
			AOCUrl:             aocUrl,
			AutomationServerId: automationServerId,
			AccessToken:        accessToken,
		},
	}, nil
}

// NewAOCClientWithOTP creates a new AOC client by exchanging OTP for access token
func NewAOCClientWithOTP(aocUrl, otp, automationServerId string) (*AOCClient, error) {
	cfg := config.NewAutomationServerConfig()

	// Create temporary settings for OTP exchange
	tempSettings := &config.AutomationOperationsCenterSettings{
		AOCUrl:             aocUrl,
		AutomationServerId: automationServerId,
	}

	client := &AOCClient{
		config:   cfg,
		settings: tempSettings,
	}

	// Exchange OTP for access token
	accessToken, expiresAt, err := client.ExchangeOTP(otp, automationServerId)
	if err != nil {
		return nil, fmt.Errorf("failed to exchange OTP: %w", err)
	}

	// Update settings with token
	client.settings.AccessToken = accessToken
	client.settings.ExpiresAt = expiresAt

	return client, nil
}

// ExchangeOTP exchanges an OTP for an access token
func (c *AOCClient) ExchangeOTP(otp, automationServerId string) (string, string, error) {
	payload := OTPExchangeRequest{
		OTP:                otp,
		AutomationServerId: automationServerId,
	}

	jsonBytes, err := json.Marshal(payload)
	if err != nil {
		return "", "", fmt.Errorf("failed to marshal OTP request: %w", err)
	}

	resp, err := c.sendRequest("POST", fmt.Sprintf("%s/api/automation_server/exchange-otp", c.settings.AOCUrl), jsonBytes)
	if err != nil {
		return "", "", fmt.Errorf("error sending OTP exchange request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", "", fmt.Errorf("failed to exchange OTP: %s - %s", resp.Status, string(body))
	}

	var otpResponse OTPExchangeResponse
	body, _ := io.ReadAll(resp.Body)
	err = json.Unmarshal([]byte(body), &otpResponse)
	if err != nil {
		return "", "", fmt.Errorf("error decoding OTP response: %w", err)
	}

	return otpResponse.AccessToken, otpResponse.ExpiresAt, nil
}

// GetAutomationServerInfo gets the automation server information
func (c *AOCClient) GetAutomationServerInfo() (*AutomationServerInfo, error) {
	resp, err := c.sendRequest("GET", fmt.Sprintf("%s/api/automation_server/info", c.settings.AOCUrl), nil)
	if err != nil {
		return nil, fmt.Errorf("error sending request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failed to get automation server info: %s", resp.Status)
	}

	var serverInfo AutomationServerInfo
	body, _ := io.ReadAll(resp.Body)
	err = json.Unmarshal([]byte(body), &serverInfo)
	if err != nil {
		return nil, fmt.Errorf("error decoding JSON: %w", err)
	}

	return &serverInfo, nil
}

// ReportBaileyURL self-reports this server's Bailey console URL to the AOC
// (PATCH /api/automation_server/info). The AOC uses it both to link to the
// console and to tell Bailey servers apart from legacy ones. Callers treat
// failures as non-fatal: registration must still succeed against an older AOC
// that predates this endpoint.
// ReportBaileyURL tells the AOC where this server's Bailey console lives. The
// AOC treats this as the "ingress is up" signal and provisions the server's
// public DNS, returning the resulting domain_status ("active" when a direct A
// record works, "proxied" when the server was routed through the relay, or ""
// from an older AOC). The caller uses a "proxied" result to start the tunnel.
func (c *AOCClient) ReportBaileyURL(baileyURL string, forceProxy bool) (string, error) {
	payload := map[string]interface{}{
		"bailey_url": baileyURL,
	}
	// force_proxy tells the AOC to route this server through the relay even if
	// its public IP is reachable — the server-side counterpart of the
	// `register --force-proxy` testing flag, so DNS and domain_status agree with
	// the tunnel the daemon opens.
	if forceProxy {
		payload["force_proxy"] = true
	}

	jsonBytes, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("failed to marshal bailey_url request: %w", err)
	}

	resp, err := c.sendRequest("PATCH", fmt.Sprintf("%s/api/automation_server/info", c.settings.AOCUrl), jsonBytes)
	if err != nil {
		return "", fmt.Errorf("error sending bailey_url report: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("failed to report bailey_url: %s - %s", resp.Status, string(body))
	}

	var out struct {
		DomainStatus string `json:"domain_status"`
	}
	body, _ := io.ReadAll(resp.Body)
	_ = json.Unmarshal(body, &out) // best-effort: older AOC omits domain_status
	return out.DomainStatus, nil
}

// ReportServerVersion tells the AOC which CLI build this server runs.
//
// The version is already recorded inside every backup (the server manifest), but
// restic encrypts contents and metadata and the key is never escrowed — so the
// AOC cannot read it there, and neither can a recovery in progress: it would need
// a running binary to discover which binary to fetch. Reporting it here is what
// lets the AOC hand out a recovery command pinned to this exact release.
//
// supportsRecovery says whether THIS build can perform a whole-server recovery.
// The AOC pins the version only when it can, so a recorded version whose binary
// predates `bitswan recover server` never becomes a command that cannot run.
func (c *AOCClient) ReportServerVersion(version string, supportsRecovery bool) error {
	payload := map[string]interface{}{
		"bailey_version":           version,
		"supports_server_recovery": supportsRecovery,
	}
	jsonBytes, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal version report: %w", err)
	}

	resp, err := c.sendRequest("PATCH", fmt.Sprintf("%s/api/automation_server/info", c.settings.AOCUrl), jsonBytes)
	if err != nil {
		return fmt.Errorf("error sending version report: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to report version: %s - %s", resp.Status, string(body))
	}
	return nil
}

// GetAutomationServerToken gets the automation server token (deprecated, use GetAutomationServerInfo)
func (c *AOCClient) GetAutomationServerToken() (string, error) {
	// For backward compatibility, return the stored access token
	if c.settings.AccessToken == "" {
		return "", fmt.Errorf("no access token available")
	}
	return c.settings.AccessToken, nil
}

// RegisterWorkspace registers a workspace with AOC
func (c *AOCClient) RegisterWorkspace(workspaceName string, domain string) (string, error) {
	payload := map[string]interface{}{
		"name":                 workspaceName,
		"automation_server_id": c.settings.AutomationServerId,
	}

	if domain != "" {
		payload["domain"] = domain
	}

	jsonBytes, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("failed to marshal JSON: %w", err)
	}

	resp, err := c.sendRequest("POST", fmt.Sprintf("%s/api/automation_server/workspaces/", c.settings.AOCUrl), jsonBytes)
	if err != nil {
		return "", fmt.Errorf("error sending request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("failed to register workspace: %s - %s", resp.Status, string(body))
	}

	var workspaceResponse WorkspacePostResponse
	body, _ := io.ReadAll(resp.Body)
	err = json.Unmarshal([]byte(body), &workspaceResponse)
	if err != nil {
		return "", fmt.Errorf("error decoding JSON: %w", err)
	}

	return workspaceResponse.Id, nil
}

// SyncWorkspaceList syncs the workspace list with AOC
// Accepts a list of workspace entries (with id and name) and ensures AOC database matches
func (c *AOCClient) SyncWorkspaceList(workspaces []map[string]interface{}) error {
	payload := map[string]interface{}{
		"workspaces": workspaces,
	}

	jsonBytes, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal JSON: %w", err)
	}

	resp, err := c.sendRequest("POST", fmt.Sprintf("%s/api/automation_server/workspaces/sync/", c.settings.AOCUrl), jsonBytes)
	if err != nil {
		return fmt.Errorf("error sending request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to sync workspace list: %s - %s", resp.Status, string(body))
	}

	return nil
}

// ListWorkspaces lists all workspaces for the automation server
func (c *AOCClient) ListWorkspaces() (*WorkspaceListResponse, error) {
	resp, err := c.sendRequest("GET", fmt.Sprintf("%s/api/automation_server/workspaces/", c.settings.AOCUrl), nil)
	if err != nil {
		return nil, fmt.Errorf("error sending request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to list workspaces: %s - %s", resp.Status, string(body))
	}

	var workspaceList WorkspaceListResponse
	body, _ := io.ReadAll(resp.Body)
	err = json.Unmarshal([]byte(body), &workspaceList)
	if err != nil {
		return nil, fmt.Errorf("error decoding JSON: %w", err)
	}

	return &workspaceList, nil
}

// UpdateWorkspace updates an existing workspace
func (c *AOCClient) UpdateWorkspace(workspaceId, name, description string) error {
	payload := map[string]interface{}{
		"name": name,
	}
	if description != "" {
		payload["description"] = description
	}

	jsonBytes, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal JSON: %w", err)
	}

	resp, err := c.sendRequest("PUT", fmt.Sprintf("%s/api/automation_server/workspaces/%s/", c.settings.AOCUrl, workspaceId), jsonBytes)
	if err != nil {
		return fmt.Errorf("error sending request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to update workspace: %s - %s", resp.Status, string(body))
	}

	return nil
}

// DeleteWorkspace deletes a workspace
func (c *AOCClient) DeleteWorkspace(workspaceId string) error {
	resp, err := c.sendRequest("DELETE", fmt.Sprintf("%s/api/automation_server/workspaces/%s/", c.settings.AOCUrl, workspaceId), nil)
	if err != nil {
		return fmt.Errorf("error sending request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to delete workspace: %s - %s", resp.Status, string(body))
	}

	return nil
}

// KeycloakClientSecretResponse represents the Keycloak client secret response
type KeycloakClientSecretResponse struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	IssuerURL    string `json:"issuer_url"`
}

func (c *AOCClient) GetKeycloakClientSecret(workspaceId string) (*KeycloakClientSecretResponse, error) {
	url := fmt.Sprintf("%s/api/automation_server/workspaces/%s/keycloak/client-secret", c.settings.AOCUrl, workspaceId)
	resp, err := c.sendRequest("GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("error sending request to %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to get Keycloak client secret from %s: %s - %s", url, resp.Status, string(body))
	}

	var response KeycloakClientSecretResponse
	body, _ := io.ReadAll(resp.Body)
	err = json.Unmarshal([]byte(body), &response)
	if err != nil {
		return nil, fmt.Errorf("error decoding JSON: %w", err)
	}

	return &response, nil
}

// OAuthClientResponse represents the response from the server-level
// Keycloak OAuth client endpoint.
type OAuthClientResponse struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	IssuerURL    string `json:"issuer_url"`
	// GroupPath is the org's Keycloak group path (e.g. "/Example Org") —
	// the prefix of every group_membership claim value. Empty when the
	// AOC predates the field or could not resolve the path.
	GroupPath string `json:"group_path"`
}

// GetOrCreateOAuthClient provisions a Keycloak OIDC client for a named
// service (e.g. "bitswan-protected") scoped to this automation server.
// The client_id is deterministic:
// automation-server-{server_id}-{service_name}-client. If the client
// already exists, the redirect_uri is added to its allowlist and the
// existing credentials are returned — safe to call once per hostname.
func (c *AOCClient) GetOrCreateOAuthClient(serviceName, redirectURI string) (*OAuthClientResponse, error) {
	return c.GetOrCreateOAuthClientWithPostLogout(serviceName, redirectURI, "")
}

// GetOrCreateOAuthClientWithPostLogout is GetOrCreateOAuthClient, plus the
// post-logout redirect URI that belongs to the same endpoint.
//
// Keycloak keeps two separate allowlists per client: redirectUris for the
// login callback and post.logout.redirect.uris for where RP-initiated logout
// may land. Since Keycloak 18 the logout target must be registered too, and
// there is no wildcard escape — a host with a callback but no post-logout
// entry logs IN fine and gets "Invalid redirect uri" on the way OUT. Naming
// both in the same request is what keeps the two lists from drifting apart:
// the caller states the pair, the AOC applies the pair.
//
// post_logout_redirect_uri is ignored by AOCs predating that field, which
// derive the twin from redirect_uri themselves — so the pair still lands,
// just without the caller's say in it.
func (c *AOCClient) GetOrCreateOAuthClientWithPostLogout(serviceName, redirectURI, postLogoutRedirectURI string) (*OAuthClientResponse, error) {
	payload := map[string]string{
		"service_name": serviceName,
		"redirect_uri": redirectURI,
	}
	if postLogoutRedirectURI != "" {
		payload["post_logout_redirect_uri"] = postLogoutRedirectURI
	}
	jsonBytes, _ := json.Marshal(payload)
	url := fmt.Sprintf("%s/api/automation_server/keycloak/oauth-client", c.settings.AOCUrl)
	resp, err := c.sendRequest("POST", url, jsonBytes)
	if err != nil {
		return nil, fmt.Errorf("failed to get/create OAuth client: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("OAuth client request failed (%s): %s", resp.Status, string(body))
	}

	var result OAuthClientResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("failed to parse OAuth client response: %w", err)
	}
	return &result, nil
}

// OrgUser is one member of the AOC organization this automation server
// belongs to, as returned by the AOC's org-users endpoint. The org is
// resolved server-side from the bearer token — there is no org id to
// send.
type OrgUser struct {
	ID       string `json:"id"`
	Email    string `json:"email"`
	Username string `json:"username"`
	Verified bool   `json:"verified"`
}

// ListOrgUsers returns the members of this automation server's AOC
// organization. Used by the Server Console's People view to show who
// can be invited.
func (c *AOCClient) ListOrgUsers() ([]OrgUser, error) {
	url := fmt.Sprintf("%s/api/automation_server/org-users", c.settings.AOCUrl)
	resp, err := c.sendRequest("GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("error sending request to %s: %w", url, err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failed to list org users from %s: %s - %s", url, resp.Status, string(body))
	}

	var response struct {
		Users []OrgUser `json:"users"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, fmt.Errorf("error decoding JSON: %w", err)
	}
	return response.Users, nil
}

// GetWorkspaceIdentityEnv is the AOC-derived env a workspace's containers
// receive: the worker identity contract, and nothing else.
//
// It deliberately does NOT hand out BITSWAN_AOC_URL/TOKEN/WORKSPACE_ID any
// more. That token is the SERVER's credential — it authorizes every
// server-scoped AOC endpoint and every sibling workspace's backup bucket —
// and it used to sit in every workspace's gitops env purely so gitops could
// run its own backups. The daemon owns backups now (internal/daemon/backup),
// so no workspace container needs an AOC credential at all. Workspaces shed
// the old env on their next `workspace update`.
func (c *AOCClient) GetWorkspaceIdentityEnv() []string {
	return c.workerIdentityEnv()
}

// workerIdentityEnv resolves the identity contract every deployed worker
// receives: KEYCLOAK_URL (the OIDC issuer workers validate Bearer JWTs
// against) and BITSWAN_ALLOWED_GROUP (the org group path authorization
// matches on). The compiler reads these from its process env and stamps
// them into every worker's compose entry (dockerdriver/entry.go), so a
// fresh workspace gets AOC-mode workers with zero manual env setup.
//
// The values ride the workspace compose (gitops + infra-driver services)
// via GetAOCEnvironmentVariables, cross the git post-receive CGI boundary
// through githttp.go's InheritEnv allowlist, and land in the compiler's
// os.Getenv.
//
// Ambient daemon env wins as an explicit operator override; otherwise the
// values come from the AOC's oauth-client endpoint (idempotent
// get-or-create of the shared bitswan-protected client — the same call
// the protected proxy provisioning makes). BITSWAN_ADMIN_GROUP is only
// propagated when explicitly set: the compiler derives its default
// ({allowed group}/admin) from BITSWAN_ALLOWED_GROUP. Best-effort — a
// missing domain or an AOC that predates group_path just yields fewer
// vars, and workers degrade exactly as before.
//
// BITSWAN_AUTH_MODE=aoc is stamped unconditionally: this function only
// runs on an AOC-connected daemon, and the stamp is the workers' signal
// that identity env SHOULD exist. It deliberately does not depend on the
// fetch succeeding — a worker that sees the stamp without an issuer knows
// the platform is misconfigured (and can refuse to run unverified),
// whereas a worker with neither knows there is simply no identity
// provider to speak of.
func (c *AOCClient) workerIdentityEnv() []string {
	vars := []string{"BITSWAN_AUTH_MODE=aoc"}

	issuer := os.Getenv("KEYCLOAK_URL")
	group := os.Getenv("BITSWAN_ALLOWED_GROUP")

	if (issuer == "" || group == "") && c.settings.Domain != "" {
		resp, err := c.GetOrCreateOAuthClient("bitswan-protected",
			"https://bailey."+c.settings.Domain+"/oauth2/callback")
		if err != nil {
			fmt.Printf("Warning: could not fetch worker identity env from AOC: %v\n", err)
		} else {
			if issuer == "" {
				issuer = resp.IssuerURL
			}
			if group == "" {
				group = resp.GroupPath
			}
		}
	}

	if issuer != "" {
		vars = append(vars, "KEYCLOAK_URL="+issuer)
	}
	if group != "" {
		vars = append(vars, "BITSWAN_ALLOWED_GROUP="+group)
	}
	if admin := os.Getenv("BITSWAN_ADMIN_GROUP"); admin != "" {
		vars = append(vars, "BITSWAN_ADMIN_GROUP="+admin)
	}
	return vars
}

// SetDomain sets the automation server's public domain in the settings
// (persisted on the next SaveConfig call).
func (c *AOCClient) SetDomain(domain string) {
	c.settings.Domain = domain
}

// PresentDNSChallenge publishes an ACME DNS-01 challenge TXT record via the
// AOC. The body shape matches lego's HTTPREQ provider: {fqdn, value}. The AOC
// only allows records under this automation server's own domain.
func (c *AOCClient) PresentDNSChallenge(fqdn, value string) error {
	return c.sendDNSChallenge("present", fqdn, value)
}

// CleanupDNSChallenge removes an ACME DNS-01 challenge TXT record previously
// published via PresentDNSChallenge.
func (c *AOCClient) CleanupDNSChallenge(fqdn, value string) error {
	return c.sendDNSChallenge("cleanup", fqdn, value)
}

func (c *AOCClient) sendDNSChallenge(action, fqdn, value string) error {
	payload := map[string]string{
		"fqdn":  fqdn,
		"value": value,
	}

	jsonBytes, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal DNS challenge request: %w", err)
	}

	resp, err := c.sendRequest("POST", fmt.Sprintf("%s/api/automation_server/dns/acme-challenge/%s", c.settings.AOCUrl, action), jsonBytes)
	if err != nil {
		return fmt.Errorf("error sending DNS challenge %s request: %w", action, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("AOC DNS challenge %s failed: %s - %s", action, resp.Status, string(body))
	}

	return nil
}

// SaveConfig saves the current configuration to the automation server config file
func (c *AOCClient) SaveConfig() error {
	return c.config.UpdateAutomationServer(*c.settings)
}

// createHTTPClient creates an HTTP client that trusts mkcert certificates
func createHTTPClient() (*http.Client, error) {
	// Get the user's home directory
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("failed to get user home directory: %w", err)
	}

	// Path to mkcert root CA
	mkcertPath := filepath.Join(homeDir, ".local", "share", "mkcert", "rootCA.pem")

	// Check if mkcert root CA exists
	if _, err := os.Stat(mkcertPath); os.IsNotExist(err) {
		// If mkcert CA doesn't exist, use default client
		return &http.Client{}, nil
	}

	// Read the mkcert root CA certificate
	caCert, err := os.ReadFile(mkcertPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read mkcert root CA: %w", err)
	}

	// Create a certificate pool that includes system certificates
	caCertPool, err := x509.SystemCertPool()
	if err != nil {
		// Fallback to empty pool if system cert pool fails
		caCertPool = x509.NewCertPool()
	}

	// Add the mkcert root CA to the pool
	if !caCertPool.AppendCertsFromPEM(caCert) {
		return nil, fmt.Errorf("failed to parse mkcert root CA")
	}

	// Create TLS configuration that trusts the mkcert CA
	tlsConfig := &tls.Config{
		RootCAs: caCertPool,
	}

	// Create HTTP client with custom transport
	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: tlsConfig,
		},
	}

	return client, nil
}

// sendRequest is a helper method for making HTTP requests
func (c *AOCClient) sendRequest(method, requestURL string, payload []byte) (*http.Response, error) {
	return c.sendRequestOnce(method, requestURL, payload)
}

// sendRequestOnce performs a single HTTP request without retry logic
func (c *AOCClient) sendRequestOnce(method, requestURL string, payload []byte) (*http.Response, error) {
	req, err := http.NewRequest(method, requestURL, bytes.NewBuffer(payload))
	if err != nil {
		return nil, fmt.Errorf("error creating request: %w", err)
	}

	req.Header.Add("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	if c.settings.AccessToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.settings.AccessToken)
	}

	client, err := createHTTPClient()
	if err != nil {
		return nil, fmt.Errorf("error creating HTTP client: %w", err)
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("error sending request: %w", err)
	}
	return resp, nil
}

// GetAccessToken returns the current access token
func (c *AOCClient) GetAccessToken() string {
	return c.settings.AccessToken
}

// GetExpiresAt returns the access token's expiry (as returned by the AOC at
// OTP exchange), or "" if unknown.
func (c *AOCClient) GetExpiresAt() string {
	return c.settings.ExpiresAt
}

// GetDomain returns the AOC-assigned domain for this automation server.
func (c *AOCClient) GetDomain() string {
	return c.settings.Domain
}
