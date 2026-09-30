package daemon

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/services"
)

// A server-wide default model provider for OpenCode.
//
// OpenCode, the second coding agent in every workspace's Coding Agent tab,
// takes provider credentials from the environment of its `opencode serve`
// process (ANTHROPIC_API_KEY makes the anthropic provider appear, Azure reads
// a resource name next to its key, and so on) and its default model from the
// `model` key of its config. Without either, each person connects a provider
// in OpenCode's own UI, and until they do OpenCode answers through its
// built-in hosted provider.
//
// This setting hands every workspace one provider instead:
//
//	console  POST /bailey/api/admin/opencode-provider
//	  → server_settings[opencode_default_provider]           (bailey.db; the secrets never leave the server)
//	  → <ws>/coding-agent-home/.bitswan/opencode-provider.env (every workspace with the agent enabled;
//	                                                            /home/agent/.bitswan/… inside the container)
//	  → bitswan-opencode-server `start` sources it and starts `opencode serve` with the
//	    provider's env vars set and a generated config carrying `model` — and, when
//	    restricted, a policy that hides every other provider.
//
// The provider list is OpenCode's own catalogue, read live from models.dev
// (opencode_catalog.go), and each provider's fields are the environment
// variables the catalogue says it reads — the same values `/connect` asks
// for, minus the sign-in flows a server cannot complete. A custom provider
// (an endpoint of the admin's own) and an endpoint override for a catalogue
// provider cover what the catalogue does not.
//
// A file in the agent's home rather than compose environment: nothing to
// regenerate and no container to restart when a key changes, the key never
// lands in the world-readable compose file, and every server started after a
// change picks it up (a running one on its next start). The file is written on
// save, when the agent is enabled for a workspace, and on every reconcile tick;
// it is removed the same way when the setting is disabled or cleared.
//
// Exposure, and the console says so: everything in the agent container runs
// as the agent user, so every coding-agent run in every workspace can read the
// credentials. That is what "every workspace uses this provider" means.

// openCodePackage is one of OpenCode's runtime provider packages a custom
// endpoint can be spoken to through, by the name after @opencode/ai/providers/.
// The list is what 2.0.16 ships; re-check it on a bump.
type openCodePackage struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

var openCodePackages = []openCodePackage{
	{ID: "openai-compatible", Name: "OpenAI-compatible (chat completions)"},
	{ID: "anthropic-compatible", Name: "Anthropic-compatible (messages)"},
	{ID: "openai", Name: "OpenAI"},
	{ID: "anthropic", Name: "Anthropic"},
	{ID: "google", Name: "Google Gemini"},
}

func openCodePackageByID(id string) (openCodePackage, bool) {
	for _, p := range openCodePackages {
		if p.ID == id {
			return p, true
		}
	}
	return openCodePackage{}, false
}

// openCodeCustomModel is one model a custom provider serves. A custom provider
// has no catalogue, so the admin names its models (unless it inherits them).
type openCodeCustomModel struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}

// openCodeCustomProvider describes a provider that is not in OpenCode's
// catalogue: an endpoint of the admin's own — a company gateway, a self-hosted
// model server — reached through one of OpenCode's runtime packages. Its id is
// the setting's Provider, its endpoint the setting's BaseURL, and its key
// travels under openCodeCustomKeyEnv.
type openCodeCustomProvider struct {
	Name      string                `json:"name"`
	Package   string                `json:"package"`
	Canonical string                `json:"canonical,omitempty"`
	Models    []openCodeCustomModel `json:"models,omitempty"`
}

// openCodeCustomKeyEnv is the env var a custom provider reads its key from;
// the launcher names it in the generated provider entry.
const openCodeCustomKeyEnv = "BITSWAN_OPENCODE_API_KEY"

var openCodeCustomVars = []openCodeEnvVar{{Name: openCodeCustomKeyEnv, Label: "API key", Secret: true, Optional: true}}

// openCodeProviderConfig is the stored setting: one JSON blob under
// settingOpenCodeProvider, the way the SSO setting is kept. The credentials
// stay inside it; nothing but the env file ever reads them back out.
//
// Provider is a catalogue id, or the custom provider's own id when Custom is
// set. Vars are the provider's environment variables as they were when the
// setting was saved (from the catalogue, or the one custom key), so the file
// can be rendered without the catalogue; Values holds what the admin entered
// for them, secrets included. BaseURL is optional for a catalogue provider
// (its endpoint override) and required for a custom one.
type openCodeProviderConfig struct {
	Enabled  bool                    `json:"enabled"`
	Provider string                  `json:"provider"`
	Model    string                  `json:"model"`
	Vars     []openCodeEnvVar        `json:"vars,omitempty"`
	Values   map[string]string       `json:"values,omitempty"`
	Restrict bool                    `json:"restrict"`
	BaseURL  string                  `json:"base_url,omitempty"`
	Custom   *openCodeCustomProvider `json:"custom,omitempty"`
	// SelfHosted marks one of OpenCode's built-in providers for a server of
	// your own (Ollama, LM Studio, vLLM): BaseURL is the server, the key is
	// optional, and OpenCode discovers the models itself.
	SelfHosted bool `json:"self_hosted,omitempty"`
	// DefaultAgent makes OpenCode the coding agent every workspace opens for
	// people who have not chosen one themselves, instead of asking them.
	DefaultAgent bool   `json:"default_agent"`
	UpdatedAt    string `json:"updated_at"`
	UpdatedBy    string `json:"updated_by"`
}

func (c openCodeProviderConfig) varByName(name string) (openCodeEnvVar, bool) {
	for _, v := range c.Vars {
		if v.Name == name {
			return v, true
		}
	}
	return openCodeEnvVar{}, false
}

// keyEnv is the env var the launcher checks before trusting the file: the
// first secret that has a value.
func (c openCodeProviderConfig) keyEnv() string {
	for _, v := range c.Vars {
		if v.Secret && c.Values[v.Name] != "" {
			return v.Name
		}
	}
	return ""
}

func getOpenCodeProvider() (openCodeProviderConfig, error) {
	raw, err := dbGetSetting(settingOpenCodeProvider)
	if err != nil {
		return openCodeProviderConfig{}, err
	}
	if strings.TrimSpace(raw) == "" {
		return openCodeProviderConfig{}, nil
	}
	var c openCodeProviderConfig
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return openCodeProviderConfig{}, fmt.Errorf("stored OpenCode provider setting is corrupt: %w", err)
	}
	return c, nil
}

func setOpenCodeProvider(c openCodeProviderConfig, by string) error {
	c.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	c.UpdatedBy = by
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return dbSetSetting(settingOpenCodeProvider, string(b), by)
}

// hasControlChars reports a byte that no provider id, model id, key or
// setting contains — and that a line-oriented env file must never be handed.
func hasControlChars(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// customProviderIDRe is the shape of a custom provider id: it becomes the
// prefix of every model reference (`<id>/<model>`) and a policy resource.
var customProviderIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

func validModelID(id string) bool {
	return id != "" && !strings.Contains(id, "#") && !strings.ContainsAny(id, " \t") && !hasControlChars(id)
}

// validateBaseURL accepts an absolute http(s) URL with a host and nothing a
// shell line or a JSON string could trip over.
func validateBaseURL(raw string) error {
	if hasControlChars(raw) || strings.ContainsAny(raw, " \t\"'") {
		return fmt.Errorf("the endpoint URL contains characters a URL cannot")
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("the endpoint must be an http(s) URL, e.g. https://llm.example.com/v1")
	}
	return nil
}

// validateOpenCodeProvider checks a setting about to be stored, without the
// catalogue: whether the provider exists and the model is one of its is the
// handler's job. An enabled setting needs a model, every plain setting its
// provider reads, and at least one secret (and, for a custom provider, an
// endpoint and models to offer); a disabled one may be partial — it keeps
// whatever was there for a one-click re-enable — but what it carries must
// still be well-formed.
func validateOpenCodeProvider(c openCodeProviderConfig) error {
	switch {
	case c.Custom != nil:
		if !customProviderIDRe.MatchString(c.Provider) {
			return fmt.Errorf("a custom provider id is lowercase letters, digits, '-' and '_' (e.g. acme)")
		}
		if hasControlChars(c.Custom.Name) {
			return fmt.Errorf("the display name contains characters it cannot")
		}
		if _, ok := openCodePackageByID(c.Custom.Package); !ok {
			return fmt.Errorf("choose which API the endpoint speaks")
		}
		listed := false
		for _, m := range c.Custom.Models {
			if !validModelID(m.ID) || hasControlChars(m.Name) {
				return fmt.Errorf("a listed model needs an id without spaces or '#'")
			}
			listed = listed || m.ID == c.Model
		}
		if c.Enabled {
			if c.BaseURL == "" {
				return fmt.Errorf("a custom provider needs an endpoint URL")
			}
			if len(c.Custom.Models) == 0 && c.Custom.Canonical == "" {
				return fmt.Errorf("list at least one model, or inherit the models of a catalogue provider")
			}
			if len(c.Custom.Models) > 0 && c.Custom.Canonical == "" && c.Model != "" && !listed {
				return fmt.Errorf("the default model must be one of the listed models")
			}
		}
	case c.Provider != "" || c.Enabled:
		if c.Provider == "" {
			return fmt.Errorf("choose a provider")
		}
		if hasControlChars(c.Provider) || strings.ContainsAny(c.Provider, " \t/#'") {
			return fmt.Errorf("that is not a provider id")
		}
		if c.SelfHosted && c.Enabled && c.BaseURL == "" {
			return fmt.Errorf("a self-hosted server needs its URL")
		}
	}
	if c.BaseURL != "" {
		if err := validateBaseURL(c.BaseURL); err != nil {
			return err
		}
	}
	if c.Enabled && c.Model == "" {
		return fmt.Errorf("a model is required — it is the one OpenCode uses unless a person picks another")
	}
	if c.Model != "" && !validModelID(c.Model) {
		return fmt.Errorf("the model id may not contain spaces or '#'")
	}
	for name, value := range c.Values {
		v, ok := c.varByName(name)
		if !ok {
			return fmt.Errorf("%s is not something this provider reads", name)
		}
		if v.File {
			if value != "" && !json.Valid([]byte(value)) {
				return fmt.Errorf("%s must be the JSON document the provider issued", name)
			}
		} else if hasControlChars(value) {
			return fmt.Errorf("%s contains characters it cannot", name)
		}
	}
	if c.Enabled {
		if len(c.Vars) == 0 {
			return fmt.Errorf("the provider's credentials are missing")
		}
		secret, needSecret := false, false
		for _, v := range c.Vars {
			if v.Secret {
				secret = secret || c.Values[v.Name] != ""
				needSecret = needSecret || !v.Optional
			} else if c.Values[v.Name] == "" {
				return fmt.Errorf("%s is required", v.Label)
			}
		}
		if needSecret && !secret {
			return fmt.Errorf("an API key is required")
		}
	}
	return nil
}

// --- the files in each workspace's agent home ------------------------------------

const openCodeProviderEnvFile = "opencode-provider.env"

// The agent's home and the daemon's directory in it, as the container sees them.
const (
	agentHomeInContainer = "/home/agent"
	agentBitswanDirName  = ".bitswan"
	credentialFileSuffix = ".credential.json"
)

// openCodeProviderEnvPath is where a workspace's agent finds the file. The
// coding-agent compose mounts coding-agent-home at /home/agent, so inside the
// container this is /home/agent/.bitswan/opencode-provider.env — the path
// bitswan-opencode-server reads.
func openCodeProviderEnvPath(workspacePath string) string {
	return filepath.Join(workspacePath, "coding-agent-home", agentBitswanDirName, openCodeProviderEnvFile)
}

// credentialFileName is the file a document-valued variable points at, kept
// next to the env file: <VAR>.credential.json.
func credentialFileName(varName string) string {
	return varName + credentialFileSuffix
}

// shellSingleQuote quotes s for a POSIX shell. Inside single quotes nothing
// expands, and an embedded quote becomes '\”. The file is sourced by bash,
// where a double-quoted $, backtick or backslash would expand or run — so it
// is never strconv.Quote.
func shellSingleQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// renderOpenCodeProviderEnv is the file for c, or "" when there should be no
// file at all (disabled or incomplete). One NAME='value' per line: the
// BITSWAN_OPENCODE_* lines tell the launcher what to generate — the provider
// and model, an endpoint override, a custom provider's description — and
// then the provider's own variables, the only place the credentials appear.
// A document-valued variable points at its credential file instead.
func renderOpenCodeProviderEnv(c openCodeProviderConfig) string {
	if !c.Enabled || validateOpenCodeProvider(c) != nil {
		return ""
	}
	// Empty for a custom endpoint or self-hosted server without a key: the
	// launcher then checks nothing and hands the provider no credential.
	env := c.keyEnv()
	var b strings.Builder
	b.WriteString("# Written by the Bailey automation server from the server-wide OpenCode\n")
	b.WriteString("# provider setting; overwritten on every change. bitswan-opencode-server\n")
	b.WriteString("# sources this file when it starts a server.\n")
	line := func(name, value string) { fmt.Fprintf(&b, "%s=%s\n", name, shellSingleQuote(value)) }
	line("BITSWAN_OPENCODE_PROVIDER", c.Provider)
	line("BITSWAN_OPENCODE_PROVIDER_ENV", env)
	line("BITSWAN_OPENCODE_MODEL", c.Model)
	line("BITSWAN_OPENCODE_RESTRICT", strconv.FormatBool(c.Restrict))
	if c.BaseURL != "" {
		line("BITSWAN_OPENCODE_BASE_URL", c.BaseURL)
	}
	if c.SelfHosted {
		line("BITSWAN_OPENCODE_SELF_HOSTED", "true")
	}
	if c.Custom != nil {
		line("BITSWAN_OPENCODE_CUSTOM", "true")
		line("BITSWAN_OPENCODE_CUSTOM_NAME", c.Custom.Name)
		line("BITSWAN_OPENCODE_CUSTOM_PACKAGE", c.Custom.Package)
		if c.Custom.Canonical != "" {
			line("BITSWAN_OPENCODE_CUSTOM_CANONICAL", c.Custom.Canonical)
		}
		if len(c.Custom.Models) > 0 {
			models, _ := json.Marshal(c.Custom.Models)
			line("BITSWAN_OPENCODE_CUSTOM_MODELS", string(models))
		}
	}
	for _, v := range c.Vars {
		value := c.Values[v.Name]
		if value == "" {
			continue
		}
		if v.File {
			line(v.Name, filepath.Join(agentHomeInContainer, agentBitswanDirName, credentialFileName(v.Name)))
		} else {
			line(v.Name, value)
		}
	}
	return b.String()
}

// credentialFiles is what should sit next to the env file: the document-valued
// variables, by file name. Empty when there is no file to render.
func credentialFiles(c openCodeProviderConfig) map[string]string {
	out := map[string]string{}
	if renderOpenCodeProviderEnv(c) == "" {
		return out
	}
	for _, v := range c.Vars {
		if v.File && c.Values[v.Name] != "" {
			out[credentialFileName(v.Name)] = c.Values[v.Name]
		}
	}
	return out
}

// dashboardDefaultsFile is what the workspace dashboard reads for settings
// that apply to everyone who has not chosen for themselves. It sits at the
// root of the claude-configs subpath, which the dashboard mounts as its
// config root (/claude-config); the per-user directories live next to it.
const dashboardDefaultsFile = "dashboard-defaults.json"

func dashboardDefaultsPath(workspacePath string) string {
	return filepath.Join(workspacePath, "claude-configs", dashboardDefaultsFile)
}

// renderDashboardDefaults is the defaults file for c, or "" when there should
// be none: OpenCode becomes the default coding agent only while the provider
// is enabled and complete, so nobody is steered to an agent with no model.
func renderDashboardDefaults(c openCodeProviderConfig) string {
	if !c.DefaultAgent || renderOpenCodeProviderEnv(c) == "" {
		return ""
	}
	return "{\"codingAgent\": \"opencode\"}\n"
}

// The agent user inside the coding-agent image; services.CodingAgentService
// hands it the agent home the same way when the agent is enabled.
const agentUID, agentGID = 1000, 1000

// chownToAgent gives the agent user a path the daemon wrote into the agent's
// home. Mirrors CodingAgentService.Enable: plain chown as root, sudo otherwise.
// A variable so tests, which need no root, can watch it instead.
var chownToAgent = func(path string) error {
	if os.Geteuid() == 0 {
		return os.Chown(path, agentUID, agentGID)
	}
	out, err := exec.Command("sudo", "chown", strconv.Itoa(agentUID)+":"+strconv.Itoa(agentGID), path).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// openCodeProviderSyncMu serialises syncs: the reconcile tick and a console
// save can run at once, and each must see the setting as it is when it runs,
// or the tick could put a just-replaced key back until the next tick.
var openCodeProviderSyncMu sync.Mutex

// syncOpenCodeProviderFiles brings every workspace's files in line with the
// setting. Per-workspace failures are logged and skipped: one broken
// workspace must not keep the others from getting the provider.
func syncOpenCodeProviderFiles() {
	openCodeProviderSyncMu.Lock()
	defer openCodeProviderSyncMu.Unlock()
	cfg, err := getOpenCodeProvider()
	if err != nil {
		fmt.Printf("opencode provider: could not read the setting: %v\n", err)
		return
	}
	names, err := listWorkspaceNames()
	if err != nil {
		fmt.Printf("opencode provider: could not list workspaces: %v\n", err)
		return
	}
	for _, ws := range names {
		if err := syncOpenCodeProviderFileWith(ws, cfg); err != nil {
			fmt.Printf("opencode provider: workspace '%s': %v\n", ws, err)
		}
	}
}

// syncOpenCodeProviderFileForWorkspace is the one-workspace form, for the
// moment the agent is enabled in a workspace.
func syncOpenCodeProviderFileForWorkspace(ws string) error {
	openCodeProviderSyncMu.Lock()
	defer openCodeProviderSyncMu.Unlock()
	cfg, err := getOpenCodeProvider()
	if err != nil {
		return err
	}
	return syncOpenCodeProviderFileWith(ws, cfg)
}

// syncOpenCodeProviderFileWith brings one workspace's files in line with cfg:
// the provider file and any credential documents in the agent's home, and the
// dashboard's defaults file that makes OpenCode the agent for people who have
// not chosen.
func syncOpenCodeProviderFileWith(ws string, cfg openCodeProviderConfig) error {
	// A recovery is replacing the workspace directory, and a trashed workspace
	// has no running agent; neither is touched (listWorkspaceNames lists both).
	if workspaceUnderRecovery(ws) || IsWorkspaceTrashed(ws) {
		return nil
	}
	svc, err := services.NewCodingAgentService(ws)
	if err != nil || !svc.IsEnabled() {
		return nil
	}
	if err := writeOpenCodeProviderFiles(svc.WorkspacePath, cfg); err != nil {
		return err
	}
	return writeDashboardDefaultsFile(svc.WorkspacePath, renderDashboardDefaults(cfg))
}

// writeOpenCodeProviderFiles puts the env file and the credential documents
// in the workspace's agent home, or removes them when there should be none.
// A workspace whose agent home does not exist is skipped: Enable creates the
// home, this never does. The files are the agent user's alone (0600).
func writeOpenCodeProviderFiles(workspacePath string, cfg openCodeProviderConfig) error {
	home := filepath.Join(workspacePath, "coding-agent-home")
	if st, err := os.Stat(home); err != nil || !st.IsDir() {
		return nil
	}
	dir := filepath.Join(home, agentBitswanDirName)
	wanted := credentialFiles(cfg)
	// Credential documents of a provider that is no longer the one: gone.
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), credentialFileSuffix) && wanted[e.Name()] == "" {
				if err := os.Remove(filepath.Join(dir, e.Name())); err != nil {
					return err
				}
			}
		}
	}
	for name, content := range wanted {
		if err := writeAgentOwnedFile(filepath.Join(dir, name), content, 0o600); err != nil {
			return err
		}
	}
	return writeAgentOwnedFile(openCodeProviderEnvPath(workspacePath), renderOpenCodeProviderEnv(cfg), 0o600)
}

// writeDashboardDefaultsFile puts content at the workspace's dashboard
// defaults path, or removes the file when content is empty. A workspace with
// no claude-configs directory yet (it appears with the dashboard's first
// start) is skipped; the next tick catches it. Holding no secret, the file is
// world-readable.
func writeDashboardDefaultsFile(workspacePath, content string) error {
	dir := filepath.Join(workspacePath, "claude-configs")
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return nil
	}
	return writeAgentOwnedFile(dashboardDefaultsPath(workspacePath), content, 0o644)
}

// writeAgentOwnedFile writes content to path with mode, or removes path when
// content is empty. Only on a change, through a temp file in the same
// directory, with the directory and the file handed to the agent user before
// the rename. The daemon runs as root and the container's own chown of
// /home/agent runs only when the container starts, so a root-owned 0600 file
// dropped into a running container would be unreadable by the agent — and the
// next server would start without the provider, silently.
func writeAgentOwnedFile(path, content string, mode os.FileMode) error {
	if content == "" {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove %s: %w", path, err)
		}
		return nil
	}
	if cur, err := os.ReadFile(path); err == nil && string(cur) == content {
		return nil
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := chownToAgent(dir); err != nil {
		return fmt.Errorf("chown %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	fail := func(err error) error {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		return fail(err)
	}
	if _, err := tmp.WriteString(content); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		return fail(err)
	}
	if err := chownToAgent(tmpPath); err != nil {
		return fail(fmt.Errorf("chown %s: %w", tmpPath, err))
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fail(fmt.Errorf("rename into place: %w", err))
	}
	return nil
}

// --- the admin API --------------------------------------------------------------

// openCodeSecretState is what the console learns about a stored secret: that
// there is one, and its last few characters.
type openCodeSecretState struct {
	Set  bool   `json:"set"`
	Hint string `json:"hint,omitempty"`
}

// openCodeProviderDTO is what the console sees. Secrets are never in it —
// only whether each is stored and its last four characters; plain settings
// (a resource name, a region) are echoed so they can be edited.
type openCodeProviderDTO struct {
	Enabled      bool                           `json:"enabled"`
	Provider     string                         `json:"provider"`
	Model        string                         `json:"model"`
	Vars         []openCodeEnvVar               `json:"vars"`
	Values       map[string]string              `json:"values"`
	Secrets      map[string]openCodeSecretState `json:"secrets"`
	Restrict     bool                           `json:"restrict"`
	BaseURL      string                         `json:"base_url,omitempty"`
	Custom       *openCodeCustomProvider        `json:"custom,omitempty"`
	SelfHosted   bool                           `json:"self_hosted,omitempty"`
	DefaultAgent bool                           `json:"default_agent"`
	UpdatedAt    string                         `json:"updated_at,omitempty"`
	UpdatedBy    string                         `json:"updated_by,omitempty"`
	Providers    []openCodeProvider             `json:"providers"`
	Packages     []openCodePackage              `json:"packages"`
	// CatalogError says why Providers is empty: models.dev could not be
	// reached and there is no earlier copy. The stored setting still shows.
	CatalogError string `json:"catalog_error,omitempty"`
}

func openCodeProviderDTOFrom(c openCodeProviderConfig) openCodeProviderDTO {
	d := openCodeProviderDTO{
		Enabled:      c.Enabled,
		Provider:     c.Provider,
		Model:        c.Model,
		Vars:         c.Vars,
		Values:       map[string]string{},
		Secrets:      map[string]openCodeSecretState{},
		Restrict:     c.Restrict,
		BaseURL:      c.BaseURL,
		Custom:       c.Custom,
		SelfHosted:   c.SelfHosted,
		DefaultAgent: c.DefaultAgent,
		UpdatedAt:    c.UpdatedAt,
		UpdatedBy:    c.UpdatedBy,
		Providers:    []openCodeProvider{},
		Packages:     openCodePackages,
	}
	if d.Vars == nil {
		d.Vars = []openCodeEnvVar{}
	}
	for _, v := range c.Vars {
		value := c.Values[v.Name]
		if !v.Secret {
			d.Values[v.Name] = value
			continue
		}
		state := openCodeSecretState{Set: value != ""}
		if n := len(value); !v.File && n >= 12 {
			state.Hint = value[n-4:]
		}
		d.Secrets[v.Name] = state
	}
	// Self-hosted servers need no catalogue and come first.
	d.Providers = append(d.Providers, openCodeSelfHosted...)
	if cat, err := loadOpenCodeCatalog(); err != nil {
		d.CatalogError = err.Error()
	} else {
		d.Providers = append(d.Providers, cat.Providers...)
	}
	return d
}

func writeOpenCodeProviderDTO(w http.ResponseWriter) {
	c, err := getOpenCodeProvider()
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, openCodeProviderDTOFrom(c))
}

// GET /bailey/api/admin/opencode-provider
func handleOpenCodeProviderGet(w http.ResponseWriter, r *http.Request) {
	writeOpenCodeProviderDTO(w)
}

// GET /bailey/api/admin/opencode-provider/models?provider=<id> — a catalogue
// provider's models, for the console's model picker. Fetched on demand: the
// whole catalogue is thousands of models.
func handleOpenCodeProviderModels(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("provider"))
	cat, err := loadOpenCodeCatalog()
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusBadGateway)
		return
	}
	models, ok := cat.Models[id]
	if !ok {
		writeJSONError(w, "no such provider in OpenCode's catalogue", http.StatusNotFound)
		return
	}
	writeJSON(w, map[string]any{"provider": id, "models": models})
}

// openCodeProviderRequest is the POST body. Values carries what the admin
// entered per env var; a blank secret keeps the stored one (the console never
// has it to send back), a blank plain setting clears it. enabled:false keeps
// everything and removes the files, so one click brings it back; clear:true
// forgets the setting, secrets included. There are no DELETE routes in the
// dispatcher, so clearing is a POST like the default-images setting.
type openCodeProviderRequest struct {
	Enabled      bool                    `json:"enabled"`
	Provider     string                  `json:"provider"`
	Model        string                  `json:"model"`
	Values       map[string]string       `json:"values"`
	Restrict     bool                    `json:"restrict"`
	BaseURL      string                  `json:"base_url"`
	Custom       *openCodeCustomProvider `json:"custom"`
	DefaultAgent bool                    `json:"default_agent"`
	Clear        bool                    `json:"clear"`
}

// tidyCustomProvider trims a submitted custom provider, drops empty model rows
// and gives it a display name when none was typed.
func tidyCustomProvider(id string, in *openCodeCustomProvider) *openCodeCustomProvider {
	if in == nil {
		return nil
	}
	out := &openCodeCustomProvider{
		Name:      strings.TrimSpace(in.Name),
		Package:   strings.TrimSpace(in.Package),
		Canonical: strings.TrimSpace(in.Canonical),
	}
	if out.Name == "" {
		out.Name = id
	}
	for _, m := range in.Models {
		m.ID, m.Name = strings.TrimSpace(m.ID), strings.TrimSpace(m.Name)
		if m.ID != "" || m.Name != "" {
			out.Models = append(out.Models, m)
		}
	}
	return out
}

// POST /bailey/api/admin/opencode-provider
func handleOpenCodeProviderSet(w http.ResponseWriter, r *http.Request, by string) {
	var req openCodeProviderRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 256<<10)).Decode(&req); err != nil {
		writeJSONError(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Clear {
		if err := dbDeleteSetting(settingOpenCodeProvider); err != nil {
			writeJSONError(w, err.Error(), http.StatusInternalServerError)
			return
		}
		syncOpenCodeProviderFiles()
		_ = recordEvent(by, "opencode.provider.clear", "")
		writeOpenCodeProviderDTO(w)
		return
	}

	existing, err := getOpenCodeProvider()
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	c := openCodeProviderConfig{
		Enabled:      req.Enabled,
		Provider:     strings.TrimSpace(req.Provider),
		Model:        strings.TrimSpace(req.Model),
		Restrict:     req.Restrict,
		BaseURL:      strings.TrimSpace(req.BaseURL),
		DefaultAgent: req.DefaultAgent,
		Values:       map[string]string{},
	}
	c.Custom = tidyCustomProvider(c.Provider, req.Custom)

	// The provider's variables come from the catalogue (or are the one custom
	// key), never from the request: the console cannot invent what a provider
	// reads.
	if c.Custom != nil {
		c.Vars = openCodeCustomVars
		// A catalogue id is chosen from the list, not typed as a custom one;
		// with the catalogue unreachable the check is skipped, not failed.
		if _, taken, err := openCodeProviderByID(c.Provider); err == nil && taken {
			writeJSONCodeError(w, fmt.Sprintf("%q is a provider in OpenCode's catalogue — choose it from the list, or give the custom provider another id", c.Provider), "invalid_config", http.StatusBadRequest)
			return
		}
	} else if c.Provider != "" {
		p, ok, err := openCodeProviderByID(c.Provider)
		if err != nil {
			writeJSONCodeError(w, err.Error(), "catalog_unavailable", http.StatusBadGateway)
			return
		}
		if !ok {
			writeJSONCodeError(w, "choose a provider from OpenCode's catalogue", "invalid_config", http.StatusBadRequest)
			return
		}
		c.Vars = p.Env
		c.SelfHosted = p.SelfHosted
		// A self-hosted server's models are the server's; the catalogue
		// cannot vouch for them.
		if c.Enabled && c.Model != "" && !p.SelfHosted {
			if cat, err := loadOpenCodeCatalog(); err == nil {
				known := false
				for _, m := range cat.Models[c.Provider] {
					known = known || m.ID == c.Model
				}
				if !known {
					writeJSONCodeError(w, fmt.Sprintf("%s has no model %q in OpenCode's catalogue", p.Name, c.Model), "invalid_config", http.StatusBadRequest)
					return
				}
			}
		}
	}
	// Values: what was entered, with a blank secret keeping the stored one —
	// but only for the same provider; another provider's key is not this one's.
	sameProvider := existing.Provider == c.Provider && (existing.Custom == nil) == (c.Custom == nil)
	for _, v := range c.Vars {
		value := strings.TrimSpace(req.Values[v.Name])
		if value == "" && v.Secret && sameProvider {
			value = existing.Values[v.Name]
		}
		if value != "" {
			c.Values[v.Name] = value
		}
	}
	if err := validateOpenCodeProvider(c); err != nil {
		writeJSONCodeError(w, err.Error(), "invalid_config", http.StatusBadRequest)
		return
	}
	if err := setOpenCodeProvider(c, by); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	syncOpenCodeProviderFiles()
	if c.Enabled {
		_ = recordEvent(by, "opencode.provider.configure", c.Provider+"/"+c.Model)
	} else {
		_ = recordEvent(by, "opencode.provider.disable", c.Provider)
	}
	writeOpenCodeProviderDTO(w)
}
