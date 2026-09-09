package core

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	toml "github.com/BurntSushi/toml"
)

// MaxNameLen caps a workspace/automation name component (gitops
// automation_service.MAX_NAME_LEN = 24). MaxLabelLen is the hard DNS label
// limit the FULL hostname must never exceed — see MakeHostnameLabel, which caps
// the assembled label there while preserving the discriminating tail (context
// hash + stage + slot), since the color slot names are far longer than a/b/c.
const (
	MaxNameLen  = 24
	MaxLabelLen = 63
)

// AppSlots is the blue-green app slot order (AutomationService.APP_SLOTS).
var AppSlots = [3]string{"blue", "green", "purple"}

var (
	sanitizeRe = regexp.MustCompile(`[^a-z0-9-]`)
	copyDBRe   = regexp.MustCompile(`[^a-z0-9_]`)
)

// ShortHash is the deterministic 4-char context hash (_short_hash).
func ShortHash(context string) string {
	sum := sha256.Sum256([]byte(context))
	return hex.EncodeToString(sum[:])[:4]
}

// SanitizeAutomationName mirrors utils.sanitize_automation_name: lowercase,
// replace each char outside [a-z0-9-] with '-', trim leading/trailing hyphens.
func SanitizeAutomationName(name string) string {
	return strings.Trim(sanitizeRe.ReplaceAllString(strings.ToLower(name), "-"), "-")
}

// MakeHostnameLabel builds a DNS hostname label from structured components
// (automation_service.make_hostname_label). slot ("blue"/"green") is appended as a
// trailing segment; pass "" for non-production.
func MakeHostnameLabel(workspaceName, automationName, context, stage, slot string) string {
	ws := Truncate(workspaceName, MaxNameLen)
	an := Truncate(automationName, MaxNameLen)

	// Build the discriminating tail (context hash + stage + slot). These MUST
	// survive intact: the hash keeps distinct contexts distinct, the stage keeps
	// dev/staging/production/dr distinct, and the slot keeps blue/green/purple
	// distinct. Only the human-readable ws/an names are truncated to fit 63.
	tail := []string{}
	if context != "" {
		tail = append(tail, ShortHash(context))
	}
	if stage != "" {
		tail = append(tail, stage)
	}
	if slot != "" {
		tail = append(tail, slot)
	}

	label := JoinNonEmpty("-", ws, an, JoinNonEmpty("-", tail...))
	if len(label) <= MaxLabelLen {
		return label
	}

	// Over the limit (long workspace+automation names + a long slot name like
	// "purple"): shrink ws+an to the remaining budget, splitting it between them,
	// keeping the tail whole. Collisions would need the same ws/an prefixes AND
	// the same context hash — vanishingly unlikely.
	tailStr := JoinNonEmpty("-", tail...)
	budget := MaxLabelLen - len(tailStr) - 2 // 2 separators: ws-an-tail
	if budget < 2 {
		budget = 2
	}
	half := budget / 2
	ws = Truncate(ws, half)
	an = Truncate(an, budget-len(ws))
	return JoinNonEmpty("-", ws, an, tailStr)
}

// JoinNonEmpty joins the non-empty parts with sep.
func JoinNonEmpty(sep string, parts ...string) string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, sep)
}

func Truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// RealmForStage maps a deployment stage to its secret realm (bp_secrets).
// live-dev/dev -> dev; ""/production -> production; else the stage itself.
func RealmForStage(stage string) string {
	switch stage {
	case "live-dev", "dev":
		return "dev"
	case "", "production":
		return "production"
	default:
		return stage
	}
}

// StageForDeployment maps a deployment stage to its service realm
// (infra_service.stage_for_deployment): live-dev shares dev; else identity.
func StageForDeployment(stage string) string {
	if stage == "live-dev" {
		return "dev"
	}
	return stage
}

// PostureFor reports the default firewall posture for a realm
// (firewall_service.posture_for): staging/production enforce, else monitor.
func PostureFor(realm string) string {
	if realm == "staging" || realm == "production" {
		return "enforce"
	}
	return "monitor"
}

// AllowedHosts returns the sorted allow-listed hostnames for a BP+realm
// (firewall_service.allowed_hosts): rules whose status == "allowed".
func AllowedHosts(bs *Bitswan, bp, realm string) []string {
	node := FirewallNodeFor(bs, bp, realm)
	if node == nil {
		return nil
	}
	out := make([]string, 0, len(node.Rules))
	for h, r := range node.Rules {
		if r != nil && r.Status == "allowed" {
			out = append(out, h)
		}
	}
	sort.Strings(out)
	return out
}

func FirewallNodeFor(bs *Bitswan, bp, realm string) *FirewallNode {
	if bs.Firewall == nil {
		return nil
	}
	byRealm := bs.Firewall[bp]
	if byRealm == nil {
		return nil
	}
	return byRealm[realm]
}

// DeriveBPAndCopy derives (bp_slug, copy_name) from a relative_path
// (bp_databases.derive_bp_and_copy). relative_path looks like
// "copies/<copy>/<bp>/<rel>"; the main copy yields an empty copy context.
func DeriveBPAndCopy(relativePath string) (bpSlug, copyName string) {
	bpName := ""
	if relativePath != "" {
		parts := strings.Split(strings.ReplaceAll(relativePath, "\\", "/"), "/")
		if len(parts) >= 2 && parts[0] == "copies" {
			c := parts[1]
			if c != "main" {
				copyName = c
			}
			parts = parts[2:]
		}
		if len(parts) >= 2 {
			bpName = parts[0]
		}
	}
	if bpName != "" {
		bpSlug = SanitizeAutomationName(bpName)
	}
	return bpSlug, copyName
}

// BPResourceNames returns the stage-independent per-BP resource names
// (bp_databases.bp_resource_names). db (1/2) selects a blue-green logical DB;
// db==0 means the single-backend scheme (Python db=None).
func BPResourceNames(bpSlug string, db int) map[string]string {
	if db != 0 {
		pg := Truncate("bp_"+strings.ReplaceAll(bpSlug, "-", "_"), 61) + "_" + Itoa(db)
		bucket := strings.TrimRight(Truncate("bp-"+bpSlug, 61), "-") + "-" + Itoa(db)
		couch := "bp-" + bpSlug + "-" + Itoa(db) + "-"
		return map[string]string{"postgres_db": pg, "couchdb_prefix": couch, "s3_bucket": bucket}
	}
	pg := Truncate("bp_"+strings.ReplaceAll(bpSlug, "-", "_"), 63)
	bucket := strings.TrimRight(Truncate("bp-"+bpSlug, 63), "-")
	couch := "bp-" + bpSlug + "-"
	return map[string]string{"postgres_db": pg, "couchdb_prefix": couch, "s3_bucket": bucket}
}

func Itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

// CopyBPResourceNames returns the per-(copy, BP) live-dev resource names. A
// non-main copy is a developer's sandbox: each BP's live-dev backend gets its
// OWN Postgres database, S3 bucket and CouchDB prefix there — isolated from
// other BPs in the copy, from other copies, and from dev. Capped at the 63-byte
// Postgres/S3 limit (a truncation collision surfaces as a deploy error, not
// silent data sharing). Mirrors bp_databases.copy_bp_resource_names.
func CopyBPResourceNames(copyName, bpSlug string) map[string]string {
	cpU := copyDBRe.ReplaceAllString(strings.ToLower(copyName), "_") // [a-z0-9_] for pg
	cpD := SanitizeAutomationName(copyName)                          // [a-z0-9-] for s3/couch
	bpU := strings.ReplaceAll(bpSlug, "-", "_")
	pg := Truncate("copy_"+cpU+"_bp_"+bpU, MaxLabelLen)
	bucket := strings.TrimRight(Truncate("copy-"+cpD+"-bp-"+bpSlug, MaxLabelLen), "-")
	couch := "copy-" + cpD + "-bp-" + bpSlug + "-"
	return map[string]string{"postgres_db": pg, "couchdb_prefix": couch, "s3_bucket": bucket}
}

// ---- automation.toml ----

// AutomationConfig is the resolved automation.toml config (utils.AutomationConfig).
// Services preserves TOML declaration order — env_file injection order is
// observable in the generated compose, so it must match the Python (which
// iterates the toml dict in file order).
type AutomationConfig struct {
	Image              string
	Expose             bool
	Port               int
	MountPath          string
	ExternalTestingNet bool
	Services           []ServiceDep
}

// ServiceDep is one [services.<type>] dependency, in declaration order.
type ServiceDep struct {
	Type    string
	Enabled bool
}

// HasServices reports whether the automation declares any [services.*] deps.
func (c AutomationConfig) HasServices() bool { return len(c.Services) > 0 }

const DefaultRuntimeImage = "bitswan/pipeline-runtime-environment:latest"

func DefaultAutomationConfig() AutomationConfig {
	return AutomationConfig{Image: DefaultRuntimeImage, Expose: false, Port: 8080, MountPath: "/app/"}
}

// tomlAutomation mirrors the parsed automation.toml structure.
type tomlAutomation struct {
	Deployment struct {
		ID                 string `toml:"id"`
		Auth               bool   `toml:"auth"`
		Image              string `toml:"image"`
		Expose             bool   `toml:"expose"`
		Port               int    `toml:"port"`
		ExternalTestingNet bool   `toml:"external-testing-network"`
	} `toml:"deployment"`
	Services map[string]struct {
		Enabled *bool `toml:"enabled"`
	} `toml:"services"`
}

// ParseAutomationTOML parses automation.toml content (utils.parse_automation_toml).
func ParseAutomationTOML(content string) (AutomationConfig, bool) {
	if strings.TrimSpace(content) == "" {
		return AutomationConfig{}, false
	}
	var t tomlAutomation
	if _, err := toml.Decode(content, &t); err != nil {
		// Python raises ValueError on syntax error; the compiler treats an
		// unreadable toml as "no config" rather than failing the whole apply.
		return AutomationConfig{}, false
	}
	cfg := AutomationConfig{
		Image:              FirstNonEmpty(t.Deployment.Image, DefaultRuntimeImage),
		Expose:             t.Deployment.Expose,
		Port:               t.Deployment.Port,
		MountPath:          "/app/",
		ExternalTestingNet: t.Deployment.ExternalTestingNet,
	}
	if cfg.Port == 0 {
		cfg.Port = 8080
	}
	for _, svc := range ServiceOrder(content) {
		sc, ok := t.Services[svc]
		if !ok {
			continue
		}
		enabled := true
		if sc.Enabled != nil {
			enabled = *sc.Enabled
		}
		cfg.Services = append(cfg.Services, ServiceDep{Type: svc, Enabled: enabled})
	}
	return cfg, true
}

// ServiceOrder returns the [services.<type>] section names in file order so the
// resolved config preserves TOML declaration order (matching Python's
// insertion-ordered dict).
func ServiceOrder(content string) []string {
	var out []string
	seen := map[string]bool{}
	for _, line := range strings.Split(content, "\n") {
		l := strings.TrimSpace(line)
		if !strings.HasPrefix(l, "[services.") {
			continue
		}
		l = strings.TrimSuffix(strings.TrimPrefix(l, "[services."), "]")
		l = strings.TrimSpace(l)
		// Strip a possible trailing "]" left by nested tables; take the head.
		if i := strings.IndexAny(l, ".]"); i >= 0 {
			l = l[:i]
		}
		l = strings.Trim(l, `"`)
		if l != "" && !seen[l] {
			seen[l] = true
			out = append(out, l)
		}
	}
	return out
}

func ReadAutomationConfig(sourceDir string) AutomationConfig {
	tomlPath := filepath.Join(sourceDir, "automation.toml")
	data, err := os.ReadFile(tomlPath)
	if err != nil {
		return DefaultAutomationConfig()
	}
	cfg, ok := ParseAutomationTOML(string(data))
	if !ok {
		return DefaultAutomationConfig()
	}
	return cfg
}

func FirstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// ---- BP database registry ----

type BPRegistry struct {
	Version int                   `json:"version"`
	BPs     map[string]BPRegEntry `json:"bps"`
}

type BPRegEntry struct {
	BPName string                     `json:"bp_name"`
	Stages map[string]json.RawMessage `json:"stages"`
}

// LoadRegistry reads <secrets>/bp-databases.json (bp_databases.load_registry).
// A missing registry is an empty registry; an unreadable one degrades to empty
// for env-injection purposes (the Python warns and continues).
func LoadRegistry(secretsDir string) BPRegistry {
	empty := BPRegistry{Version: 1, BPs: map[string]BPRegEntry{}}
	path := filepath.Join(secretsDir, "bp-databases.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return empty
	}
	var reg BPRegistry
	if err := json.Unmarshal(data, &reg); err != nil {
		return empty
	}
	if reg.BPs == nil {
		reg.BPs = map[string]BPRegEntry{}
	}
	return reg
}

// IsRegistered reports whether bp×realm is in the registry (bp_databases.is_registered).
func (r BPRegistry) IsRegistered(bpSlug, realm string) bool {
	e, ok := r.BPs[bpSlug]
	if !ok {
		return false
	}
	_, ok = e.Stages[realm]
	return ok
}
