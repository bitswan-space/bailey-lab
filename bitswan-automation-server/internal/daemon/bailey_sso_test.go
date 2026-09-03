package daemon

import (
	"strings"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
	"gopkg.in/yaml.v3"
)

func TestSSORoleForGroups_StrongestMappingWins(t *testing.T) {
	c := ssoConfig{RoleMappings: []ssoRoleMapping{
		{Group: "everyone", Role: roleMember},
		{Group: "platform", Role: roleAdmin},
		{Group: "security", Role: roleAuditor},
	}}
	if got := ssoRoleForGroups(c, []string{"everyone", "security", "platform"}); got != roleAdmin {
		t.Errorf("role = %q, want %q", got, roleAdmin)
	}
	if got := ssoRoleForGroups(c, []string{"everyone"}); got != roleMember {
		t.Errorf("role = %q, want %q", got, roleMember)
	}
}

func TestSSORoleForGroups_UnmappedGroupsLeaveTheDefault(t *testing.T) {
	c := ssoConfig{RoleMappings: []ssoRoleMapping{{Group: "platform", Role: roleAdmin}}}
	if got := ssoRoleForGroups(c, []string{"sales", "marketing"}); got != "" {
		t.Errorf("role = %q, want \"\" so the caller keeps the default", got)
	}
	if got := ssoRoleForGroups(ssoConfig{}, []string{"platform"}); got != "" {
		t.Errorf("role = %q with no mappings, want \"\"", got)
	}
}

func TestSSORoleForGroups_IsCaseInsensitive(t *testing.T) {
	c := ssoConfig{RoleMappings: []ssoRoleMapping{{Group: "CN=Platform,OU=Groups", Role: roleAdmin}}}
	if got := ssoRoleForGroups(c, []string{"cn=platform,ou=groups"}); got != roleAdmin {
		t.Errorf("role = %q, want %q — directory group names vary in case", got, roleAdmin)
	}
}

func TestValidateSSOConfig_RejectsUnusableProviders(t *testing.T) {
	base := ssoConfig{
		DisplayName: "Acme SSO", IssuerURL: "https://id.acme.example",
		ClientID: "bailey", ClientSecret: "s3cret",
	}
	if err := validateSSOConfig(base); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}

	for name, mutate := range map[string]func(c *ssoConfig){
		"no display name":  func(c *ssoConfig) { c.DisplayName = "" },
		"http issuer":      func(c *ssoConfig) { c.IssuerURL = "http://id.acme.example" },
		"garbage issuer":   func(c *ssoConfig) { c.IssuerURL = "not-a-url" },
		"no client id":     func(c *ssoConfig) { c.ClientID = "" },
		"no client secret": func(c *ssoConfig) { c.ClientSecret = "" },
		"bogus role": func(c *ssoConfig) {
			c.RoleMappings = []ssoRoleMapping{{Group: "platform", Role: "superuser"}}
		},
		"mapping with no group": func(c *ssoConfig) {
			c.RoleMappings = []ssoRoleMapping{{Group: "", Role: roleAdmin}}
		},
	} {
		c := base
		mutate(&c)
		if err := validateSSOConfig(c); err == nil {
			t.Errorf("%s: accepted, want rejected", name)
		}
	}
}

func TestBuildDexConfig_KeepsBothConnectors(t *testing.T) {
	aocClient := &aoc.OAuthClientResponse{
		ClientID: "bitswan-protected", ClientSecret: "kc-secret",
		IssuerURL: "https://keycloak.example/realms/master",
	}
	sso := ssoConfig{
		DisplayName: "Acme SSO", IssuerURL: "https://id.acme.example",
		ClientID: "bailey", ClientSecret: "s3cret",
	}

	raw, err := buildDexConfig("acme.bswn.io", aocClient, sso, "proxy-secret")
	if err != nil {
		t.Fatalf("buildDexConfig: %v", err)
	}

	var cfg struct {
		Issuer     string `yaml:"issuer"`
		Connectors []struct {
			ID     string `yaml:"id"`
			Name   string `yaml:"name"`
			Config struct {
				Issuer      string `yaml:"issuer"`
				RedirectURI string `yaml:"redirectURI"`
			} `yaml:"config"`
		} `yaml:"connectors"`
		StaticClients []struct {
			ID           string   `yaml:"id"`
			Secret       string   `yaml:"secret"`
			RedirectURIs []string `yaml:"redirectURIs"`
		} `yaml:"staticClients"`
	}
	if err := yaml.Unmarshal([]byte(raw), &cfg); err != nil {
		t.Fatalf("rendered config is not valid YAML: %v", err)
	}

	if cfg.Issuer != "https://auth.acme.bswn.io" {
		t.Errorf("issuer = %q", cfg.Issuer)
	}
	if len(cfg.Connectors) != 2 {
		t.Fatalf("got %d connectors, want 2 (AOC + customer)", len(cfg.Connectors))
	}
	byID := map[string]string{}
	for _, c := range cfg.Connectors {
		byID[c.ID] = c.Config.Issuer
		if c.Config.RedirectURI != "https://auth.acme.bswn.io/callback" {
			t.Errorf("connector %s redirectURI = %q", c.ID, c.Config.RedirectURI)
		}
	}
	if byID[dexConnectorAOC] != aocClient.IssuerURL {
		t.Errorf("AOC connector issuer = %q, want %q", byID[dexConnectorAOC], aocClient.IssuerURL)
	}
	if byID[dexConnectorSSO] != sso.IssuerURL {
		t.Errorf("SSO connector issuer = %q, want %q", byID[dexConnectorSSO], sso.IssuerURL)
	}

	if len(cfg.StaticClients) != 1 || cfg.StaticClients[0].ID != dexProxyClientID {
		t.Fatalf("static clients = %+v", cfg.StaticClients)
	}
	if got := cfg.StaticClients[0].RedirectURIs; len(got) != 1 || got[0] != "https://bailey.acme.bswn.io/oauth2/callback" {
		t.Errorf("proxy redirect URIs = %v", got)
	}
	if strings.Contains(raw, "enablePasswordDB: true") {
		t.Error("the broker must not enable Dex's local password database")
	}
}

func TestBuildDexConfig_SurvivesAnUnreachableAOC(t *testing.T) {
	sso := ssoConfig{
		DisplayName: "Acme SSO", IssuerURL: "https://id.acme.example",
		ClientID: "bailey", ClientSecret: "s3cret",
	}
	raw, err := buildDexConfig("acme.bswn.io", nil, sso, "proxy-secret")
	if err != nil {
		t.Fatalf("buildDexConfig: %v", err)
	}
	if !strings.Contains(raw, sso.IssuerURL) {
		t.Error("the customer connector must still be rendered when the AOC is unavailable")
	}
	if strings.Contains(raw, "id: "+dexConnectorAOC) {
		t.Error("no AOC client means no AOC connector, not a half-written one")
	}
}

func TestValidateSSOConfig_AllowsPlainHTTPOnlyOnLoopback(t *testing.T) {
	base := ssoConfig{DisplayName: "Dev IdP", ClientID: "bailey", ClientSecret: "s3cret"}

	ok := []string{
		"http://keycloak.bs-e2e.localhost:8088/realms/acme",
		"http://localhost:8088/realms/acme",
		"http://127.0.0.1:8088/realms/acme",
	}
	for _, issuer := range ok {
		c := base
		c.IssuerURL = issuer
		if err := validateSSOConfig(c); err != nil {
			t.Errorf("%s rejected: %v", issuer, err)
		}
	}

	bad := []string{
		"http://id.acme.example",
		"http://notlocalhost.example/realms/acme",
		"http://localhost.evil.example",
	}
	for _, issuer := range bad {
		c := base
		c.IssuerURL = issuer
		if err := validateSSOConfig(c); err == nil {
			t.Errorf("%s accepted over plain http, want rejected", issuer)
		}
	}
}
