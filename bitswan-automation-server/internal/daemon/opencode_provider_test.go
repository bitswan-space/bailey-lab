package daemon

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const openCodeProviderPath = "/bailey/api/admin/opencode-provider"

// A slice of models.dev with the shapes that matter: one-key providers, one
// whose several names are alternatives (google), one with a setting next to
// its key (azure), one with a document (vertex), one with a bearer token or
// an access-key pair (bedrock), and the sign-in-only Copilot.
const catalogFixture = `{
  "anthropic": {"name": "Anthropic", "env": ["ANTHROPIC_API_KEY"], "models": {"claude-sonnet-4-5": {"name": "Claude Sonnet 4.5"}, "claude-opus-4-1": {"name": "Claude Opus 4.1"}}},
  "openai": {"name": "OpenAI", "env": ["OPENAI_API_KEY"], "models": {"gpt-5": {"name": "GPT-5"}}},
  "google": {"name": "Google", "env": ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"], "models": {"gemini-2.5-pro": {"name": "Gemini 2.5 Pro"}}},
  "openrouter": {"name": "OpenRouter", "env": ["OPENROUTER_API_KEY"], "models": {"anthropic/claude-sonnet-4.5": {"name": "Claude Sonnet 4.5"}}},
  "mistral": {"name": "Mistral", "env": ["MISTRAL_API_KEY"], "models": {"mistral-large-latest": {"name": "Mistral Large"}}},
  "groq": {"name": "Groq", "env": ["GROQ_API_KEY"], "models": {"llama-3.3-70b-versatile": {"name": "Llama 3.3 70B"}}},
  "xai": {"name": "xAI", "env": ["XAI_API_KEY"], "models": {"grok-4.7": {"name": "Grok 4.7"}}},
  "deepseek": {"name": "DeepSeek", "env": ["DEEPSEEK_API_KEY"], "models": {"deepseek-v4-pro": {"name": "DeepSeek V4 Pro"}}},
  "opencode": {"name": "OpenCode Zen", "env": ["OPENCODE_API_KEY"], "models": {"gpt-5": {"name": "GPT-5"}}},
  "azure": {"name": "Azure", "env": ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"], "models": {"gpt-5": {"name": "GPT-5"}}},
  "google-vertex": {"name": "Google Vertex", "env": ["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"], "models": {"gemini-2.5-pro": {"name": "Gemini 2.5 Pro"}}},
  "amazon-bedrock": {"name": "Amazon Bedrock", "env": ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_BEARER_TOKEN_BEDROCK"], "models": {"anthropic.claude-sonnet-4-5": {"name": "Claude Sonnet 4.5"}}},
  "github-copilot": {"name": "GitHub Copilot", "env": ["GITHUB_TOKEN"], "models": {"gpt-5": {"name": "GPT-5"}}},
  "302ai": {"name": "302.AI", "env": ["302AI_API_KEY"], "models": {"MiniMax-M1": {"name": "MiniMax M1"}}}
}`

// isolateOpenCodeProviderTest gives the test a HOME and a bailey.db of its own
// (the sync walks every workspace under HOME, and the catalogue cache sits
// there too), the fixture catalogue in place of models.dev, and a stand-in
// for the chown the daemon does as root. Returns a counter of fetches.
func isolateOpenCodeProviderTest(t *testing.T) *int {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	reopenBaileyDBForTest(t)
	t.Cleanup(func() { reopenBaileyDBForTest(t) })
	prevChown := chownToAgent
	chownToAgent = func(string) error { return nil }
	prevFetch := fetchModelsDev
	fetches := 0
	fetchModelsDev = func() ([]byte, error) { fetches++; return []byte(catalogFixture), nil }
	openCodeCatalogCached = nil
	t.Cleanup(func() {
		chownToAgent = prevChown
		fetchModelsDev = prevFetch
		openCodeCatalogCached = nil
	})
	return &fetches
}

func openCodeAdminJSON(method, body string) *http.Request {
	r := baileyReqBody(method, openCodeProviderPath, "boss@example.com", body)
	r.Header.Set("X-Forwarded-Groups", adminGrp)
	return r
}

func decodeProviderDTO(t *testing.T, body string) openCodeProviderDTO {
	t.Helper()
	var d openCodeProviderDTO
	if err := json.Unmarshal([]byte(body), &d); err != nil {
		t.Fatalf("decode: %v\n%s", err, body)
	}
	return d
}

// vars is the fixture's env list for a provider, as the handler would set it.
func vars(t *testing.T, id string) []openCodeEnvVar {
	t.Helper()
	p, ok, err := openCodeProviderByID(id)
	if err != nil || !ok {
		t.Fatalf("fixture has no %s: %v", id, err)
	}
	return p.Env
}

func withAgentWorkspace(t *testing.T, ws string, dirs ...string) string {
	t.Helper()
	dir := mkWorkspaceDir(t, ws, true)
	if err := os.WriteFile(filepath.Join(dir, "deployment", "docker-compose-coding-agent.yml"), []byte("services: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, d := range dirs {
		if err := os.MkdirAll(filepath.Join(dir, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

/*
The catalogue is models.dev, read live: what /connect offers, minus the
sign-in-only providers, with each variable classified from its name.
*/
func TestOpenCodeCatalog_ReadsModelsDev(t *testing.T) {
	fetches := isolateOpenCodeProviderTest(t)
	cat, err := loadOpenCodeCatalog()
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]openCodeProvider{}
	for _, p := range cat.Providers {
		ids[p.ID] = p
	}
	if _, ok := ids["github-copilot"]; ok {
		t.Errorf("Copilot is sign-in only and must not be offered")
	}
	if _, ok := ids["302ai"]; !ok {
		t.Errorf("the long tail is offered")
	}
	popular := 0
	for _, p := range cat.Providers {
		if p.Popular {
			popular++
		}
	}
	if popular != 9 {
		t.Errorf("popular = %d, want 9", popular)
	}
	if az := ids["azure"]; len(az.Env) != 2 || az.Env[0].Secret || !az.Env[1].Secret || az.allSecrets() {
		t.Errorf("azure vars = %+v; want a plain resource name and a secret key", az.Env)
	}
	if g := ids["google"]; !g.allSecrets() || len(g.Env) != 3 {
		t.Errorf("google vars = %+v; want three alternative secrets", g.Env)
	}
	if v := ids["google-vertex"]; v.Env[0].Secret || v.Env[1].Secret || !v.Env[2].File || !v.Env[2].Secret {
		t.Errorf("vertex vars = %+v; want project and location plain and a credentials file", v.Env)
	}
	if b := ids["amazon-bedrock"]; !b.Env[0].Secret || !b.Env[1].Secret || b.Env[2].Secret || !b.Env[3].Secret {
		t.Errorf("bedrock vars = %+v; want the region plain and the key id, secret key and bearer token secret", b.Env)
	}
	if m := cat.Models["anthropic"]; len(m) != 2 || m[0].ID != "claude-opus-4-1" || m[1].Name != "Claude Sonnet 4.5" {
		t.Errorf("anthropic models = %+v", m)
	}
	if ids["anthropic"].ModelCount != 2 {
		t.Errorf("model count not carried")
	}

	// Fresh: served from memory. Then, with models.dev gone, from the on-disk
	// copy of the last fetch; with neither, an error and nothing else.
	if _, err := loadOpenCodeCatalog(); err != nil || *fetches != 1 {
		t.Fatalf("second load: %v, fetches %d", err, *fetches)
	}
	openCodeCatalogCached = nil
	fetchModelsDev = func() ([]byte, error) { return nil, errors.New("offline") }
	cat2, err := loadOpenCodeCatalog()
	if err != nil || len(cat2.Providers) != len(cat.Providers) {
		t.Fatalf("offline with a cache: %v", err)
	}
	if time.Since(cat2.FetchedAt) < openCodeCatalogTTL {
		t.Errorf("a served-from-disk copy must not count as fresh, or models.dev is never tried again")
	}
	openCodeCatalogCached = nil
	if err := os.Remove(openCodeCatalogCachePath()); err != nil {
		t.Fatal(err)
	}
	if _, err := loadOpenCodeCatalog(); err == nil {
		t.Fatalf("no models.dev and no copy: expected an error, not a built-in fallback")
	}
	fetchModelsDev = func() ([]byte, error) { return []byte("{}"), nil }
	if _, err := loadOpenCodeCatalog(); err == nil {
		t.Fatalf("an empty catalogue is an error")
	}
}

// The console shows words, never variable names: the provider's own name is
// dropped and the rest spelled out.
func TestOpenCodeCatalog_LabelsAreWords(t *testing.T) {
	for _, c := range []struct{ provider, name, want string }{
		{"azure", "AZURE_RESOURCE_NAME", "Resource name"},
		{"azure", "AZURE_API_KEY", "API key"},
		{"amazon-bedrock", "AWS_REGION", "Region"},
		{"amazon-bedrock", "AWS_ACCESS_KEY_ID", "Access key ID"},
		{"amazon-bedrock", "AWS_SECRET_ACCESS_KEY", "Secret access key"},
		{"amazon-bedrock", "AWS_BEARER_TOKEN_BEDROCK", "Bearer token"},
		{"google-vertex", "GOOGLE_VERTEX_PROJECT", "Project"},
		{"google-vertex", "GOOGLE_VERTEX_LOCATION", "Location"},
		{"google-vertex", "GOOGLE_APPLICATION_CREDENTIALS", "Application credentials"},
		{"cloudflare-ai-gateway", "CLOUDFLARE_ACCOUNT_ID", "Account ID"},
		{"cloudflare-ai-gateway", "CLOUDFLARE_GATEWAY_ID", "Gateway ID"},
		{"cloudflare-ai-gateway", "CLOUDFLARE_API_TOKEN", "API token"},
		{"databricks", "DATABRICKS_HOST", "Host"},
		{"snowflake-cortex", "SNOWFLAKE_CORTEX_PAT", "Personal access token"},
		{"snowflake-cortex", "SNOWFLAKE_ACCOUNT", "Account"},
		{"watsonx", "WATSONX_AI_APIKEY", "API key"},
		{"watsonx", "WATSONX_AI_PROJECT_ID", "Project ID"},
		{"neon", "NEON_AI_GATEWAY_BASE_URL", "Gateway base URL"},
		{"infomaniak", "INFOMANIAK_PRODUCT_ID", "Product ID"},
		{"privatemode-ai", "PRIVATEMODE_ENDPOINT", "Endpoint"},
		{"anthropic", "ANTHROPIC_API_KEY", "API key"},
		{"google", "GEMINI_API_KEY", "Gemini API key"},
		{"huggingface", "HF_TOKEN", "Hugging Face token"},
	} {
		if got := labelForEnvVar(c.provider, c.name); got != c.want {
			t.Errorf("%s/%s: label %q, want %q", c.provider, c.name, got, c.want)
		}
	}
}

/*
The file is sourced by bash. A key that contains a quote, a dollar, a
backslash or a backtick must come out of the shell exactly as it went in —
which is what single quotes guarantee and double quotes do not.
*/
func TestOpenCodeProviderEnv_RenderQuotesForTheShell(t *testing.T) {
	isolateOpenCodeProviderTest(t)
	key := "sk-it's$weird\\and`quoted`"
	cfg := openCodeProviderConfig{Enabled: true, Provider: "anthropic", Model: "claude-sonnet-4-5", Vars: vars(t, "anthropic"),
		Values: map[string]string{"ANTHROPIC_API_KEY": key}, Restrict: true}
	got := renderOpenCodeProviderEnv(cfg)
	want := "BITSWAN_OPENCODE_PROVIDER='anthropic'\n" +
		"BITSWAN_OPENCODE_PROVIDER_ENV='ANTHROPIC_API_KEY'\n" +
		"BITSWAN_OPENCODE_MODEL='claude-sonnet-4-5'\n" +
		"BITSWAN_OPENCODE_RESTRICT='true'\n" +
		"ANTHROPIC_API_KEY='sk-it'\\''s$weird\\and`quoted`'\n"
	if !strings.HasSuffix(got, want) || !strings.HasPrefix(got, "# ") {
		t.Fatalf("rendered:\n%s\nwant a comment header and then:\n%s", got, want)
	}

	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh to source the file with")
	}
	path := filepath.Join(t.TempDir(), openCodeProviderEnvFile)
	if err := os.WriteFile(path, []byte(got), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(sh, "-c", `. "$1" && printf '%s\n%s\n%s' "$ANTHROPIC_API_KEY" "$BITSWAN_OPENCODE_MODEL" "$BITSWAN_OPENCODE_RESTRICT"`, "sh", path).Output()
	if err != nil {
		t.Fatalf("sourcing the file: %v", err)
	}
	if string(out) != key+"\nclaude-sonnet-4-5\ntrue" {
		t.Fatalf("the shell read back %q", out)
	}

	// A setting next to the key is one more line; the launcher's check names
	// the secret, not the setting.
	azure := openCodeProviderConfig{Enabled: true, Provider: "azure", Model: "gpt-5", Vars: vars(t, "azure"),
		Values: map[string]string{"AZURE_RESOURCE_NAME": "acme-eu", "AZURE_API_KEY": "az-key"}}
	if got := renderOpenCodeProviderEnv(azure); !strings.Contains(got, "BITSWAN_OPENCODE_PROVIDER_ENV='AZURE_API_KEY'\n") ||
		!strings.Contains(got, "AZURE_RESOURCE_NAME='acme-eu'\nAZURE_API_KEY='az-key'\n") {
		t.Fatalf("azure rendered:\n%s", got)
	}

	// Disabled or incomplete: no file at all.
	for i, c := range []openCodeProviderConfig{
		{Enabled: false, Provider: "anthropic", Model: "m", Vars: vars(t, "anthropic"), Values: map[string]string{"ANTHROPIC_API_KEY": "k"}},
		{Enabled: true, Provider: "anthropic", Model: "", Vars: vars(t, "anthropic"), Values: map[string]string{"ANTHROPIC_API_KEY": "k"}},
		{Enabled: true, Provider: "anthropic", Model: "m", Vars: vars(t, "anthropic")},
		{Enabled: true, Provider: "azure", Model: "m", Vars: vars(t, "azure"), Values: map[string]string{"AZURE_API_KEY": "k"}},
	} {
		if r := renderOpenCodeProviderEnv(c); r != "" {
			t.Errorf("case %d: rendered a file for %+v:\n%s", i, c, r)
		}
	}
}

func TestOpenCodeProvider_Validation(t *testing.T) {
	isolateOpenCodeProviderTest(t)
	ok := []openCodeProviderConfig{
		{},
		{Enabled: false, Provider: "openai"},
		{Enabled: true, Provider: "openai", Model: "gpt-5", Vars: vars(t, "openai"), Values: map[string]string{"OPENAI_API_KEY": "sk-123"}},
		// Google's three names are alternatives: one is enough.
		{Enabled: true, Provider: "google", Model: "gemini-2.5-pro", Vars: vars(t, "google"), Values: map[string]string{"GEMINI_API_KEY": "k"}},
		// Bedrock: the region, and either a bearer token or a key pair.
		{Enabled: true, Provider: "amazon-bedrock", Model: "m", Vars: vars(t, "amazon-bedrock"), Values: map[string]string{"AWS_REGION": "eu-central-1", "AWS_BEARER_TOKEN_BEDROCK": "t"}},
		{Enabled: true, Provider: "amazon-bedrock", Model: "m", Vars: vars(t, "amazon-bedrock"), Values: map[string]string{"AWS_REGION": "eu-central-1", "AWS_ACCESS_KEY_ID": "AKIA", "AWS_SECRET_ACCESS_KEY": "s"}},
		// A credentials document is JSON.
		{Enabled: true, Provider: "google-vertex", Model: "m", Vars: vars(t, "google-vertex"), Values: map[string]string{"GOOGLE_VERTEX_PROJECT": "p", "GOOGLE_VERTEX_LOCATION": "europe-west1", "GOOGLE_APPLICATION_CREDENTIALS": "{\"type\": \"service_account\"}"}},
		// OpenRouter model ids carry a slash of their own; OpenCode splits on the first.
		{Enabled: true, Provider: "openrouter", Model: "anthropic/claude-sonnet-4.5", Vars: vars(t, "openrouter"), Values: map[string]string{"OPENROUTER_API_KEY": "k"}},
	}
	for i, c := range ok {
		if err := validateOpenCodeProvider(c); err != nil {
			t.Errorf("ok case %d rejected: %v", i, err)
		}
	}
	bad := []openCodeProviderConfig{
		{Enabled: true, Provider: "openai", Model: "", Vars: vars(t, "openai"), Values: map[string]string{"OPENAI_API_KEY": "k"}},
		{Enabled: true, Provider: "openai", Model: "gpt#5", Vars: vars(t, "openai"), Values: map[string]string{"OPENAI_API_KEY": "k"}},
		{Enabled: true, Provider: "openai", Model: "gpt 5", Vars: vars(t, "openai"), Values: map[string]string{"OPENAI_API_KEY": "k"}},
		// no key
		{Enabled: true, Provider: "openai", Model: "gpt-5", Vars: vars(t, "openai")},
		// a value for something the provider does not read
		{Enabled: true, Provider: "openai", Model: "gpt-5", Vars: vars(t, "openai"), Values: map[string]string{"OPENAI_API_KEY": "k", "AZURE_API_KEY": "x"}},
		// a key with a newline
		{Enabled: true, Provider: "openai", Model: "gpt-5", Vars: vars(t, "openai"), Values: map[string]string{"OPENAI_API_KEY": "k\nEVIL=1"}},
		// Azure without its resource name; Bedrock without a region or without a secret
		{Enabled: true, Provider: "azure", Model: "gpt-5", Vars: vars(t, "azure"), Values: map[string]string{"AZURE_API_KEY": "k"}},
		// (An access-key id without its secret key passes here — which of a
		// provider's secrets go together is the provider's to say, and
		// OpenCode refuses the pair at request time.)
		{Enabled: true, Provider: "amazon-bedrock", Model: "m", Vars: vars(t, "amazon-bedrock"), Values: map[string]string{"AWS_BEARER_TOKEN_BEDROCK": "t"}},
		// a credentials document that is not JSON
		{Enabled: true, Provider: "google-vertex", Model: "m", Vars: vars(t, "google-vertex"), Values: map[string]string{"GOOGLE_VERTEX_PROJECT": "p", "GOOGLE_VERTEX_LOCATION": "l", "GOOGLE_APPLICATION_CREDENTIALS": "not json"}},
		// no variables at all
		{Enabled: true, Provider: "openai", Model: "gpt-5"},
	}
	for i, c := range bad {
		if err := validateOpenCodeProvider(c); err == nil {
			t.Errorf("bad case %d accepted: %+v", i, c)
		}
	}
}

func TestOpenCodeProvider_NonAdminForbidden(t *testing.T) {
	if w := dispatch(baileyReq(http.MethodGet, openCodeProviderPath, "user@example.com")); w.Code != http.StatusForbidden {
		t.Errorf("GET non-admin = %d, want 403", w.Code)
	}
	if w := dispatch(baileyReqBody(http.MethodPost, openCodeProviderPath, "user@example.com", "{}")); w.Code != http.StatusForbidden {
		t.Errorf("POST non-admin = %d, want 403", w.Code)
	}
	if w := dispatch(baileyReq(http.MethodGet, openCodeProviderPath+"/models?provider=openai", "user@example.com")); w.Code != http.StatusForbidden {
		t.Errorf("GET models non-admin = %d, want 403", w.Code)
	}
}

func TestOpenCodeProvider_SaveKeepDisableClear(t *testing.T) {
	isolateOpenCodeProviderTest(t)

	w := dispatch(baileyReq(http.MethodGet, openCodeProviderPath, "boss@example.com", adminGrp))
	if w.Code != http.StatusOK {
		t.Fatalf("GET = %d; %s", w.Code, w.Body.String())
	}
	if d := decodeProviderDTO(t, w.Body.String()); d.Enabled || len(d.Secrets) != 0 || len(d.Providers) != 13 || d.CatalogError != "" {
		t.Fatalf("fresh GET = %+v", d)
	}

	// Save Azure: a resource name next to the key. The response is the GET
	// shape, the setting echoed, the key not.
	const key = "az-0123456789abcdef"
	w = dispatch(openCodeAdminJSON(http.MethodPost, `{"enabled":true,"provider":"azure","model":"gpt-5","values":{"AZURE_RESOURCE_NAME":" acme-eu ","AZURE_API_KEY":"`+key+`"},"restrict":true}`))
	if w.Code != http.StatusOK {
		t.Fatalf("POST = %d; %s", w.Code, w.Body.String())
	}
	d := decodeProviderDTO(t, w.Body.String())
	if !d.Enabled || d.Provider != "azure" || d.Model != "gpt-5" || !d.Restrict || d.UpdatedBy != "boss@example.com" || d.UpdatedAt == "" {
		t.Fatalf("after save: %+v", d)
	}
	if d.Values["AZURE_RESOURCE_NAME"] != "acme-eu" || !d.Secrets["AZURE_API_KEY"].Set || d.Secrets["AZURE_API_KEY"].Hint != "cdef" || len(d.Vars) != 2 {
		t.Fatalf("values/secrets after save: %+v %+v %+v", d.Values, d.Secrets, d.Vars)
	}
	if strings.Contains(w.Body.String(), key[:10]) {
		t.Fatalf("the key is in the response: %s", w.Body.String())
	}

	// A blank secret keeps the stored one while a setting changes.
	w = dispatch(openCodeAdminJSON(http.MethodPost, `{"enabled":true,"provider":"azure","model":"gpt-5","values":{"AZURE_RESOURCE_NAME":"acme-us","AZURE_API_KEY":"  "},"restrict":false}`))
	if w.Code != http.StatusOK {
		t.Fatalf("POST blank key = %d; %s", w.Code, w.Body.String())
	}
	if d = decodeProviderDTO(t, w.Body.String()); d.Values["AZURE_RESOURCE_NAME"] != "acme-us" || d.Restrict || d.Secrets["AZURE_API_KEY"].Hint != "cdef" {
		t.Fatalf("after blank-key save: %+v", d)
	}
	if c, _ := getOpenCodeProvider(); c.Values["AZURE_API_KEY"] != key {
		t.Fatalf("stored key changed to %q", c.Values["AZURE_API_KEY"])
	}

	// Bad input is refused and changes nothing.
	for _, body := range []string{
		`{"enabled":true,"provider":"nope","model":"x","values":{"X":"k"}}`,
		`{"enabled":true,"provider":"github-copilot","model":"gpt-5","values":{"GITHUB_TOKEN":"k"}}`,
		`{"enabled":true,"provider":"azure","model":"gpt-5","values":{"AZURE_API_KEY":"k"}}`,
		`{"enabled":true,"provider":"anthropic","model":"gpt-5","values":{"ANTHROPIC_API_KEY":"k"}}`,
		`{"enabled":true,"provider":"anthropic","model":"","values":{"ANTHROPIC_API_KEY":"k"}}`,
		`not json`,
	} {
		if w := dispatch(openCodeAdminJSON(http.MethodPost, body)); w.Code != http.StatusBadRequest {
			t.Errorf("POST %s = %d, want 400; %s", body, w.Code, w.Body.String())
		}
	}
	if c, _ := getOpenCodeProvider(); c.Provider != "azure" || c.Values["AZURE_RESOURCE_NAME"] != "acme-us" || c.Values["AZURE_API_KEY"] != key {
		t.Fatalf("a refused save changed the setting: %+v", c)
	}

	// Another provider does not inherit this one's key.
	w = dispatch(openCodeAdminJSON(http.MethodPost, `{"enabled":true,"provider":"anthropic","model":"claude-sonnet-4-5","values":{"ANTHROPIC_API_KEY":""}}`))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("switching provider with no key = %d, want 400; %s", w.Code, w.Body.String())
	}
	w = dispatch(openCodeAdminJSON(http.MethodPost, `{"enabled":true,"provider":"anthropic","model":"claude-sonnet-4-5","values":{"ANTHROPIC_API_KEY":"sk-ant-9876543210"}}`))
	if w.Code != http.StatusOK {
		t.Fatalf("switching provider = %d; %s", w.Code, w.Body.String())
	}
	if c, _ := getOpenCodeProvider(); c.Values["AZURE_API_KEY"] != "" || len(c.Values) != 1 {
		t.Fatalf("the old provider's key came along: %+v", c.Values)
	}

	// Disabling keeps the key for a one-click re-enable.
	w = dispatch(openCodeAdminJSON(http.MethodPost, `{"enabled":false,"provider":"anthropic","model":"claude-sonnet-4-5","values":{}}`))
	if w.Code != http.StatusOK {
		t.Fatalf("POST disable = %d; %s", w.Code, w.Body.String())
	}
	if d = decodeProviderDTO(t, w.Body.String()); d.Enabled || !d.Secrets["ANTHROPIC_API_KEY"].Set || d.Provider != "anthropic" {
		t.Fatalf("after disable: %+v", d)
	}

	// Clearing forgets everything, key included.
	w = dispatch(openCodeAdminJSON(http.MethodPost, `{"clear":true}`))
	if w.Code != http.StatusOK {
		t.Fatalf("POST clear = %d; %s", w.Code, w.Body.String())
	}
	if d = decodeProviderDTO(t, w.Body.String()); d.Enabled || len(d.Secrets) != 0 || d.Provider != "" {
		t.Fatalf("after clear: %+v", d)
	}
	if raw, _ := dbGetSetting(settingOpenCodeProvider); raw != "" {
		t.Fatalf("setting still stored after clear: %s", raw)
	}

	// With models.dev gone and nothing cached, GET still shows the setting and
	// says why the list is empty; a save that needs the catalogue is refused.
	openCodeCatalogCached = nil
	fetchModelsDev = func() ([]byte, error) { return nil, errors.New("offline") }
	_ = os.Remove(openCodeCatalogCachePath())
	w = dispatch(baileyReq(http.MethodGet, openCodeProviderPath, "boss@example.com", adminGrp))
	if d = decodeProviderDTO(t, w.Body.String()); w.Code != http.StatusOK || d.CatalogError == "" || len(d.Providers) != 0 {
		t.Fatalf("GET offline = %d %+v", w.Code, d)
	}
	if w := dispatch(openCodeAdminJSON(http.MethodPost, `{"enabled":true,"provider":"openai","model":"gpt-5","values":{"OPENAI_API_KEY":"k"}}`)); w.Code != http.StatusBadGateway {
		t.Fatalf("POST offline = %d, want 502; %s", w.Code, w.Body.String())
	}
}

func TestOpenCodeProvider_ModelsEndpoint(t *testing.T) {
	isolateOpenCodeProviderTest(t)
	w := dispatch(baileyReq(http.MethodGet, openCodeProviderPath+"/models?provider=anthropic", "boss@example.com", adminGrp))
	if w.Code != http.StatusOK {
		t.Fatalf("GET models = %d; %s", w.Code, w.Body.String())
	}
	var out struct {
		Provider string          `json:"provider"`
		Models   []openCodeModel `json:"models"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || out.Provider != "anthropic" || len(out.Models) != 2 || out.Models[1].ID != "claude-sonnet-4-5" {
		t.Fatalf("models: %v %+v", err, out)
	}
	if w := dispatch(baileyReq(http.MethodGet, openCodeProviderPath+"/models?provider=github-copilot", "boss@example.com", adminGrp)); w.Code != http.StatusNotFound {
		t.Errorf("a sign-in-only provider's models = %d, want 404", w.Code)
	}
}

/*
The files go only where an agent can use them: a workspace with the coding
agent enabled and an agent home to put them in — not one being recovered, not
one in the trash, not one without the agent. Written once per change, handed
to the agent user, and taken away again when the setting is disabled.
*/
func TestOpenCodeProvider_SyncWritesOnlyWhereAnAgentRuns(t *testing.T) {
	isolateOpenCodeProviderTest(t)
	var chowned []string
	chownToAgent = func(p string) error { chowned = append(chowned, p); return nil }

	live := withAgentWorkspace(t, "live", "coding-agent-home")
	noHome := withAgentWorkspace(t, "nohome")
	trashed := withAgentWorkspace(t, "trashed", "coding-agent-home")
	if err := MarkWorkspaceTrashed("trashed"); err != nil {
		t.Fatal(err)
	}
	recovering := withAgentWorkspace(t, "recovering", "coding-agent-home")
	if err := beginRecovery("recovering"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { endRecovery("recovering") })
	plain := mkWorkspaceDir(t, "plain", true)
	if err := os.MkdirAll(filepath.Join(plain, "coding-agent-home"), 0o755); err != nil {
		t.Fatal(err)
	}

	cfg := openCodeProviderConfig{Enabled: true, Provider: "openai", Model: "gpt-5", Vars: vars(t, "openai"), Values: map[string]string{"OPENAI_API_KEY": "sk-0123456789abcdef"}}
	if err := setOpenCodeProvider(cfg, "boss@example.com"); err != nil {
		t.Fatal(err)
	}
	syncOpenCodeProviderFiles()

	path := openCodeProviderEnvPath(live)
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("no file for the live workspace: %v", err)
	}
	if string(got) != renderOpenCodeProviderEnv(cfg) {
		t.Fatalf("file content:\n%s", got)
	}
	if st, _ := os.Stat(path); st.Mode().Perm() != 0o600 {
		t.Errorf("file mode = %o, want 600", st.Mode().Perm())
	}
	for name, dir := range map[string]string{"nohome": noHome, "trashed": trashed, "recovering": recovering, "plain": plain} {
		if _, err := os.Stat(openCodeProviderEnvPath(dir)); err == nil {
			t.Errorf("%s: got a provider file it must not have", name)
		}
	}
	if _, err := os.Stat(filepath.Join(noHome, "coding-agent-home")); err == nil {
		t.Errorf("the sync created an agent home; only Enable may")
	}
	if len(chowned) != 2 || chowned[0] != filepath.Dir(path) || filepath.Dir(chowned[1]) != filepath.Dir(path) || chowned[1] == path {
		t.Errorf("chown calls = %v", chowned)
	}

	before := len(chowned)
	syncOpenCodeProviderFiles()
	if len(chowned) != before {
		t.Errorf("an unchanged sync rewrote the file (chown calls %v)", chowned[before:])
	}

	late := withAgentWorkspace(t, "late", "coding-agent-home")
	if err := syncOpenCodeProviderFileForWorkspace("late"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(openCodeProviderEnvPath(late)); err != nil {
		t.Errorf("no file for the late workspace: %v", err)
	}

	cfg.Enabled = false
	if err := setOpenCodeProvider(cfg, "boss@example.com"); err != nil {
		t.Fatal(err)
	}
	syncOpenCodeProviderFiles()
	syncOpenCodeProviderFiles()
	for name, dir := range map[string]string{"live": live, "late": late} {
		if _, err := os.Stat(openCodeProviderEnvPath(dir)); err == nil {
			t.Errorf("%s: file still there after disable", name)
		}
	}
}

/*
A document-valued variable (Google's service-account JSON) cannot travel on an
env line: the daemon writes it to a credential file next to the env file and
points the variable at that file's path inside the container. It goes with
the provider.
*/
func TestOpenCodeProvider_CredentialDocument(t *testing.T) {
	isolateOpenCodeProviderTest(t)
	ws := withAgentWorkspace(t, "vertex", "coding-agent-home")
	doc := "{\"type\": \"service_account\", \"private_key\": \"-----BEGIN\\nline\\n-----END\"}"
	cfg := openCodeProviderConfig{Enabled: true, Provider: "google-vertex", Model: "gemini-2.5-pro", Vars: vars(t, "google-vertex"),
		Values: map[string]string{"GOOGLE_VERTEX_PROJECT": "acme", "GOOGLE_VERTEX_LOCATION": "europe-west1", "GOOGLE_APPLICATION_CREDENTIALS": doc}}
	if err := setOpenCodeProvider(cfg, "boss@example.com"); err != nil {
		t.Fatal(err)
	}
	syncOpenCodeProviderFiles()

	env, err := os.ReadFile(openCodeProviderEnvPath(ws))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(env), "GOOGLE_APPLICATION_CREDENTIALS='/home/agent/.bitswan/GOOGLE_APPLICATION_CREDENTIALS.credential.json'\n") ||
		!strings.Contains(string(env), "BITSWAN_OPENCODE_PROVIDER_ENV='GOOGLE_APPLICATION_CREDENTIALS'\n") ||
		!strings.Contains(string(env), "GOOGLE_VERTEX_PROJECT='acme'\n") || strings.Contains(string(env), "service_account") {
		t.Fatalf("env file:\n%s", env)
	}
	credPath := filepath.Join(ws, "coding-agent-home", ".bitswan", "GOOGLE_APPLICATION_CREDENTIALS.credential.json")
	got, err := os.ReadFile(credPath)
	if err != nil || string(got) != doc {
		t.Fatalf("credential file: %q, %v", got, err)
	}
	if st, _ := os.Stat(credPath); st.Mode().Perm() != 0o600 {
		t.Errorf("credential file mode = %o", st.Mode().Perm())
	}
	// The DTO says the document is stored, and never shows it.
	w := dispatch(baileyReq(http.MethodGet, openCodeProviderPath, "boss@example.com", adminGrp))
	if d := decodeProviderDTO(t, w.Body.String()); !d.Secrets["GOOGLE_APPLICATION_CREDENTIALS"].Set || d.Secrets["GOOGLE_APPLICATION_CREDENTIALS"].Hint != "" || strings.Contains(w.Body.String(), "service_account") {
		t.Fatalf("DTO: %+v\n%s", d.Secrets, w.Body.String())
	}

	// Another provider: the document is pruned with the switch.
	other := openCodeProviderConfig{Enabled: true, Provider: "openai", Model: "gpt-5", Vars: vars(t, "openai"), Values: map[string]string{"OPENAI_API_KEY": "k"}}
	if err := setOpenCodeProvider(other, "boss@example.com"); err != nil {
		t.Fatal(err)
	}
	syncOpenCodeProviderFiles()
	if _, err := os.Stat(credPath); err == nil {
		t.Errorf("the credential document survived a provider switch")
	}
}

/*
Two ways past the catalogue: an endpoint override on a catalogue provider (a
proxy or gateway that keeps the provider's models and API), and a custom
provider — an endpoint of the admin's own, with a name, an API style, and
either a list of models or a catalogue provider to inherit them from.
*/
func TestOpenCodeProvider_CustomAndEndpointOverride(t *testing.T) {
	isolateOpenCodeProviderTest(t)
	override := openCodeProviderConfig{Enabled: true, Provider: "anthropic", Model: "claude-sonnet-4-5", Vars: vars(t, "anthropic"),
		Values: map[string]string{"ANTHROPIC_API_KEY": "k"}, BaseURL: "https://llm-proxy.example.com/anthropic"}
	if err := validateOpenCodeProvider(override); err != nil {
		t.Fatalf("override rejected: %v", err)
	}
	got := renderOpenCodeProviderEnv(override)
	if !strings.Contains(got, "BITSWAN_OPENCODE_BASE_URL='https://llm-proxy.example.com/anthropic'\n") ||
		!strings.Contains(got, "\nANTHROPIC_API_KEY='k'\n") || strings.Contains(got, "BITSWAN_OPENCODE_CUSTOM") {
		t.Fatalf("override rendered:\n%s", got)
	}

	custom := openCodeProviderConfig{Enabled: true, Provider: "acme", Model: "qwen3-coder", Vars: openCodeCustomVars,
		Values: map[string]string{openCodeCustomKeyEnv: "k'ey"}, BaseURL: "https://llm.acme.example/v1",
		Custom: &openCodeCustomProvider{Name: "Acme's AI", Package: "openai-compatible",
			Models: []openCodeCustomModel{{ID: "qwen3-coder", Name: "Qwen 3 Coder"}, {ID: "glm-5"}}}}
	if err := validateOpenCodeProvider(custom); err != nil {
		t.Fatalf("custom rejected: %v", err)
	}
	got = renderOpenCodeProviderEnv(custom)
	for _, want := range []string{
		"BITSWAN_OPENCODE_PROVIDER='acme'\n",
		"BITSWAN_OPENCODE_PROVIDER_ENV='BITSWAN_OPENCODE_API_KEY'\n",
		"BITSWAN_OPENCODE_BASE_URL='https://llm.acme.example/v1'\n",
		"BITSWAN_OPENCODE_CUSTOM='true'\n",
		"BITSWAN_OPENCODE_CUSTOM_NAME='Acme'\\''s AI'\n",
		"BITSWAN_OPENCODE_CUSTOM_PACKAGE='openai-compatible'\n",
		`BITSWAN_OPENCODE_CUSTOM_MODELS='[{"id":"qwen3-coder","name":"Qwen 3 Coder"},{"id":"glm-5"}]'` + "\n",
		"\nBITSWAN_OPENCODE_API_KEY='k'\\''ey'\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("custom rendering lacks %q:\n%s", want, got)
		}
	}
	if sh, err := exec.LookPath("sh"); err == nil {
		path := filepath.Join(t.TempDir(), openCodeProviderEnvFile)
		if err := os.WriteFile(path, []byte(got), 0o600); err != nil {
			t.Fatal(err)
		}
		out, err := exec.Command(sh, "-c", `. "$1" && printf '%s' "$BITSWAN_OPENCODE_CUSTOM_MODELS"`, "sh", path).Output()
		if err != nil {
			t.Fatalf("sourcing: %v", err)
		}
		var back []openCodeCustomModel
		if err := json.Unmarshal(out, &back); err != nil || len(back) != 2 || back[0].Name != "Qwen 3 Coder" || back[1].ID != "glm-5" {
			t.Fatalf("the shell read the models back as %q (%v)", out, err)
		}
	}

	inherit := openCodeProviderConfig{Enabled: true, Provider: "acme-anthropic", Model: "claude-sonnet-4-5", Vars: openCodeCustomVars,
		Values: map[string]string{openCodeCustomKeyEnv: "k"}, BaseURL: "https://gw.example/anthropic",
		Custom: &openCodeCustomProvider{Package: "anthropic-compatible", Canonical: "anthropic"}}
	if err := validateOpenCodeProvider(inherit); err != nil {
		t.Fatalf("inheriting rejected: %v", err)
	}
	if got := renderOpenCodeProviderEnv(inherit); !strings.Contains(got, "BITSWAN_OPENCODE_CUSTOM_CANONICAL='anthropic'\n") || strings.Contains(got, "CUSTOM_MODELS") {
		t.Fatalf("inheriting rendered:\n%s", got)
	}

	models := []openCodeCustomModel{{ID: "m"}}
	key := map[string]string{openCodeCustomKeyEnv: "k"}
	bad := []openCodeProviderConfig{
		{Enabled: true, Provider: "Acme AI", Model: "m", Vars: openCodeCustomVars, Values: key, BaseURL: "https://x.example/v1", Custom: &openCodeCustomProvider{Package: "openai-compatible", Models: models}},
		{Enabled: true, Provider: "acme", Model: "m", Vars: openCodeCustomVars, Values: key, Custom: &openCodeCustomProvider{Package: "openai-compatible", Models: models}},
		{Enabled: true, Provider: "acme", Model: "m", Vars: openCodeCustomVars, Values: key, BaseURL: "llm.example/v1", Custom: &openCodeCustomProvider{Package: "openai-compatible", Models: models}},
		{Enabled: true, Provider: "acme", Model: "m", Vars: openCodeCustomVars, Values: key, BaseURL: "ftp://llm.example/v1", Custom: &openCodeCustomProvider{Package: "openai-compatible", Models: models}},
		{Enabled: true, Provider: "acme", Model: "m", Vars: openCodeCustomVars, Values: key, BaseURL: "https://x.example/v1", Custom: &openCodeCustomProvider{Package: "grpc", Models: models}},
		{Enabled: true, Provider: "acme", Model: "m", Vars: openCodeCustomVars, Values: key, BaseURL: "https://x.example/v1", Custom: &openCodeCustomProvider{Package: "openai-compatible"}},
		{Enabled: true, Provider: "acme", Model: "other", Vars: openCodeCustomVars, Values: key, BaseURL: "https://x.example/v1", Custom: &openCodeCustomProvider{Package: "openai-compatible", Models: models}},
		{Enabled: true, Provider: "openai", Model: "gpt-5", Vars: vars(t, "openai"), Values: map[string]string{"OPENAI_API_KEY": "k"}, BaseURL: "https://x example/v1"},
		{Enabled: true, Provider: "openai", Model: "gpt-5", Vars: vars(t, "openai"), Values: map[string]string{"OPENAI_API_KEY": "k"}, BaseURL: "https://x.example/v1'"},
	}
	for i, c := range bad {
		if err := validateOpenCodeProvider(c); err == nil {
			t.Errorf("bad case %d accepted: %+v", i, c)
		}
	}
}

func TestOpenCodeProvider_SaveCustomRoundTrip(t *testing.T) {
	isolateOpenCodeProviderTest(t)
	const key = "sk-custom-0123456789"
	body := `{"enabled":true,"provider":" acme ","model":"qwen3-coder","values":{"BITSWAN_OPENCODE_API_KEY":"` + key + `"},"base_url":" https://llm.acme.example/v1 ","restrict":true,` +
		`"custom":{"name":"","package":"openai-compatible","canonical":"","models":[{"id":" qwen3-coder ","name":"Qwen 3 Coder"},{"id":"","name":""}]}}`
	w := dispatch(openCodeAdminJSON(http.MethodPost, body))
	if w.Code != http.StatusOK {
		t.Fatalf("POST custom = %d; %s", w.Code, w.Body.String())
	}
	d := decodeProviderDTO(t, w.Body.String())
	if d.Provider != "acme" || d.BaseURL != "https://llm.acme.example/v1" || d.Custom == nil || !d.Secrets[openCodeCustomKeyEnv].Set || !d.Restrict || len(d.Vars) != 1 {
		t.Fatalf("after custom save: %+v", d)
	}
	if d.Custom.Name != "acme" || d.Custom.Package != "openai-compatible" || len(d.Custom.Models) != 1 || d.Custom.Models[0].ID != "qwen3-coder" {
		t.Fatalf("custom description not tidied: %+v", d.Custom)
	}
	if len(d.Packages) != len(openCodePackages) || strings.Contains(w.Body.String(), key[:10]) {
		t.Fatalf("packages or key wrong in: %s", w.Body.String())
	}
	// A custom id that is a catalogue id is refused: choose it from the list instead.
	if w := dispatch(openCodeAdminJSON(http.MethodPost, `{"enabled":true,"provider":"anthropic","model":"m","values":{"BITSWAN_OPENCODE_API_KEY":"k"},"base_url":"https://x.example/v1","custom":{"package":"openai-compatible","models":[{"id":"m"}]}}`)); w.Code != http.StatusBadRequest {
		t.Errorf("catalogue id as custom id = %d, want 400; %s", w.Code, w.Body.String())
	}
	if w := dispatch(openCodeAdminJSON(http.MethodPost, `{"enabled":true,"provider":"acme","model":"m","values":{},"base_url":"","custom":{"package":"openai-compatible","models":[{"id":"m"}]}}`)); w.Code != http.StatusBadRequest {
		t.Errorf("custom without endpoint = %d, want 400; %s", w.Code, w.Body.String())
	}
	// Back to a catalogue provider with its own key: the custom description goes.
	w = dispatch(openCodeAdminJSON(http.MethodPost, `{"enabled":true,"provider":"openai","model":"gpt-5","values":{"OPENAI_API_KEY":"sk-o"},"base_url":"","custom":null}`))
	if w.Code != http.StatusOK {
		t.Fatalf("POST catalogue = %d; %s", w.Code, w.Body.String())
	}
	if d = decodeProviderDTO(t, w.Body.String()); d.Custom != nil || d.BaseURL != "" || d.Provider != "openai" || !d.Secrets["OPENAI_API_KEY"].Set || len(d.Secrets) != 1 {
		t.Fatalf("after switching back: %+v", d)
	}
}

/*
With the toggle on, every workspace's dashboard gets a defaults file naming
OpenCode as the coding agent for people who have not chosen one — but only
while the provider is enabled and complete, so nobody lands on an agent
without a model. Without a claude-configs directory there is nowhere to put
it yet; the next tick catches up.
*/
func TestOpenCodeProvider_DefaultAgentFile(t *testing.T) {
	isolateOpenCodeProviderTest(t)
	full := openCodeProviderConfig{Enabled: true, Provider: "openai", Model: "gpt-5", Vars: vars(t, "openai"), Values: map[string]string{"OPENAI_API_KEY": "sk-0123456789abcdef"}, DefaultAgent: true}
	if got := renderDashboardDefaults(full); got != "{\"codingAgent\": \"opencode\"}\n" {
		t.Fatalf("rendered %q", got)
	}
	for _, c := range []openCodeProviderConfig{
		{Enabled: true, Provider: "openai", Model: "gpt-5", Vars: vars(t, "openai"), Values: map[string]string{"OPENAI_API_KEY": "k"}, DefaultAgent: false},
		{Enabled: false, Provider: "openai", Model: "gpt-5", Vars: vars(t, "openai"), Values: map[string]string{"OPENAI_API_KEY": "k"}, DefaultAgent: true},
		{Enabled: true, Provider: "openai", Model: "", Vars: vars(t, "openai"), Values: map[string]string{"OPENAI_API_KEY": "k"}, DefaultAgent: true},
	} {
		if renderDashboardDefaults(c) != "" {
			t.Errorf("a defaults file for %+v", c)
		}
	}

	withDashboard := withAgentWorkspace(t, "withdash", "coding-agent-home", "claude-configs")
	noDashboard := withAgentWorkspace(t, "nodash", "coding-agent-home")
	if err := setOpenCodeProvider(full, "boss@example.com"); err != nil {
		t.Fatal(err)
	}
	syncOpenCodeProviderFiles()
	got, err := os.ReadFile(dashboardDefaultsPath(withDashboard))
	if err != nil || string(got) != "{\"codingAgent\": \"opencode\"}\n" {
		t.Fatalf("defaults file: %q, %v", got, err)
	}
	if st, _ := os.Stat(dashboardDefaultsPath(withDashboard)); st.Mode().Perm() != 0o644 {
		t.Errorf("defaults file mode = %o, want 644 (it holds no secret)", st.Mode().Perm())
	}
	if _, err := os.Stat(dashboardDefaultsPath(noDashboard)); err == nil {
		t.Errorf("a defaults file where the dashboard has no config root yet")
	}
	if _, err := os.Stat(openCodeProviderEnvPath(noDashboard)); err != nil {
		t.Errorf("the provider file is still written without a dashboard root: %v", err)
	}

	full.DefaultAgent = false
	if err := setOpenCodeProvider(full, "boss@example.com"); err != nil {
		t.Fatal(err)
	}
	syncOpenCodeProviderFiles()
	if _, err := os.Stat(dashboardDefaultsPath(withDashboard)); err == nil {
		t.Errorf("defaults file still there with the toggle off")
	}
	if _, err := os.Stat(openCodeProviderEnvPath(withDashboard)); err != nil {
		t.Errorf("provider file gone with the toggle off: %v", err)
	}

	w := dispatch(openCodeAdminJSON(http.MethodPost, `{"enabled":true,"provider":"openai","model":"gpt-5","values":{"OPENAI_API_KEY":""},"default_agent":true}`))
	if w.Code != http.StatusOK {
		t.Fatalf("POST = %d; %s", w.Code, w.Body.String())
	}
	if d := decodeProviderDTO(t, w.Body.String()); !d.DefaultAgent {
		t.Fatalf("default_agent not echoed: %+v", d)
	}
	if _, err := os.Stat(dashboardDefaultsPath(withDashboard)); err != nil {
		t.Errorf("defaults file not written on save: %v", err)
	}
}
