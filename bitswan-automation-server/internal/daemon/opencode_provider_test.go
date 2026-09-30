package daemon

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const openCodeProviderPath = "/bailey/api/admin/opencode-provider"

// isolateOpenCodeProviderTest gives the test a HOME and a bailey.db of its own
// (the sync walks every workspace under HOME) and stands in for the chown the
// daemon does as root.
func isolateOpenCodeProviderTest(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	reopenBaileyDBForTest(t)
	t.Cleanup(func() { reopenBaileyDBForTest(t) })
	prev := chownToAgent
	chownToAgent = func(string) error { return nil }
	t.Cleanup(func() { chownToAgent = prev })
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

/*
The file is sourced by bash. A key that contains a quote, a dollar, a
backslash or a backtick must come out of the shell exactly as it went in —
which is what single quotes guarantee and double quotes do not.
*/
func TestOpenCodeProviderEnv_RenderQuotesForTheShell(t *testing.T) {
	key := "sk-it's$weird\\and`quoted`"
	cfg := openCodeProviderConfig{Enabled: true, Provider: "anthropic", Model: "claude-sonnet-4-5", APIKey: key, Restrict: true}
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

	// Disabled or incomplete: no file at all.
	for i, c := range []openCodeProviderConfig{
		{Enabled: false, Provider: "anthropic", Model: "m", APIKey: "k"},
		{Enabled: true, Provider: "nope", Model: "m", APIKey: "k"},
		{Enabled: true, Provider: "anthropic", Model: "", APIKey: "k"},
		{Enabled: true, Provider: "anthropic", Model: "m", APIKey: ""},
	} {
		if r := renderOpenCodeProviderEnv(c); r != "" {
			t.Errorf("case %d: rendered a file for %+v:\n%s", i, c, r)
		}
	}

	// Every provider in the table renders its own env var.
	for _, p := range openCodeProviders {
		r := renderOpenCodeProviderEnv(openCodeProviderConfig{Enabled: true, Provider: p.ID, Model: "m", APIKey: "k"})
		if !strings.Contains(r, "\n"+p.Env+"='k'\n") || !strings.Contains(r, "BITSWAN_OPENCODE_PROVIDER_ENV='"+p.Env+"'\n") {
			t.Errorf("%s: env var %s missing from:\n%s", p.ID, p.Env, r)
		}
	}
}

func TestOpenCodeProvider_Validation(t *testing.T) {
	ok := []openCodeProviderConfig{
		{},
		{Enabled: false, Provider: "openai"},
		{Enabled: true, Provider: "openai", Model: "gpt-5", APIKey: "sk-123"},
		// OpenRouter model ids carry a slash of their own; OpenCode splits on the first.
		{Enabled: true, Provider: "openrouter", Model: "anthropic/claude-sonnet-4.5", APIKey: "k"},
	}
	for i, c := range ok {
		if err := validateOpenCodeProvider(c); err != nil {
			t.Errorf("ok case %d rejected: %v", i, err)
		}
	}
	bad := []openCodeProviderConfig{
		{Enabled: true, Provider: "nope", Model: "m", APIKey: "k"},
		{Enabled: false, Provider: "nope"},
		{Enabled: true, Provider: "openai", Model: "", APIKey: "k"},
		{Enabled: true, Provider: "openai", Model: "gpt#5", APIKey: "k"},
		{Enabled: true, Provider: "openai", Model: "gpt 5", APIKey: "k"},
		{Enabled: true, Provider: "openai", Model: "gpt-5", APIKey: ""},
		{Enabled: true, Provider: "openai", Model: "gpt-5", APIKey: "k\nEVIL=1"},
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
}

func TestOpenCodeProvider_SaveKeepDisableClear(t *testing.T) {
	isolateOpenCodeProviderTest(t)

	w := dispatch(baileyReq(http.MethodGet, openCodeProviderPath, "boss@example.com", adminGrp))
	if w.Code != http.StatusOK {
		t.Fatalf("GET = %d; %s", w.Code, w.Body.String())
	}
	if d := decodeProviderDTO(t, w.Body.String()); d.Enabled || d.KeySet || len(d.Providers) != len(openCodeProviders) {
		t.Fatalf("fresh GET = %+v", d)
	}

	// Save. The response is the GET shape, and the key is not in it.
	const key = "sk-ant-0123456789abcdef"
	w = dispatch(openCodeAdminJSON(http.MethodPost, `{"enabled":true,"provider":"anthropic","model":"claude-sonnet-4-5","api_key":"`+key+`","restrict":true}`))
	if w.Code != http.StatusOK {
		t.Fatalf("POST = %d; %s", w.Code, w.Body.String())
	}
	d := decodeProviderDTO(t, w.Body.String())
	if !d.Enabled || d.Provider != "anthropic" || d.Model != "claude-sonnet-4-5" || !d.Restrict || !d.KeySet || d.KeyHint != "cdef" || d.UpdatedBy != "boss@example.com" || d.UpdatedAt == "" {
		t.Fatalf("after save: %+v", d)
	}
	if strings.Contains(w.Body.String(), key[:10]) {
		t.Fatalf("the key is in the response: %s", w.Body.String())
	}

	// A blank key keeps the stored one while the rest changes.
	w = dispatch(openCodeAdminJSON(http.MethodPost, `{"enabled":true,"provider":"anthropic","model":"claude-opus-4-1","api_key":"  ","restrict":false}`))
	if w.Code != http.StatusOK {
		t.Fatalf("POST blank key = %d; %s", w.Code, w.Body.String())
	}
	if d = decodeProviderDTO(t, w.Body.String()); d.Model != "claude-opus-4-1" || d.Restrict || !d.KeySet || d.KeyHint != "cdef" {
		t.Fatalf("after blank-key save: %+v", d)
	}
	if c, _ := getOpenCodeProvider(); c.APIKey != key {
		t.Fatalf("stored key changed to %q", c.APIKey)
	}

	// Bad input is refused and changes nothing.
	for _, body := range []string{
		`{"enabled":true,"provider":"nope","model":"x","api_key":"k"}`,
		`{"enabled":true,"provider":"anthropic","model":"","api_key":"k"}`,
		`not json`,
	} {
		if w := dispatch(openCodeAdminJSON(http.MethodPost, body)); w.Code != http.StatusBadRequest {
			t.Errorf("POST %s = %d, want 400; %s", body, w.Code, w.Body.String())
		}
	}
	if c, _ := getOpenCodeProvider(); c.Provider != "anthropic" || c.Model != "claude-opus-4-1" || c.APIKey != key {
		t.Fatalf("a refused save changed the setting: %+v", c)
	}

	// Disabling keeps the key for a one-click re-enable.
	w = dispatch(openCodeAdminJSON(http.MethodPost, `{"enabled":false,"provider":"anthropic","model":"claude-opus-4-1"}`))
	if w.Code != http.StatusOK {
		t.Fatalf("POST disable = %d; %s", w.Code, w.Body.String())
	}
	if d = decodeProviderDTO(t, w.Body.String()); d.Enabled || !d.KeySet || d.Provider != "anthropic" {
		t.Fatalf("after disable: %+v", d)
	}

	// Clearing forgets everything, key included.
	w = dispatch(openCodeAdminJSON(http.MethodPost, `{"clear":true}`))
	if w.Code != http.StatusOK {
		t.Fatalf("POST clear = %d; %s", w.Code, w.Body.String())
	}
	if d = decodeProviderDTO(t, w.Body.String()); d.Enabled || d.KeySet || d.Provider != "" || d.KeyHint != "" {
		t.Fatalf("after clear: %+v", d)
	}
	if raw, _ := dbGetSetting(settingOpenCodeProvider); raw != "" {
		t.Fatalf("setting still stored after clear: %s", raw)
	}
}

/*
The file goes only where an agent can use it: a workspace with the coding
agent enabled and an agent home to put it in — not one being recovered, not
one in the trash, not one without the agent. It is written once per change,
handed to the agent user, and taken away again when the setting is disabled.
*/
func TestOpenCodeProvider_SyncWritesOnlyWhereAnAgentRuns(t *testing.T) {
	isolateOpenCodeProviderTest(t)
	var chowned []string
	chownToAgent = func(p string) error { chowned = append(chowned, p); return nil }

	withAgent := func(ws string, withHome bool) string {
		dir := mkWorkspaceDir(t, ws, true)
		if err := os.WriteFile(filepath.Join(dir, "deployment", "docker-compose-coding-agent.yml"), []byte("services: {}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if withHome {
			if err := os.MkdirAll(filepath.Join(dir, "coding-agent-home"), 0o755); err != nil {
				t.Fatal(err)
			}
		}
		return dir
	}
	live := withAgent("live", true)
	noHome := withAgent("nohome", false)
	trashed := withAgent("trashed", true)
	if err := MarkWorkspaceTrashed("trashed"); err != nil {
		t.Fatal(err)
	}
	recovering := withAgent("recovering", true)
	if err := beginRecovery("recovering"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { endRecovery("recovering") })
	plain := mkWorkspaceDir(t, "plain", true)
	if err := os.MkdirAll(filepath.Join(plain, "coding-agent-home"), 0o755); err != nil {
		t.Fatal(err)
	}

	cfg := openCodeProviderConfig{Enabled: true, Provider: "openai", Model: "gpt-5", APIKey: "sk-0123456789abcdef"}
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
	// The directory and the file were handed to the agent user (the file
	// under its temporary name, before the rename).
	if len(chowned) != 2 || chowned[0] != filepath.Dir(path) || filepath.Dir(chowned[1]) != filepath.Dir(path) || chowned[1] == path {
		t.Errorf("chown calls = %v", chowned)
	}

	// Nothing changed: nothing is rewritten.
	before := len(chowned)
	syncOpenCodeProviderFiles()
	if len(chowned) != before {
		t.Errorf("an unchanged sync rewrote the file (chown calls %v)", chowned[before:])
	}

	// A workspace that gets the agent later is served on its own.
	late := withAgent("late", true)
	if err := syncOpenCodeProviderFileForWorkspace("late"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(openCodeProviderEnvPath(late)); err != nil {
		t.Errorf("no file for the late workspace: %v", err)
	}

	// Disabling takes the files away; doing it again is fine.
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
The table is generated from models.dev and checked in; this keeps a
regeneration honest: every entry usable, no duplicates, the familiar few
present and marked, and nothing that needs more than one key.
*/
func TestOpenCodeCatalog_IsSane(t *testing.T) {
	seen := map[string]bool{}
	popular := 0
	for _, p := range openCodeProviders {
		if p.ID == "" || p.Name == "" || p.Env == "" {
			t.Errorf("incomplete entry %+v", p)
		}
		if seen[p.ID] {
			t.Errorf("duplicate id %q", p.ID)
		}
		seen[p.ID] = true
		if p.Popular {
			popular++
		}
	}
	for _, id := range []string{"anthropic", "openai", "google", "openrouter", "mistral", "groq", "xai", "deepseek", "opencode"} {
		p, ok := openCodeProviderByID(id)
		if !ok || !p.Popular || p.ModelHint == "" {
			t.Errorf("%s: missing, not popular or without a model hint (%+v)", id, p)
		}
	}
	if popular != 9 {
		t.Errorf("popular providers = %d, want 9", popular)
	}
	if p, _ := openCodeProviderByID("google"); p.Env != "GOOGLE_API_KEY" {
		t.Errorf("google reads its key from %q; its several env names are alternatives and the first is expected", p.Env)
	}
	for _, id := range []string{"amazon-bedrock", "azure", "google-vertex"} {
		if _, ok := openCodeProviderByID(id); ok {
			t.Errorf("%s needs more than one key and must not be offered", id)
		}
	}
	if len(openCodeProviders) < 100 || len(openCodeProviders) > openCodeCatalogueSize {
		t.Errorf("table has %d entries of a %d-provider catalogue", len(openCodeProviders), openCodeCatalogueSize)
	}
}

/*
Two ways past the catalogue: an endpoint override on a catalogue provider (a
proxy or gateway that keeps the provider's models and API), and a custom
provider — an endpoint of the admin's own, with a name, an API style, and
either a list of models or a catalogue provider to inherit them from.
*/
func TestOpenCodeProvider_CustomAndEndpointOverride(t *testing.T) {
	override := openCodeProviderConfig{Enabled: true, Provider: "anthropic", Model: "claude-sonnet-4-5", APIKey: "k",
		BaseURL: "https://llm-proxy.example.com/anthropic"}
	if err := validateOpenCodeProvider(override); err != nil {
		t.Fatalf("override rejected: %v", err)
	}
	got := renderOpenCodeProviderEnv(override)
	if !strings.Contains(got, "BITSWAN_OPENCODE_BASE_URL='https://llm-proxy.example.com/anthropic'\n") ||
		!strings.Contains(got, "\nANTHROPIC_API_KEY='k'\n") || strings.Contains(got, "BITSWAN_OPENCODE_CUSTOM") {
		t.Fatalf("override rendered:\n%s", got)
	}

	custom := openCodeProviderConfig{Enabled: true, Provider: "acme", Model: "qwen3-coder", APIKey: "k'ey",
		BaseURL: "https://llm.acme.example/v1",
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
	if strings.Contains(got, "CANONICAL") {
		t.Errorf("a canonical line with nothing to inherit:\n%s", got)
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

	// Inheriting a catalogue provider's models needs no list and frees the default model.
	inherit := openCodeProviderConfig{Enabled: true, Provider: "acme-anthropic", Model: "claude-sonnet-4-5", APIKey: "k",
		BaseURL: "https://gw.example/anthropic", Custom: &openCodeCustomProvider{Package: "anthropic-compatible", Canonical: "anthropic"}}
	if err := validateOpenCodeProvider(inherit); err != nil {
		t.Fatalf("inheriting rejected: %v", err)
	}
	if got := renderOpenCodeProviderEnv(inherit); !strings.Contains(got, "BITSWAN_OPENCODE_CUSTOM_CANONICAL='anthropic'\n") || strings.Contains(got, "CUSTOM_MODELS") {
		t.Fatalf("inheriting rendered:\n%s", got)
	}

	models := []openCodeCustomModel{{ID: "m"}}
	bad := []openCodeProviderConfig{
		// a catalogue id as a custom id
		{Enabled: true, Provider: "anthropic", Model: "m", APIKey: "k", BaseURL: "https://x.example/v1", Custom: &openCodeCustomProvider{Package: "openai-compatible", Models: models}},
		// an id that cannot prefix a model reference
		{Enabled: true, Provider: "Acme AI", Model: "m", APIKey: "k", BaseURL: "https://x.example/v1", Custom: &openCodeCustomProvider{Package: "openai-compatible", Models: models}},
		// no endpoint, and endpoints that are not http(s) URLs
		{Enabled: true, Provider: "acme", Model: "m", APIKey: "k", Custom: &openCodeCustomProvider{Package: "openai-compatible", Models: models}},
		{Enabled: true, Provider: "acme", Model: "m", APIKey: "k", BaseURL: "llm.example/v1", Custom: &openCodeCustomProvider{Package: "openai-compatible", Models: models}},
		{Enabled: true, Provider: "acme", Model: "m", APIKey: "k", BaseURL: "ftp://llm.example/v1", Custom: &openCodeCustomProvider{Package: "openai-compatible", Models: models}},
		// an API style OpenCode has no package for
		{Enabled: true, Provider: "acme", Model: "m", APIKey: "k", BaseURL: "https://x.example/v1", Custom: &openCodeCustomProvider{Package: "grpc", Models: models}},
		// nothing to offer: no models, nothing inherited
		{Enabled: true, Provider: "acme", Model: "m", APIKey: "k", BaseURL: "https://x.example/v1", Custom: &openCodeCustomProvider{Package: "openai-compatible"}},
		// a default model that is not one of the listed ones
		{Enabled: true, Provider: "acme", Model: "other", APIKey: "k", BaseURL: "https://x.example/v1", Custom: &openCodeCustomProvider{Package: "openai-compatible", Models: models}},
		// inheriting from something that is not in the catalogue
		{Enabled: true, Provider: "acme", Model: "m", APIKey: "k", BaseURL: "https://x.example/v1", Custom: &openCodeCustomProvider{Package: "openai-compatible", Canonical: "nope"}},
		// a catalogue provider with an override that is not a URL
		{Enabled: true, Provider: "openai", Model: "gpt-5", APIKey: "k", BaseURL: "https://x example/v1"},
		{Enabled: true, Provider: "openai", Model: "gpt-5", APIKey: "k", BaseURL: "https://x.example/v1'"},
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
	body := `{"enabled":true,"provider":" acme ","model":"qwen3-coder","api_key":"` + key + `","base_url":" https://llm.acme.example/v1 ","restrict":true,` +
		`"custom":{"name":"","package":"openai-compatible","canonical":"","models":[{"id":" qwen3-coder ","name":"Qwen 3 Coder"},{"id":"","name":""}]}}`
	w := dispatch(openCodeAdminJSON(http.MethodPost, body))
	if w.Code != http.StatusOK {
		t.Fatalf("POST custom = %d; %s", w.Code, w.Body.String())
	}
	d := decodeProviderDTO(t, w.Body.String())
	if d.Provider != "acme" || d.BaseURL != "https://llm.acme.example/v1" || d.Custom == nil || !d.KeySet || !d.Restrict {
		t.Fatalf("after custom save: %+v", d)
	}
	if d.Custom.Name != "acme" || d.Custom.Package != "openai-compatible" || len(d.Custom.Models) != 1 || d.Custom.Models[0].ID != "qwen3-coder" {
		t.Fatalf("custom description not tidied: %+v", d.Custom)
	}
	if len(d.Packages) != len(openCodePackages) || strings.Contains(w.Body.String(), key[:10]) {
		t.Fatalf("packages or key wrong in: %s", w.Body.String())
	}

	// A custom provider without an endpoint is refused.
	if w := dispatch(openCodeAdminJSON(http.MethodPost, `{"enabled":true,"provider":"acme","model":"m","base_url":"","custom":{"package":"openai-compatible","models":[{"id":"m"}]}}`)); w.Code != http.StatusBadRequest {
		t.Errorf("custom without endpoint = %d, want 400; %s", w.Code, w.Body.String())
	}

	// Back to a catalogue provider: the custom description goes, the key stays.
	w = dispatch(openCodeAdminJSON(http.MethodPost, `{"enabled":true,"provider":"openai","model":"gpt-5","api_key":"","base_url":"","custom":null}`))
	if w.Code != http.StatusOK {
		t.Fatalf("POST catalogue = %d; %s", w.Code, w.Body.String())
	}
	if d = decodeProviderDTO(t, w.Body.String()); d.Custom != nil || d.BaseURL != "" || d.Provider != "openai" || !d.KeySet {
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
	full := openCodeProviderConfig{Enabled: true, Provider: "openai", Model: "gpt-5", APIKey: "sk-0123456789abcdef", DefaultAgent: true}
	if got := renderDashboardDefaults(full); got != "{\"codingAgent\": \"opencode\"}\n" {
		t.Fatalf("rendered %q", got)
	}
	for _, c := range []openCodeProviderConfig{
		{Enabled: true, Provider: "openai", Model: "gpt-5", APIKey: "k", DefaultAgent: false},
		{Enabled: false, Provider: "openai", Model: "gpt-5", APIKey: "k", DefaultAgent: true},
		{Enabled: true, Provider: "openai", Model: "", APIKey: "k", DefaultAgent: true},
	} {
		if renderDashboardDefaults(c) != "" {
			t.Errorf("a defaults file for %+v", c)
		}
	}

	withDashboard := mkWorkspaceDir(t, "withdash", true)
	for _, d := range []string{"coding-agent-home", "claude-configs"} {
		if err := os.MkdirAll(filepath.Join(withDashboard, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	noDashboard := mkWorkspaceDir(t, "nodash", true)
	if err := os.MkdirAll(filepath.Join(noDashboard, "coding-agent-home"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{withDashboard, noDashboard} {
		if err := os.WriteFile(filepath.Join(dir, "deployment", "docker-compose-coding-agent.yml"), []byte("services: {}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
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

	// The toggle off: the defaults file goes, the provider file stays.
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

	// And it rides the API: saved, echoed, never the key.
	w := dispatch(openCodeAdminJSON(http.MethodPost, `{"enabled":true,"provider":"openai","model":"gpt-5","api_key":"","default_agent":true}`))
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
