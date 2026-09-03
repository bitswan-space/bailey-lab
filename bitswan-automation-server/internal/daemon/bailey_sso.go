package daemon

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const settingSSOConfig = "external_oidc_config"

type ssoRoleMapping struct {
	Group string `json:"group"`
	Role  string `json:"role"`
}

type ssoConfig struct {
	Enabled      bool             `json:"enabled"`
	DisplayName  string           `json:"display_name"`
	IssuerURL    string           `json:"issuer_url"`
	ClientID     string           `json:"client_id"`
	ClientSecret string           `json:"client_secret"`
	GroupsClaim  string           `json:"groups_claim"`
	RoleMappings []ssoRoleMapping `json:"role_mappings"`
	UpdatedAt    string           `json:"updated_at"`
	UpdatedBy    string           `json:"updated_by"`
}

func getSSOConfig() (ssoConfig, error) {
	raw, err := dbGetSetting(settingSSOConfig)
	if err != nil {
		return ssoConfig{}, err
	}
	if strings.TrimSpace(raw) == "" {
		return ssoConfig{}, nil
	}
	var c ssoConfig
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return ssoConfig{}, fmt.Errorf("stored SSO config is corrupt: %w", err)
	}
	return c, nil
}

func setSSOConfig(c ssoConfig, by string) error {
	c.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	c.UpdatedBy = by
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return dbSetSetting(settingSSOConfig, string(b), by)
}

func ssoActive() bool {
	c, err := getSSOConfig()
	if err != nil {
		return false
	}
	return c.Enabled && c.IssuerURL != "" && c.ClientID != "" && c.ClientSecret != ""
}

func validateSSOConfig(c ssoConfig) error {
	if strings.TrimSpace(c.DisplayName) == "" {
		return fmt.Errorf("a display name is required — it labels the button people click to sign in")
	}
	u, err := url.Parse(strings.TrimSpace(c.IssuerURL))
	if err != nil || u.Host == "" {
		return fmt.Errorf("issuer URL must be an https URL")
	}
	if u.Scheme != "https" && !isLoopbackIssuerHost(u.Hostname()) {
		return fmt.Errorf("issuer URL must be an https URL")
	}
	if strings.TrimSpace(c.ClientID) == "" {
		return fmt.Errorf("client ID is required")
	}
	if strings.TrimSpace(c.ClientSecret) == "" {
		return fmt.Errorf("client secret is required")
	}
	for _, m := range c.RoleMappings {
		if strings.TrimSpace(m.Group) == "" {
			return fmt.Errorf("a role mapping needs a group value")
		}
		if !validRole(m.Role) {
			return fmt.Errorf("role mapping for %q has an invalid role %q", m.Group, m.Role)
		}
	}
	return nil
}

func isLoopbackIssuerHost(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	return h == "localhost" || h == "127.0.0.1" || h == "::1" || strings.HasSuffix(h, ".localhost")
}

func discoverSSOIssuer(issuer string) error {
	wellKnown := strings.TrimRight(strings.TrimSpace(issuer), "/") + "/.well-known/openid-configuration"
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(wellKnown)
	if err != nil {
		return fmt.Errorf("could not reach %s: %w", wellKnown, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s returned %s", wellKnown, resp.Status)
	}
	var doc struct {
		Issuer                string `json:"issuer"`
		AuthorizationEndpoint string `json:"authorization_endpoint"`
		TokenEndpoint         string `json:"token_endpoint"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return fmt.Errorf("%s did not return a valid discovery document", wellKnown)
	}
	if doc.AuthorizationEndpoint == "" || doc.TokenEndpoint == "" {
		return fmt.Errorf("%s is missing an authorization or token endpoint", wellKnown)
	}
	return nil
}

func ssoRoleForGroups(c ssoConfig, groups []string) string {
	if len(c.RoleMappings) == 0 || len(groups) == 0 {
		return ""
	}
	have := map[string]bool{}
	for _, g := range groups {
		have[strings.TrimSpace(strings.ToLower(g))] = true
	}
	rank := map[string]int{roleUser: 1, roleMember: 2, roleAuditor: 3, roleAdmin: 4}
	best := ""
	for _, m := range c.RoleMappings {
		if !have[strings.TrimSpace(strings.ToLower(m.Group))] {
			continue
		}
		if best == "" || rank[m.Role] > rank[best] {
			best = m.Role
		}
	}
	return best
}

type ssoConfigDTO struct {
	Enabled      bool             `json:"enabled"`
	DisplayName  string           `json:"display_name"`
	IssuerURL    string           `json:"issuer_url"`
	ClientID     string           `json:"client_id"`
	SecretSet    bool             `json:"secret_set"`
	GroupsClaim  string           `json:"groups_claim"`
	RoleMappings []ssoRoleMapping `json:"role_mappings"`
	UpdatedAt    string           `json:"updated_at,omitempty"`
	UpdatedBy    string           `json:"updated_by,omitempty"`
	CallbackURL  string           `json:"callback_url"`
}

func ssoCallbackURL() string {
	dom := protectedHostnameDomain()
	if dom == "" {
		return ""
	}
	return "https://" + dexHost(dom) + "/callback"
}

func handleSSOGet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	c, err := getSSOConfig()
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, ssoConfigDTO{
		Enabled:      c.Enabled,
		DisplayName:  c.DisplayName,
		IssuerURL:    c.IssuerURL,
		ClientID:     c.ClientID,
		SecretSet:    c.ClientSecret != "",
		GroupsClaim:  c.GroupsClaim,
		RoleMappings: c.RoleMappings,
		UpdatedAt:    c.UpdatedAt,
		UpdatedBy:    c.UpdatedBy,
		CallbackURL:  ssoCallbackURL(),
	})
}

func handleSSOSet(w http.ResponseWriter, r *http.Request, by string) {
	var req ssoConfig
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "bad request", http.StatusBadRequest)
		return
	}

	existing, err := getSSOConfig()
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if strings.TrimSpace(req.ClientSecret) == "" {
		req.ClientSecret = existing.ClientSecret
	}
	req.IssuerURL = strings.TrimRight(strings.TrimSpace(req.IssuerURL), "/")

	if req.Enabled {
		if err := validateSSOConfig(req); err != nil {
			writeJSONCodeError(w, err.Error(), "invalid_config", http.StatusBadRequest)
			return
		}
		if err := discoverSSOIssuer(req.IssuerURL); err != nil {
			writeJSONCodeError(w, err.Error(), "issuer_unreachable", http.StatusBadGateway)
			return
		}
	}

	if err := setSSOConfig(req, by); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if err := reconcileLoginTopology(); err != nil {
		writeJSONCodeError(w, err.Error(), "reconcile_failed", http.StatusBadGateway)
		return
	}

	_ = recordEvent(by, "sso.configure", req.IssuerURL)
	handleSSOGet(w, r)
}

func handleSSOTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		IssuerURL string `json:"issuer_url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := discoverSSOIssuer(req.IssuerURL); err != nil {
		writeJSONCodeError(w, err.Error(), "issuer_unreachable", http.StatusBadGateway)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func applySSORoleMapping(email string, groups []string) {
	if email == "" || len(groups) == 0 {
		return
	}
	if r, _ := dbGetUserRole(email); r != "" {
		return
	}
	c, err := getSSOConfig()
	if err != nil || !c.Enabled {
		return
	}
	role := ssoRoleForGroups(c, groups)
	if role == "" || role == roleMember {
		return
	}
	if err := dbSetUserRole(email, role, "sso:"+c.DisplayName); err == nil {
		_ = recordEvent("sso:"+c.DisplayName, "sso.role.map", email+" -> "+role)
	}
}
