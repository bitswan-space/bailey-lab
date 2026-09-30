package daemon

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// OpenCode's provider catalogue, read live from models.dev — the same source
// OpenCode itself reads at start-up and caches in its database. The Bailey
// console offers what `/connect` offers, minus the sign-in-only providers:
// every provider, with the environment variables it reads its credentials and
// settings from, and its models. Nothing is checked in; the daemon keeps the
// last good copy on disk and serves it when models.dev cannot be reached,
// which is what OpenCode does with its own cache.

const modelsDevURL = "https://models.dev/api.json"

// openCodeCatalogTTL is how long a fetched catalogue is served before it is
// refreshed. The console is an admin page opened now and then; an hour keeps
// it current without a fetch per click.
const openCodeCatalogTTL = time.Hour

// fetchModelsDev gets the raw catalogue. A variable so tests can hand in a
// fixture instead of reaching the network.
var fetchModelsDev = func() ([]byte, error) {
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Get(modelsDevURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: %s", modelsDevURL, resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 64<<20))
}

// openCodeCatalogCachePath is the on-disk copy, next to bailey.db.
func openCodeCatalogCachePath() string {
	return filepath.Join(os.Getenv("HOME"), ".config", "bitswan", "opencode-catalog.json")
}

// openCodeSignInOnly names the catalogue providers whose only way in is a
// sign-in flow a person completes themselves (device OAuth); a server-wide
// setting cannot hold one, so the console does not offer them. models.dev
// lists an env var for Copilot, but OpenCode's own docs say it takes no
// manual key.
var openCodeSignInOnly = map[string]bool{"github-copilot": true}

// openCodePopular is the short list the console shows before the rest.
var openCodePopular = []string{"anthropic", "openai", "google", "openrouter", "mistral", "groq", "xai", "deepseek", "opencode"}

// openCodeEnvVar is one environment variable a provider reads. Secret ones
// (keys, tokens) are write-only in the console; a File one holds a document
// (Google's service-account JSON) that the daemon writes to a file the
// variable then points at. Label is what the console shows for it — an
// admin fills in "Resource name" and "API key", never AZURE_RESOURCE_NAME.
type openCodeEnvVar struct {
	Name   string `json:"name"`
	Label  string `json:"label"`
	Secret bool   `json:"secret"`
	File   bool   `json:"file,omitempty"`
}

// envWords spells out the tokens of a variable name that are not plain words.
var envWords = map[string]string{
	"API": "API", "APIKEY": "API key", "ID": "ID", "URL": "URL", "PAT": "personal access token",
	"HF": "Hugging Face", "OCI": "OCI", "SSO": "SSO", "AWS": "AWS",
}

// envNoise names tokens that add nothing to a label once the provider's own
// name is gone.
var envNoise = map[string]bool{"AI": true, "GENERATIVE": true}

// labelForEnvVar turns a variable name into the words an admin reads: the
// provider's own name is dropped from the front and the back (AZURE_ from
// AZURE_RESOURCE_NAME, _BEDROCK from AWS_BEARER_TOKEN_BEDROCK), a few
// brand and filler tokens go too, and the rest is spelled out.
func labelForEnvVar(providerID, name string) string {
	brand := map[string]bool{"AWS": true, "GOOGLE": true, "GCP": true, "MS": true}
	idTokens := strings.FieldsFunc(strings.ToUpper(providerID), func(r rune) bool { return r == '-' || r == '_' || r == '.' })
	own := map[string]bool{}
	for k := range brand {
		own[k] = true
	}
	for _, t := range idTokens {
		own[t] = true
	}
	tokens := strings.Split(strings.ToUpper(name), "_")
	// The front is the provider's name only as far as it runs in order
	// (GOOGLE_VERTEX_ from google-vertex, not GATEWAY from
	// cloudflare-ai-gateway's CLOUDFLARE_GATEWAY_ID); a brand token may
	// stand in for it (AWS_ for amazon-bedrock).
	stripped := 0
	for len(tokens) > 1 && stripped < len(idTokens) && tokens[0] == idTokens[stripped] {
		tokens = tokens[1:]
		stripped++
	}
	if stripped == 0 && len(tokens) > 1 && brand[tokens[0]] {
		tokens = tokens[1:]
	}
	for len(tokens) > 1 && own[tokens[len(tokens)-1]] {
		tokens = tokens[:len(tokens)-1]
	}
	words := make([]string, 0, len(tokens))
	for _, t := range tokens {
		if envNoise[t] && len(tokens) > 1 {
			continue
		}
		if w, ok := envWords[t]; ok {
			words = append(words, w)
		} else {
			words = append(words, strings.ToLower(t))
		}
	}
	if len(words) == 0 {
		return "Value"
	}
	label := strings.Join(words, " ")
	return strings.ToUpper(label[:1]) + label[1:]
}

// openCodeProvider is one catalogue entry as the console sees it. When every
// variable is a secret, they are alternative names for one key (Google's
// three) and the console shows one field; otherwise the plain ones are
// settings the provider needs next to its key (Azure's resource name,
// Bedrock's region) and each gets a field.
type openCodeProvider struct {
	ID         string           `json:"id"`
	Name       string           `json:"name"`
	Env        []openCodeEnvVar `json:"env"`
	Popular    bool             `json:"popular,omitempty"`
	ModelCount int              `json:"model_count"`
}

type openCodeModel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

var (
	secretEnvRe = regexp.MustCompile(`KEY|TOKEN|SECRET|CREDENTIALS|PASSWORD|PAT$`)
	fileEnvRe   = regexp.MustCompile(`CREDENTIALS$`)
)

// classifyEnvVar decides what a variable holds from its name. Across the
// whole catalogue the names that are not keys or tokens are resource names,
// account and project ids, regions, hosts and endpoints, and the one file is
// Google's application credentials. An AWS access key id counts as a secret:
// it is half of a credential, entered with the secret key, not a setting.
func classifyEnvVar(providerID, name string) openCodeEnvVar {
	v := openCodeEnvVar{Name: name, Label: labelForEnvVar(providerID, name)}
	if fileEnvRe.MatchString(name) {
		v.Secret, v.File = true, true
		return v
	}
	v.Secret = secretEnvRe.MatchString(name)
	return v
}

// allSecrets reports whether a provider's variables are alternative names for
// one credential rather than a credential plus settings.
func (p openCodeProvider) allSecrets() bool {
	for _, v := range p.Env {
		if !v.Secret {
			return false
		}
	}
	return len(p.Env) > 0
}

// openCodeCatalog is the reduced catalogue plus the models per provider.
type openCodeCatalog struct {
	FetchedAt time.Time
	Providers []openCodeProvider
	Models    map[string][]openCodeModel
}

type modelsDevProvider struct {
	Name   string `json:"name"`
	Env    []string
	Models map[string]struct {
		Name string `json:"name"`
	} `json:"models"`
}

// parseModelsDev reduces the raw catalogue to what the console needs.
func parseModelsDev(raw []byte) (*openCodeCatalog, error) {
	var full map[string]modelsDevProvider
	if err := json.Unmarshal(raw, &full); err != nil {
		return nil, fmt.Errorf("models.dev catalogue is not the JSON expected: %w", err)
	}
	if len(full) == 0 {
		return nil, fmt.Errorf("models.dev catalogue is empty")
	}
	popular := map[string]bool{}
	for _, id := range openCodePopular {
		popular[id] = true
	}
	cat := &openCodeCatalog{Models: map[string][]openCodeModel{}}
	for id, p := range full {
		if openCodeSignInOnly[id] || len(p.Env) == 0 || p.Name == "" {
			continue
		}
		entry := openCodeProvider{ID: id, Name: p.Name, Popular: popular[id], ModelCount: len(p.Models)}
		for _, e := range p.Env {
			entry.Env = append(entry.Env, classifyEnvVar(id, e))
		}
		cat.Providers = append(cat.Providers, entry)
		models := make([]openCodeModel, 0, len(p.Models))
		for mid, m := range p.Models {
			models = append(models, openCodeModel{ID: mid, Name: m.Name})
		}
		sort.Slice(models, func(i, j int) bool { return models[i].ID < models[j].ID })
		cat.Models[id] = models
	}
	sort.Slice(cat.Providers, func(i, j int) bool { return cat.Providers[i].ID < cat.Providers[j].ID })
	return cat, nil
}

var (
	openCodeCatalogMu     sync.Mutex
	openCodeCatalogCached *openCodeCatalog
)

// loadOpenCodeCatalog returns the catalogue: the in-memory copy while it is
// fresh, else a new fetch, else the on-disk copy from the last good fetch
// (however old), else an error saying models.dev is unreachable — there is no
// built-in fallback, as there is none in OpenCode.
func loadOpenCodeCatalog() (*openCodeCatalog, error) {
	openCodeCatalogMu.Lock()
	defer openCodeCatalogMu.Unlock()
	if c := openCodeCatalogCached; c != nil && time.Since(c.FetchedAt) < openCodeCatalogTTL {
		return c, nil
	}
	raw, fetchErr := fetchModelsDev()
	if fetchErr == nil {
		cat, err := parseModelsDev(raw)
		if err == nil {
			cat.FetchedAt = time.Now()
			openCodeCatalogCached = cat
			if err := writeOpenCodeCatalogCache(raw); err != nil {
				fmt.Printf("opencode catalogue: could not cache models.dev: %v\n", err)
			}
			return cat, nil
		}
		fetchErr = err
	}
	if c := openCodeCatalogCached; c != nil {
		fmt.Printf("opencode catalogue: models.dev unavailable (%v); serving the copy from %s\n", fetchErr, c.FetchedAt.Format(time.RFC3339))
		return c, nil
	}
	if cat, at, err := readOpenCodeCatalogCache(); err == nil {
		cat.FetchedAt = at
		openCodeCatalogCached = cat
		fmt.Printf("opencode catalogue: models.dev unavailable (%v); serving the copy from %s\n", fetchErr, at.Format(time.RFC3339))
		return cat, nil
	}
	return nil, fmt.Errorf("OpenCode's provider catalogue could not be fetched from models.dev (%v) and there is no earlier copy", fetchErr)
}

func writeOpenCodeCatalogCache(raw []byte) error {
	path := openCodeCatalogCachePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func readOpenCodeCatalogCache() (*openCodeCatalog, time.Time, error) {
	path := openCodeCatalogCachePath()
	st, err := os.Stat(path)
	if err != nil {
		return nil, time.Time{}, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, time.Time{}, err
	}
	cat, err := parseModelsDev(raw)
	if err != nil {
		return nil, time.Time{}, err
	}
	// The copy is served as of when it was fetched: the mtime, not now, so
	// the next call tries models.dev again instead of trusting it for an hour.
	return cat, st.ModTime().Add(-openCodeCatalogTTL), nil
}

// openCodeProviderByID looks a catalogue provider up; a sign-in-only one is
// not found. The error is the catalogue being unavailable.
func openCodeProviderByID(id string) (openCodeProvider, bool, error) {
	cat, err := loadOpenCodeCatalog()
	if err != nil {
		return openCodeProvider{}, false, err
	}
	for _, p := range cat.Providers {
		if p.ID == id {
			return p, true, nil
		}
	}
	return openCodeProvider{}, false, nil
}
