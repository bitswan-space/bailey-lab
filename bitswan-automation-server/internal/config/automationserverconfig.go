package config

import (
	"fmt"
	"os"
	"os/user"
	"path/filepath"

	"github.com/BurntSushi/toml"
)

// AutomationServerConfig handles reading and writing of Bitswan automation server configuration
type AutomationServerConfig struct {
	configDir string
}

// Config represents the combined TOML configuration
type Config struct {
	ActiveWorkspace string `toml:"active_workspace"`

	// ProtectedDomain overrides the hostname suffix used for protected
	// (Bailey-gated) endpoints. Operators running protected ingress on
	// a dedicated zone (e.g. apps.acme.com) set this so endpoint
	// hostnames render against that suffix instead of the AOC-assigned
	// domain. Empty falls back to the AOC domain.
	ProtectedDomain string `toml:"protected_domain,omitempty"`

	// IngressBindAddress narrows the HOST address Traefik's :80/:443 publishes
	// bind to (e.g. "10.8.0.7", the server's VPN address). Empty publishes on
	// every interface — Docker's default and the historical behaviour.
	//
	// This is the only thing that actually keeps a private server off a public
	// interface: Docker's port publish installs its DNAT ahead of the host INPUT
	// chain, so a ufw/nftables rule cannot close a published port, and DNS
	// pointing elsewhere is not access control (anyone scanning the public
	// address with the right SNI still reaches the ingress).
	IngressBindAddress string `toml:"ingress_bind_address,omitempty"`

	// TLSMode selects how the server's public hostnames get their certificates
	// ("aoc-dns", "manual", …; see daemon.TLSMode). Empty means the default,
	// which every server registered before this option existed relies on.
	TLSMode string `toml:"tls_mode,omitempty"`

	// TLSDNS configures the DNS-01 challenge when TLSMode is "custom-dns" —
	// the operator's own DNS provider rather than the AOC's zone.
	TLSDNS TLSDNSSettings `toml:"tls_dns,omitempty"`

	AutomationOperationsCenter AutomationOperationsCenterSettings `toml:"aoc"`
	LocalServer                LocalServerSettings                `toml:"local_server"`
}

// ProtectedHostnameDomain returns the suffix used for protected
// (Bailey-gated) hostnames. Resolution order: ProtectedDomain (the
// explicit operator override) first, then the AOC-assigned domain —
// the common case: a single public domain with a *.<domain> wildcard
// certificate. Empty means protected ingress isn't configured yet.
func (c *Config) ProtectedHostnameDomain() string {
	if c.ProtectedDomain != "" {
		return c.ProtectedDomain
	}
	return c.AutomationOperationsCenter.Domain
}

// TLSDNSSettings is the operator's own DNS-01 provider: which lego provider to
// use and the environment it needs.
//
// Credentials live here rather than in the daemon's process environment because
// they have to survive a daemon container being recreated, and because the thing
// that consumes them is Traefik — the daemon renders them into Traefik's compose
// file. That file is in the config volume, mode 0600, and IS part of a server
// backup: a restic snapshot of this server therefore contains these credentials
// (encrypted with a key that is never escrowed). Scope the DNS provider token to
// the zone it needs, the way you would any token you hand to an ACME client.
type TLSDNSSettings struct {
	// Provider is a lego DNS provider id, e.g. "cloudflare", "route53",
	// "azuredns" — the value Traefik passes to lego as the challenge provider.
	Provider string `toml:"provider,omitempty"`
	// Credentials are the environment variables that provider reads, e.g.
	// {"CF_DNS_API_TOKEN": "..."}. Rendered verbatim into Traefik's environment.
	Credentials map[string]string `toml:"credentials,omitempty"`
}

// LocalServerSettings represents the local automation server daemon settings
type LocalServerSettings struct {
	Token string `toml:"token"`
}

// AutomationOperationsCenterSettings represents the automation operations center connection settings in TOML
type AutomationOperationsCenterSettings struct {
	AOCUrl             string `toml:"aoc_url"`
	AutomationServerId string `toml:"automation_server_id"`
	AccessToken        string `toml:"access_token"`
	ExpiresAt          string `toml:"expires_at,omitempty"`
	// Domain is the automation server's public domain assigned by the AOC
	// (e.g. acme-prod.bswn.io). When set, the daemon configures Traefik to
	// obtain a DNS-01 wildcard certificate for *.<domain> via the AOC.
	Domain string `toml:"domain,omitempty"`

	// DNSManaged records whether the AOC controls Domain's DNS, as the AOC
	// reported it at registration. It decides whether the ACME bridge can issue
	// anything at all: the bridge writes into the AOC's own hosted zone, so on a
	// domain the AOC does not manage every DNS-01 challenge fails — and fails as
	// a 502 from a DNS endpoint, several minutes into a registration, rather than
	// as anything that names the cause.
	//
	// A POINTER because three states differ. True and false are what the AOC
	// said; nil means nothing said so — an older AOC, or a server registered
	// before this was recorded — and must behave exactly as before, since
	// assuming "not managed" would take every existing server off the wildcard
	// certificate it is already using. Captured at registration; re-register (or
	// set the TLS mode explicitly) if the domain later changes hands.
	DNSManaged *bool `toml:"dns_managed,omitempty"`

	// Proxied means this server has no public inbound route (NAT) — or was
	// forced onto the relay path with `register --force-proxy` — so instead of
	// the AOC pointing an A record straight at us, the AOC points our wildcard
	// record at its relay and the daemon keeps an outbound tunnel to it. When
	// true the daemon runs the relay tunnel client at startup.
	Proxied bool `toml:"proxied,omitempty"`
	// RelayAddr is the relay's public tunnel endpoint (host:port) the daemon
	// dials. Advertised by the AOC; overridable via a register flag for testing.
	RelayAddr string `toml:"relay_addr,omitempty"`
	// RelayFingerprint is the sha256 (hex) of the relay's tunnel-listener leaf
	// certificate, pinned by the daemon so the AOC token in the tunnel handshake
	// can't be intercepted.
	RelayFingerprint string `toml:"relay_fingerprint,omitempty"`

	// Private marks a server that is reached over a private network — a VPN, a
	// ZTNA overlay, or a plain on-prem LAN — rather than the public internet.
	//
	// It is a HARD LOCAL OVERRIDE of the relay decision, not a hint: while it is
	// set the daemon never dials the AOC relay, whatever the AOC reports. That
	// matters because pointing the relay at a NAT'd server is the AOC's uniform
	// default for its own domains (it cannot reliably probe direct
	// reachability), so without this flag a private deployment would be
	// re-exposed through the public relay on the next daemon restart — the one
	// thing a VPN deployment exists to prevent.
	Private bool `toml:"private,omitempty"`
	// PrivateAddress is the address the AOC publishes in DNS for this server
	// (e.g. the VM's VPN address, 10.8.0.7). Recorded so a re-registration or a
	// disaster recovery re-declares the same address instead of relying on an
	// operator to remember it. Informational on the daemon side — the DNS record
	// itself is the AOC's to write.
	PrivateAddress string `toml:"private_address,omitempty"`
}

// GetRealUserHomeDir returns the home directory of the actual user,
// even when running via sudo. It checks SUDO_USER first, then falls back to HOME.
func GetRealUserHomeDir() (string, error) {
	// Check if we're running under sudo
	sudoUser := os.Getenv("SUDO_USER")
	if sudoUser != "" {
		// Look up the original user's home directory
		u, err := user.Lookup(sudoUser)
		if err != nil {
			return "", fmt.Errorf("failed to lookup user %s: %w", sudoUser, err)
		}
		return u.HomeDir, nil
	}

	// Not running under sudo, use HOME or current user
	homeDir := os.Getenv("HOME")
	if homeDir != "" {
		return homeDir, nil
	}

	// Fallback to current user lookup
	u, err := user.Current()
	if err != nil {
		return "", fmt.Errorf("failed to get current user: %w", err)
	}
	return u.HomeDir, nil
}

// NewAutomationServerConfig creates a new automation server configuration manager
func NewAutomationServerConfig() *AutomationServerConfig {
	homeDir, err := GetRealUserHomeDir()
	if err != nil {
		// Fallback to HOME if we can't determine the real user
		homeDir = os.Getenv("HOME")
	}
	return &AutomationServerConfig{
		configDir: filepath.Join(homeDir, ".config", "bitswan"),
	}
}

// NewAutomationServerConfigWithDir returns a config manager rooted at an
// explicit config directory instead of the current user's home. The daemon
// uses this to read the HOST-side CLI config through its /host mount (the
// daemon's own config lives in a Docker volume, so the two stores differ).
func NewAutomationServerConfigWithDir(configDir string) *AutomationServerConfig {
	return &AutomationServerConfig{configDir: configDir}
}

// LoadConfig loads the configuration from the TOML file
func (m *AutomationServerConfig) LoadConfig() (*Config, error) {
	tomlConfigPath := filepath.Join(m.configDir, "automation_server_config.toml")
	if _, err := os.Stat(tomlConfigPath); os.IsNotExist(err) {
		return nil, fmt.Errorf("configuration file not found: %s", tomlConfigPath)
	}
	return m.loadTOMLConfig(tomlConfigPath)
}

// loadTOMLConfig loads configuration from the TOML file
func (m *AutomationServerConfig) loadTOMLConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file %s: %w", path, err)
	}

	var config Config
	if err := toml.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to unmarshal config file %s: %w", path, err)
	}

	return &config, nil
}

// SaveConfig saves the configuration to the TOML file
func (m *AutomationServerConfig) SaveConfig(config *Config) error {
	// Ensure config directory exists
	if err := os.MkdirAll(m.configDir, 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	// Save to TOML config
	if err := m.saveTOMLConfig(config); err != nil {
		return fmt.Errorf("failed to save TOML config: %w", err)
	}

	return nil
}

// saveTOMLConfig saves configuration to the TOML file
func (m *AutomationServerConfig) saveTOMLConfig(config *Config) error {
	tomlConfigPath := filepath.Join(m.configDir, "automation_server_config.toml")

	file, err := os.Create(tomlConfigPath)
	if err != nil {
		return fmt.Errorf("failed to create TOML config file: %w", err)
	}
	defer file.Close()

	if err := toml.NewEncoder(file).Encode(config); err != nil {
		return fmt.Errorf("failed to encode TOML config: %w", err)
	}

	return nil
}

// UpdateAutomationServer updates only the automation server settings
func (m *AutomationServerConfig) UpdateAutomationServer(settings AutomationOperationsCenterSettings) error {
	config, err := m.LoadConfig()
	if err != nil {
		// If no config exists, create a new one
		config = &Config{}
	}

	config.AutomationOperationsCenter = settings
	return m.SaveConfig(config)
}

// GetAutomationOperationsCenterSettings returns the current automation operations center connection settings
func (m *AutomationServerConfig) GetAutomationOperationsCenterSettings() (*AutomationOperationsCenterSettings, error) {
	config, err := m.LoadConfig()
	if err != nil {
		return nil, err
	}

	return &config.AutomationOperationsCenter, nil
}

// GetActiveWorkspace returns the current active workspace
func (m *AutomationServerConfig) GetActiveWorkspace() (string, error) {
	config, err := m.LoadConfig()
	if err != nil {
		return "", err
	}

	return config.ActiveWorkspace, nil
}

// SetActiveWorkspace updates the active workspace setting
func (m *AutomationServerConfig) SetActiveWorkspace(workspace string) error {
	config, err := m.LoadConfig()
	if err != nil {
		// If no config exists, create a new one
		config = &Config{}
	}

	config.ActiveWorkspace = workspace
	return m.SaveConfig(config)
}

// GetLocalServerToken returns the local server daemon token
func (m *AutomationServerConfig) GetLocalServerToken() (string, error) {
	config, err := m.LoadConfig()
	if err != nil {
		return "", err
	}

	if config.LocalServer.Token == "" {
		return "", fmt.Errorf("local server token not configured")
	}

	return config.LocalServer.Token, nil
}

// SetLocalServerToken updates the local server daemon token
func (m *AutomationServerConfig) SetLocalServerToken(token string) error {
	config, err := m.LoadConfig()
	if err != nil {
		// If no config exists, create a new one
		config = &Config{}
	}

	config.LocalServer.Token = token
	return m.SaveConfig(config)
}

// GetIngressBindAddress returns the host address the global Traefik publishes
// its :80/:443 on, or "" for every interface. A missing config file is not an
// error: an unregistered server still runs an ingress, and "no config" means
// "no override".
func (m *AutomationServerConfig) GetIngressBindAddress() string {
	config, err := m.LoadConfig()
	if err != nil {
		return ""
	}
	return config.IngressBindAddress
}

// SetIngressBindAddress records the host address Traefik publishes on. Empty
// clears the override (back to every interface). Applying it is the ingress
// init's job — the rendered compose changes, which the drift check turns into a
// container recreate.
func (m *AutomationServerConfig) SetIngressBindAddress(addr string) error {
	config, err := m.LoadConfig()
	if err != nil {
		// If no config exists, create a new one
		config = &Config{}
	}

	config.IngressBindAddress = addr
	return m.SaveConfig(config)
}

// GetTLSMode returns the configured certificate mode, or "" when the server has
// never set one (the caller substitutes the default). A missing config file is
// not an error for the same reason as GetIngressBindAddress.
func (m *AutomationServerConfig) GetTLSMode() string {
	config, err := m.LoadConfig()
	if err != nil {
		return ""
	}
	return config.TLSMode
}

// SetTLSMode records the certificate mode. Validation belongs to the caller (the
// daemon owns the set of known modes); this only persists the string.
func (m *AutomationServerConfig) SetTLSMode(mode string) error {
	config, err := m.LoadConfig()
	if err != nil {
		// If no config exists, create a new one
		config = &Config{}
	}

	config.TLSMode = mode
	return m.SaveConfig(config)
}

// GetTLSDNS returns the custom DNS-01 provider settings. Never nil-mapped: a
// caller can read Credentials without a nil check.
func (m *AutomationServerConfig) GetTLSDNS() TLSDNSSettings {
	config, err := m.LoadConfig()
	if err != nil {
		return TLSDNSSettings{Credentials: map[string]string{}}
	}
	settings := config.TLSDNS
	if settings.Credentials == nil {
		settings.Credentials = map[string]string{}
	}
	return settings
}

// SetTLSDNS records the custom DNS-01 provider settings. Validation belongs to
// the caller (the daemon owns what a valid provider/credential looks like).
func (m *AutomationServerConfig) SetTLSDNS(settings TLSDNSSettings) error {
	config, err := m.LoadConfig()
	if err != nil {
		// If no config exists, create a new one
		config = &Config{}
	}

	config.TLSDNS = settings
	return m.SaveConfig(config)
}

// ConfigExists checks if any configuration file exists
func (m *AutomationServerConfig) ConfigExists() bool {
	tomlConfigPath := filepath.Join(m.configDir, "automation_server_config.toml")

	_, tomlExists := os.Stat(tomlConfigPath)

	return tomlExists == nil
}

// ClearAOCSettings removes the AOC connection settings while preserving other config
func (m *AutomationServerConfig) ClearAOCSettings() error {
	config, err := m.LoadConfig()
	if err != nil {
		return fmt.Errorf("failed to load config: %w", err)
	}

	config.AutomationOperationsCenter = AutomationOperationsCenterSettings{}
	return m.SaveConfig(config)
}

// GetConfigPath returns the path to the primary TOML config file
func (m *AutomationServerConfig) GetConfigPath() string {
	return filepath.Join(m.configDir, "automation_server_config.toml")
}
