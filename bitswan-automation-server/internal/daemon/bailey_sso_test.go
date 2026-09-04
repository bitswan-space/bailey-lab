package daemon

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
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

func ssoTestStore(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	reopenBaileyDBForTest(t)
	t.Cleanup(func() { reopenBaileyDBForTest(t) })
}

func TestSSOConfigRoundTripsAndStampsWhoChangedIt(t *testing.T) {
	ssoTestStore(t)

	if c, err := getSSOConfig(); err != nil || c.Enabled {
		t.Fatalf("a server with no provider must read back empty and disabled, got %+v (%v)", c, err)
	}
	if ssoActive() {
		t.Error("ssoActive with nothing configured")
	}

	want := ssoConfig{
		Enabled: true, DisplayName: "Acme SSO", IssuerURL: "https://id.acme.example",
		ClientID: "bailey", ClientSecret: "s3cret",
		RoleMappings: []ssoRoleMapping{{Group: "platform", Role: roleAdmin}},
	}
	if err := setSSOConfig(want, "ada@example.com"); err != nil {
		t.Fatalf("setSSOConfig: %v", err)
	}
	got, err := getSSOConfig()
	if err != nil {
		t.Fatalf("getSSOConfig: %v", err)
	}
	if got.DisplayName != want.DisplayName || got.ClientSecret != want.ClientSecret {
		t.Errorf("round trip lost data: %+v", got)
	}
	if got.UpdatedBy != "ada@example.com" || got.UpdatedAt == "" {
		t.Errorf("who/when not stamped: by=%q at=%q", got.UpdatedBy, got.UpdatedAt)
	}
	if !ssoActive() {
		t.Error("ssoActive false with a complete enabled config")
	}

	half := want
	half.ClientSecret = ""
	if err := setSSOConfig(half, "ada@example.com"); err != nil {
		t.Fatal(err)
	}
	if ssoActive() {
		t.Error("an incomplete config must not switch the login topology")
	}
}

func TestGetSSOConfig_CorruptValueIsAnErrorNotAnEmptyConfig(t *testing.T) {
	ssoTestStore(t)
	if err := dbSetSetting(settingSSOConfig, "{not json", "ada@example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := getSSOConfig(); err == nil {
		t.Error("corrupt stored config read back as usable")
	}
	if ssoActive() {
		t.Error("a corrupt config must not be treated as an active provider")
	}
}

func TestDiscoverSSOIssuer(t *testing.T) {
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/openid-configuration" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"issuer":"x","authorization_endpoint":"a","token_endpoint":"t"}`))
	}))
	defer good.Close()
	if err := discoverSSOIssuer(good.URL); err != nil {
		t.Errorf("a valid discovery document was rejected: %v", err)
	}
	if err := discoverSSOIssuer(good.URL + "/"); err != nil {
		t.Errorf("a trailing slash must not matter: %v", err)
	}

	missing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"issuer":"x"}`))
	}))
	defer missing.Close()
	if err := discoverSSOIssuer(missing.URL); err == nil {
		t.Error("a document with no authorization/token endpoint was accepted")
	}

	garbage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`<html>not json</html>`))
	}))
	defer garbage.Close()
	if err := discoverSSOIssuer(garbage.URL); err == nil {
		t.Error("a non-JSON body was accepted as a discovery document")
	}

	gone := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusNotFound)
	}))
	defer gone.Close()
	if err := discoverSSOIssuer(gone.URL); err == nil {
		t.Error("a 404 was accepted")
	}

	if err := discoverSSOIssuer("https://127.0.0.1:1/realms/x"); err == nil {
		t.Error("an unreachable issuer was accepted")
	}
}

func TestHandleSSOGet_NeverReturnsTheClientSecret(t *testing.T) {
	ssoTestStore(t)
	domain := writeTestConfig(t)
	if err := setSSOConfig(ssoConfig{
		Enabled: true, DisplayName: "Acme SSO", IssuerURL: "https://id.acme.example",
		ClientID: "bailey", ClientSecret: "s3cret-do-not-leak",
	}, "ada@example.com"); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	handleSSOGet(w, httptest.NewRequest(http.MethodGet, "/bailey/api/admin/sso", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	body := w.Body.String()
	if strings.Contains(body, "s3cret-do-not-leak") {
		t.Fatal("the client secret was returned to the browser")
	}

	var dto ssoConfigDTO
	if err := json.Unmarshal([]byte(body), &dto); err != nil {
		t.Fatalf("response is not the DTO: %v", err)
	}
	if !dto.SecretSet {
		t.Error("secret_set must tell the UI a secret is stored")
	}
	if dto.CallbackURL != "https://auth."+domain+"/callback" {
		t.Errorf("callback_url = %q", dto.CallbackURL)
	}

	w = httptest.NewRecorder()
	handleSSOGet(w, httptest.NewRequest(http.MethodPost, "/bailey/api/admin/sso", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST to the getter: status = %d", w.Code)
	}
}

func TestHandleSSOSet_RejectsBeforeTouchingTheLoginTopology(t *testing.T) {
	ssoTestStore(t)
	writeTestConfig(t)

	post := func(body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, "/bailey/api/admin/sso", strings.NewReader(body))
		handleSSOSet(w, r, "ada@example.com")
		return w
	}

	if got := post("{not json").Code; got != http.StatusBadRequest {
		t.Errorf("malformed body: status = %d", got)
	}
	if got := post(`{"enabled":true,"display_name":"","issuer_url":"https://id.acme.example","client_id":"b","client_secret":"s"}`).Code; got != http.StatusBadRequest {
		t.Errorf("no display name: status = %d", got)
	}
	if got := post(`{"enabled":true,"display_name":"Acme","issuer_url":"http://id.acme.example","client_id":"b","client_secret":"s"}`).Code; got != http.StatusBadRequest {
		t.Errorf("plain-http issuer: status = %d", got)
	}
	if c, _ := getSSOConfig(); c.Enabled {
		t.Error("a rejected config must not be stored")
	}
}

func TestHandleSSOTest(t *testing.T) {
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"issuer":"x","authorization_endpoint":"a","token_endpoint":"t"}`))
	}))
	defer good.Close()

	w := httptest.NewRecorder()
	handleSSOTest(w, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(`{"issuer_url":"`+good.URL+`"}`)))
	if w.Code != http.StatusOK {
		t.Errorf("reachable issuer: status = %d body=%s", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	handleSSOTest(w, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(`{"issuer_url":"https://127.0.0.1:1"}`)))
	if w.Code != http.StatusBadGateway {
		t.Errorf("unreachable issuer: status = %d", w.Code)
	}

	w = httptest.NewRecorder()
	handleSSOTest(w, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader("{bad")))
	if w.Code != http.StatusBadRequest {
		t.Errorf("malformed body: status = %d", w.Code)
	}

	w = httptest.NewRecorder()
	handleSSOTest(w, httptest.NewRequest(http.MethodGet, "/x", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET: status = %d", w.Code)
	}
}

func TestApplySSORoleMapping(t *testing.T) {
	ssoTestStore(t)
	if err := setSSOConfig(ssoConfig{
		Enabled: true, DisplayName: "Acme SSO", IssuerURL: "https://id.acme.example",
		ClientID: "b", ClientSecret: "s",
		RoleMappings: []ssoRoleMapping{{Group: "platform", Role: roleAdmin}},
	}, "ada@example.com"); err != nil {
		t.Fatal(err)
	}

	applySSORoleMapping("erin@acme.example", []string{"platform"})
	if got := effectiveRole("erin@acme.example"); got != roleAdmin {
		t.Errorf("mapped role = %q, want %q", got, roleAdmin)
	}

	applySSORoleMapping("sam@acme.example", []string{"sales"})
	if got := effectiveRole("sam@acme.example"); got != roleMember {
		t.Errorf("unmapped group should leave the default, got %q", got)
	}

	if err := dbSetUserRole("kim@acme.example", roleMember, "an-admin"); err != nil {
		t.Fatal(err)
	}
	applySSORoleMapping("kim@acme.example", []string{"platform"})
	if got := effectiveRole("kim@acme.example"); got != roleMember {
		t.Errorf("a role set by hand must win over the directory, got %q", got)
	}

	applySSORoleMapping("", []string{"platform"})
	applySSORoleMapping("nobody@acme.example", nil)
	if got := effectiveRole("nobody@acme.example"); got != roleMember {
		t.Errorf("no groups should change nothing, got %q", got)
	}
}

func TestHandleSSOSet_SavesAndReconciles(t *testing.T) {
	ssoTestStore(t)
	writeTestConfig(t)

	reconciled := 0
	orig := applyLoginTopology
	applyLoginTopology = func() error { reconciled++; return nil }
	t.Cleanup(func() { applyLoginTopology = orig })

	issuer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"issuer":"x","authorization_endpoint":"a","token_endpoint":"t"}`))
	}))
	defer issuer.Close()
	t.Setenv("SSO_TEST_ISSUER", issuer.URL)

	body := `{"enabled":true,"display_name":"Acme SSO","issuer_url":"` + issuer.URL +
		`","client_id":"bailey","client_secret":"s3cret","role_mappings":[{"group":"platform","role":"admin"}]}`
	w := httptest.NewRecorder()
	handleSSOSet(w, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body)), "ada@example.com")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", w.Code, w.Body.String())
	}
	if reconciled != 1 {
		t.Errorf("login topology reconciled %d times, want 1", reconciled)
	}
	stored, err := getSSOConfig()
	if err != nil || !stored.Enabled || stored.ClientSecret != "s3cret" {
		t.Fatalf("stored = %+v (%v)", stored, err)
	}

	body = `{"enabled":true,"display_name":"Acme SSO renamed","issuer_url":"` + issuer.URL +
		`","client_id":"bailey","client_secret":""}`
	w = httptest.NewRecorder()
	handleSSOSet(w, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body)), "ada@example.com")
	if w.Code != http.StatusOK {
		t.Fatalf("resave status = %d body = %s", w.Code, w.Body.String())
	}
	stored, _ = getSSOConfig()
	if stored.ClientSecret != "s3cret" {
		t.Errorf("an empty secret must keep the stored one, got %q", stored.ClientSecret)
	}
	if stored.DisplayName != "Acme SSO renamed" {
		t.Errorf("display name not updated: %q", stored.DisplayName)
	}

	w = httptest.NewRecorder()
	handleSSOSet(w, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(`{"enabled":false}`)), "ada@example.com")
	if w.Code != http.StatusOK {
		t.Fatalf("disable status = %d", w.Code)
	}
	if ssoActive() {
		t.Error("still active after disabling")
	}
	if reconciled != 3 {
		t.Errorf("reconciled %d times, want 3", reconciled)
	}
}

func TestHandleSSOSet_SurfacesAReconcileFailure(t *testing.T) {
	ssoTestStore(t)
	writeTestConfig(t)
	orig := applyLoginTopology
	applyLoginTopology = func() error { return fmt.Errorf("broker would not start") }
	t.Cleanup(func() { applyLoginTopology = orig })

	w := httptest.NewRecorder()
	handleSSOSet(w, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(`{"enabled":false}`)), "ada@example.com")
	if w.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502 so the admin sees the broker failed", w.Code)
	}
}

func TestHandleSSOGet_SurfacesACorruptConfig(t *testing.T) {
	ssoTestStore(t)
	if err := dbSetSetting(settingSSOConfig, "{nope", "ada@example.com"); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	handleSSOGet(w, httptest.NewRequest(http.MethodGet, "/x", nil))
	if w.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", w.Code)
	}
}

func TestSSOCallbackURL_EmptyWithoutADomain(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	if got := ssoCallbackURL(); got != "" {
		t.Errorf("callback URL = %q on a server with no domain, want empty", got)
	}
}

func TestHandleSSOSet_RefusesToBuildOnACorruptStoredConfig(t *testing.T) {
	ssoTestStore(t)
	writeTestConfig(t)
	if err := dbSetSetting(settingSSOConfig, "{nope", "ada@example.com"); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	handleSSOSet(w, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(`{"enabled":false}`)), "ada@example.com")
	if w.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500 rather than silently overwriting an unreadable config", w.Code)
	}
}

func dexConnectorScopes(t *testing.T, raw string) map[string][]string {
	t.Helper()
	var cfg struct {
		Connectors []struct {
			ID     string `yaml:"id"`
			Config struct {
				Scopes []string `yaml:"scopes"`
			} `yaml:"config"`
		} `yaml:"connectors"`
	}
	if err := yaml.Unmarshal([]byte(raw), &cfg); err != nil {
		t.Fatalf("rendered config is not valid YAML: %v", err)
	}
	out := map[string][]string{}
	for _, c := range cfg.Connectors {
		out[c.ID] = c.Config.Scopes
	}
	return out
}

func TestBuildDexConfig_AsksEveryUpstreamForARefreshableSession(t *testing.T) {
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

	for _, id := range []string{dexConnectorAOC, dexConnectorSSO} {
		scopes := dexConnectorScopes(t, raw)[id]
		if !slices.Contains(scopes, "offline_access") {
			t.Errorf("connector %s scopes = %v, want offline_access — without it the upstream "+
				"refresh token dies with the sign-in session and every brokered session breaks", id, scopes)
		}
	}
}
