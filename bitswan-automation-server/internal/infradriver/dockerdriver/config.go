package dockerdriver

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

// maxNameLen caps a workspace/automation name component (gitops
// automation_service.MAX_NAME_LEN = 24). maxLabelLen is the hard DNS label
// limit the FULL hostname must never exceed — see makeHostnameLabel, which caps
// the assembled label there while preserving the discriminating tail (context
// hash + stage + slot), since the color slot names are far longer than a/b/c.
const (
	maxNameLen  = 24
	maxLabelLen = 63
)

// appSlots is the blue-green app slot order (AutomationService.APP_SLOTS).
var appSlots = [3]string{"blue", "green", "purple"}

var (
	sanitizeRe = regexp.MustCompile(`[^a-z0-9-]`)
	copyDBRe   = regexp.MustCompile(`[^a-z0-9_]`)
)

// shortHash is the deterministic 4-char context hash (_short_hash).
func shortHash(context string) string {
	sum := sha256.Sum256([]byte(context))
	return hex.EncodeToString(sum[:])[:4]
}

// sanitizeAutomationName mirrors utils.sanitize_automation_name: lowercase,
// replace each char outside [a-z0-9-] with '-', trim leading/trailing hyphens.
func sanitizeAutomationName(name string) string {
	return strings.Trim(sanitizeRe.ReplaceAllString(strings.ToLower(name), "-"), "-")
}

// makeHostnameLabel builds a DNS hostname label from structured components
// (automation_service.make_hostname_label). slot ("blue"/"green") is appended as a
// trailing segment; pass "" for non-production.
func makeHostnameLabel(workspaceName, automationName, context, stage, slot string) string {
	ws := truncate(workspaceName, maxNameLen)
	an := truncate(automationName, maxNameLen)

	// Build the discriminating tail (context hash + stage + slot). These MUST
	// survive intact: the hash keeps distinct contexts distinct, the stage keeps
	// dev/staging/production/dr distinct, and the slot keeps blue/green/purple
	// distinct. Only the human-readable ws/an names are truncated to fit 63.
	tail := []string{}
	if context != "" {
		tail = append(tail, shortHash(context))
	}
	if stage != "" {
		tail = append(tail, stage)
	}
	if slot != "" {
		tail = append(tail, slot)
	}

	label := joinNonEmpty("-", ws, an, joinNonEmpty("-", tail...))
	if len(label) <= maxLabelLen {
		return label
	}

	// Over the limit (long workspace+automation names + a long slot name like
	// "purple"): shrink ws+an to the remaining budget, splitting it between them,
	// keeping the tail whole. Collisions would need the same ws/an prefixes AND
	// the same context hash — vanishingly unlikely.
	tailStr := joinNonEmpty("-", tail...)
	budget := maxLabelLen - len(tailStr) - 2 // 2 separators: ws-an-tail
	if budget < 2 {
		budget = 2
	}
	half := budget / 2
	ws = truncate(ws, half)
	an = truncate(an, budget-len(ws))
	return joinNonEmpty("-", ws, an, tailStr)
}

// joinNonEmpty joins the non-empty parts with sep.
func joinNonEmpty(sep string, parts ...string) string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, sep)
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// realmForStage maps a deployment stage to its secret realm (bp_secrets).
// live-dev/dev -> dev; ""/production -> production; else the stage itself.
func realmForStage(stage string) string {
	switch stage {
	case "live-dev", "dev":
		return "dev"
	case "", "production":
		return "production"
	default:
		return stage
	}
}

// stageForDeployment maps a deployment stage to its service realm
// (infra_service.stage_for_deployment): live-dev shares dev; else identity.
func stageForDeployment(stage string) string {
	if stage == "live-dev" {
		return "dev"
	}
	return stage
}

// postureFor reports the default firewall posture for a realm
// (firewall_service.posture_for): staging/production enforce, else monitor.
func postureFor(realm string) string {
	if realm == "staging" || realm == "production" {
		return "enforce"
	}
	return "monitor"
}

// allowedHosts returns the sorted allow-listed hostnames for a BP+realm
// (firewall_service.allowed_hosts): rules whose status == "allowed".
func allowedHosts(bs *Bitswan, bp, realm string) []string {
	node := firewallNode(bs, bp, realm)
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

func firewallNode(bs *Bitswan, bp, realm string) *FirewallNode {
	if bs.Firewall == nil {
		return nil
	}
	byRealm := bs.Firewall[bp]
	if byRealm == nil {
		return nil
	}
	return byRealm[realm]
}

// deriveBPAndCopy derives (bp_slug, copy_name) from a relative_path
// (bp_databases.derive_bp_and_copy). relative_path looks like
// "copies/<copy>/<bp>/<rel>"; the main copy yields an empty copy context.
func deriveBPAndCopy(relativePath string) (bpSlug, copyName string) {
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
		bpSlug = sanitizeAutomationName(bpName)
	}
	return bpSlug, copyName
}

// bpResourceNames returns the stage-independent per-BP resource names
// (bp_databases.bp_resource_names). db (1/2) selects a blue-green logical DB;
// db==0 means the single-backend scheme (Python db=None).
func bpResourceNames(bpSlug string, db int) map[string]string {
	if db != 0 {
		pg := truncate("bp_"+strings.ReplaceAll(bpSlug, "-", "_"), 61) + "_" + itoa(db)
		bucket := strings.TrimRight(truncate("bp-"+bpSlug, 61), "-") + "-" + itoa(db)
		couch := "bp-" + bpSlug + "-" + itoa(db) + "-"
		return map[string]string{"postgres_db": pg, "couchdb_prefix": couch, "minio_bucket": bucket}
	}
	pg := truncate("bp_"+strings.ReplaceAll(bpSlug, "-", "_"), 63)
	bucket := strings.TrimRight(truncate("bp-"+bpSlug, 63), "-")
	couch := "bp-" + bpSlug + "-"
	return map[string]string{"postgres_db": pg, "couchdb_prefix": couch, "minio_bucket": bucket}
}

func itoa(n int) string {
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

// copyBPResourceNames returns the per-(copy, BP) live-dev resource names. A
// non-main copy is a developer's sandbox: each BP's live-dev backend gets its
// OWN Postgres database, MinIO bucket and CouchDB prefix there — isolated from
// other BPs in the copy, from other copies, and from dev. Capped at the 63-byte
// Postgres/MinIO limit (a truncation collision surfaces as a deploy error, not
// silent data sharing). Mirrors bp_databases.copy_bp_resource_names.
func copyBPResourceNames(copyName, bpSlug string) map[string]string {
	cpU := copyDBRe.ReplaceAllString(strings.ToLower(copyName), "_") // [a-z0-9_] for pg
	cpD := sanitizeAutomationName(copyName)                          // [a-z0-9-] for minio/couch
	bpU := strings.ReplaceAll(bpSlug, "-", "_")
	pg := truncate("copy_"+cpU+"_bp_"+bpU, maxLabelLen)
	bucket := strings.TrimRight(truncate("copy-"+cpD+"-bp-"+bpSlug, maxLabelLen), "-")
	couch := "copy-" + cpD + "-bp-" + bpSlug + "-"
	return map[string]string{"postgres_db": pg, "couchdb_prefix": couch, "minio_bucket": bucket}
}

// ---- automation.toml ----

// automationConfig is the resolved automation.toml config (utils.AutomationConfig).
// Services preserves TOML declaration order — env_file injection order is
// observable in the generated compose, so it must match the Python (which
// iterates the toml dict in file order).
type automationConfig struct {
	Image              string
	Expose             bool
	Port               int
	MountPath          string
	ExternalTestingNet bool
	Services           []serviceDep
}

// serviceDep is one [services.<type>] dependency, in declaration order.
type serviceDep struct {
	Type    string
	Enabled bool
}

// hasServices reports whether the automation declares any [services.*] deps.
func (c automationConfig) hasServices() bool { return len(c.Services) > 0 }

const defaultRuntimeImage = "bitswan/pipeline-runtime-environment:latest"

func defaultAutomationConfig() automationConfig {
	return automationConfig{Image: defaultRuntimeImage, Expose: false, Port: 8080, MountPath: "/app/"}
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

// parseAutomationTOML parses automation.toml content (utils.parse_automation_toml).
func parseAutomationTOML(content string) (automationConfig, bool) {
	if strings.TrimSpace(content) == "" {
		return automationConfig{}, false
	}
	var t tomlAutomation
	if _, err := toml.Decode(content, &t); err != nil {
		// Python raises ValueError on syntax error; the compiler treats an
		// unreadable toml as "no config" rather than failing the whole apply.
		return automationConfig{}, false
	}
	cfg := automationConfig{
		Image:              firstNonEmpty(t.Deployment.Image, defaultRuntimeImage),
		Expose:             t.Deployment.Expose,
		Port:               t.Deployment.Port,
		MountPath:          "/app/",
		ExternalTestingNet: t.Deployment.ExternalTestingNet,
	}
	if cfg.Port == 0 {
		cfg.Port = 8080
	}
	for _, svc := range serviceOrder(content) {
		sc, ok := t.Services[svc]
		if !ok {
			continue
		}
		enabled := true
		if sc.Enabled != nil {
			enabled = *sc.Enabled
		}
		cfg.Services = append(cfg.Services, serviceDep{Type: svc, Enabled: enabled})
	}
	return cfg, true
}

// serviceOrder returns the [services.<type>] section names in file order so the
// resolved config preserves TOML declaration order (matching Python's
// insertion-ordered dict).
func serviceOrder(content string) []string {
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

func readAutomationConfig(sourceDir string) automationConfig {
	tomlPath := filepath.Join(sourceDir, "automation.toml")
	data, err := os.ReadFile(tomlPath)
	if err != nil {
		return defaultAutomationConfig()
	}
	cfg, ok := parseAutomationTOML(string(data))
	if !ok {
		return defaultAutomationConfig()
	}
	return cfg
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// ---- BP database registry ----

type bpRegistry struct {
	Version int                   `json:"version"`
	BPs     map[string]bpRegEntry `json:"bps"`
}

type bpRegEntry struct {
	BPName string                     `json:"bp_name"`
	Stages map[string]json.RawMessage `json:"stages"`
}

// loadRegistry reads <secrets>/bp-databases.json (bp_databases.load_registry).
// A missing registry is an empty registry; an unreadable one degrades to empty
// for env-injection purposes (the Python warns and continues).
func loadRegistry(secretsDir string) bpRegistry {
	empty := bpRegistry{Version: 1, BPs: map[string]bpRegEntry{}}
	path := filepath.Join(secretsDir, "bp-databases.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return empty
	}
	var reg bpRegistry
	if err := json.Unmarshal(data, &reg); err != nil {
		return empty
	}
	if reg.BPs == nil {
		reg.BPs = map[string]bpRegEntry{}
	}
	return reg
}

// isRegistered reports whether bp×realm is in the registry (bp_databases.is_registered).
func (r bpRegistry) isRegistered(bpSlug, realm string) bool {
	e, ok := r.BPs[bpSlug]
	if !ok {
		return false
	}
	_, ok = e.Stages[realm]
	return ok
}
