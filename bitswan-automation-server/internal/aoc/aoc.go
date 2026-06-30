package aoc

import (
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	httplocalhost "github.com/bitswan-space/bitswan-workspaces/internal/http"
	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/oauth"
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
	Count    int                    `json:"count"`
	Next     *string                `json:"next"`
	Previous *string                `json:"previous"`
	Results  []WorkspacePostResponse `json:"results"`
}

// BackupBucketResponse contains S3 credentials and bucket name for workspace backups
type BackupBucketResponse struct {
	BucketName  string `json:"bucket_name"`
	S3Endpoint  string `json:"s3_endpoint"`
	AccessKey   string `json:"access_key"`
	SecretKey   string `json:"secret_key"`
	Region      string `json:"region"`
}

// AOCClient handles AOC API interactions
type AOCClient struct {
	config *config.AutomationServerConfig
	settings      *config.AutomationOperationsCenterSettings
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
		config: cfg,
		settings:      settings,
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
		config: cfg,
		settings:      tempSettings,
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
func (c *AOCClient) ReportBaileyURL(baileyURL string) error {
	payload := map[string]interface{}{
		"bailey_url": baileyURL,
	}

	jsonBytes, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal bailey_url request: %w", err)
	}

	resp, err := c.sendRequest("PATCH", fmt.Sprintf("%s/api/automation_server/info", c.settings.AOCUrl), jsonBytes)
	if err != nil {
		return fmt.Errorf("error sending bailey_url report: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to report bailey_url: %s - %s", resp.Status, string(body))
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

// CreateBackupBucket asks AOC to create an S3 backup bucket for a workspace
func (c *AOCClient) CreateBackupBucket(workspaceId string) (*BackupBucketResponse, error) {
	resp, err := c.sendRequest("POST", fmt.Sprintf("%s/api/automation_server/workspaces/%s/backups/create-bucket/", c.settings.AOCUrl, workspaceId), nil)
	if err != nil {
		return nil, fmt.Errorf("error sending request: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("failed to create backup bucket: %s - %s", resp.Status, string(body))
	}

	var result BackupBucketResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("error decoding response: %w", err)
	}

	return &result, nil
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
}

// GetOrCreateOAuthClient provisions a Keycloak OIDC client for a named
// service (e.g. "bitswan-protected") scoped to this automation server.
// The client_id is deterministic:
// automation-server-{server_id}-{service_name}-client. If the client
// already exists, the redirect_uri is added to its allowlist and the
// existing credentials are returned — safe to call once per hostname.
func (c *AOCClient) GetOrCreateOAuthClient(serviceName, redirectURI string) (*OAuthClientResponse, error) {
	payload := map[string]string{
		"service_name": serviceName,
		"redirect_uri": redirectURI,
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

func generateCookieSecret() (string, error) {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, 32)
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("failed to generate random secret: %w", err)
	}
	for i := range b {
		b[i] = alphabet[int(random[i])%len(alphabet)]
	}
	return string(b), nil
}

func (c *AOCClient) GetOAuthConfig(workspaceId string) (*oauth.Config, error) {
	keycloakInfo, err := c.GetKeycloakClientSecret(workspaceId)
	if err != nil {
		return nil, fmt.Errorf("failed to get Keycloak client secret: %w", err)
	}

	cookieSecret, err := generateCookieSecret()
	if err != nil {
		return nil, fmt.Errorf("failed to generate cookie secret: %w", err)
	}

	provider := "keycloak-oidc"
	httpAddr := "0.0.0.0:9999"
	scope := "openid email profile"
	groupsClaim := "group_membership"

	oauthConfig := &oauth.Config{
		ClientId:      keycloakInfo.ClientID,
		ClientSecret:  keycloakInfo.ClientSecret,
		IssuerUrl:     keycloakInfo.IssuerURL,
		Provider:      &provider,
		HttpAddress:   &httpAddr,
		Scope:         &scope,
		GroupsClaim:   &groupsClaim,
		EmailDomains:  []string{"*"},
		AllowedGroups: []string{},
		CookieSecret:  cookieSecret,
	}
	return oauthConfig, nil
}

// GetAOCEnvironmentVariables creates AOC environment variables
func (c *AOCClient) GetAOCEnvironmentVariables(workspaceId, automationServerToken string) []string {
	aocUrl := c.settings.AOCUrl
	// Replace .localhost hostname with Docker service name for internal communication
	if strings.Contains(aocUrl, ".localhost") {
		aocUrl = "http://api.bitswan.localhost"
	}

	return []string{
		"BITSWAN_WORKSPACE_ID=" + workspaceId,
		"BITSWAN_AOC_URL=" + aocUrl,
		"BITSWAN_AOC_TOKEN=" + automationServerToken,
	}
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
// It automatically retries with Docker network alias if localhost connection fails
func (c *AOCClient) sendRequest(method, requestURL string, payload []byte) (*http.Response, error) {
	var resp *http.Response
	var err error

	// Use the retry wrapper
	err = httplocalhost.RetryWithLocalhostAlias(requestURL, func() error {
		var retryErr error
		resp, retryErr = c.sendRequestOnce(method, requestURL, payload)
		return retryErr
	})

	if err != nil {
		return nil, err
	}

	return resp, nil
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