package dockerdriver

import (
	"fmt"

	yaml "gopkg.in/yaml.v3"
)

// Bitswan is the parsed bitswan.yaml a workspace ships. It mirrors the subset of
// the schema the compiler consumes. The file on disk may be in either the flat
// `deployments` form or the tree `business_processes` form; parseBitswanYAML
// hydrates the flat view from the tree exactly like gitops's read_bitswan_yaml
// (utils._tree_to_flat), so the compiler always operates on Deployments.
type Bitswan struct {
	// Deployments is the flat {deployment_id: conf} map. When the file uses the
	// tree form it is hydrated from BusinessProcesses (see hydrate).
	Deployments map[string]*Deployment `yaml:"deployments"`

	// BusinessProcesses is the on-disk tree form: bp -> stage -> node.
	BusinessProcesses map[string]map[string]*bpNode `yaml:"business_processes"`

	// Backups carries blue-green slot/db wiring per BP slug.
	Backups map[string]*BackupRec `yaml:"backups"`

	// Secrets[bp][realm] is the AES-GCM ciphertext blob for a BP+realm.
	Secrets map[string]map[string]string `yaml:"secrets"`

	// Firewall[bp][realm] is the egress firewall node (posture + rules).
	Firewall map[string]map[string]*FirewallNode `yaml:"firewall"`

	// DefaultNetworks is an optional top-level network override list.
	DefaultNetworks []string `yaml:"default-networks"`
}

// bpNode is one stage node in the business_processes tree.
type bpNode struct {
	Deployments map[string]*Deployment `yaml:"deployments"`
}

// Deployment is one deployment's conf. Only the fields the compiler reads are
// modelled; everything else (image_id, source_commit, deployed_by, …) is
// ignored. The slice/map extras keep their YAML shape so they pass through
// untouched into the generated compose (Python's `passthroughs`).
type Deployment struct {
	Enabled        *bool                  `yaml:"enabled"`
	AutomationName string                 `yaml:"automation_name"`
	Context        string                 `yaml:"context"`
	Stage          string                 `yaml:"stage"`
	Checksum       string                 `yaml:"checksum"`
	Source         string                 `yaml:"source"`
	RelativePath   string                 `yaml:"relative_path"`
	Image          string                 `yaml:"image"`
	TagChecksum    string                 `yaml:"tag_checksum"`
	Replicas       *int                   `yaml:"replicas"`
	DeploymentCtx  string                 `yaml:"deployment_context"`
	Services       map[string]interface{} `yaml:"services"`
	// NOTE: network_mode / networks / volumes / ports / devices / container_name
	// are intentionally NOT fields here. The driver is a constraining compiler,
	// not a compose passthrough — a deployment record must not be able to inject
	// host bind-mounts, host networking, or attach to bitswan_network. Any such
	// keys in a pushed bitswan.yaml are silently ignored (no field to bind to).

	// stageSet records whether this deployment came in via the flat form (where
	// `stage` is explicit) versus the tree form (where it is derived). Used only
	// to mirror the Python stage-defaulting precisely.
	stageSet bool `yaml:"-"`
}

// BackupRec is the per-BP blue-green wiring.
type BackupRec struct {
	Slots    map[string]*SlotRec `yaml:"slots"`
	LiveDB   *int                `yaml:"live_db"`
	LiveSlot string              `yaml:"live_slot"`
}

// SlotRec is one app slot's logical DB binding.
type SlotRec struct {
	DB *int `yaml:"db"`
}

// FirewallNode is a BP+realm egress firewall rule set.
type FirewallNode struct {
	Posture string                   `yaml:"posture"`
	Rules   map[string]*FirewallRule `yaml:"rules"`
}

// FirewallRule is one host's allow/deny decision.
type FirewallRule struct {
	Status string `yaml:"status"`
}

// EnabledOrDefault reports conf.get("enabled", True).
func (d *Deployment) EnabledOrDefault() bool {
	if d.Enabled == nil {
		return true
	}
	return *d.Enabled
}

// ReplicasOrOne reports conf.get("replicas", 1).
func (d *Deployment) ReplicasOrOne() int {
	if d.Replicas == nil {
		return 1
	}
	return *d.Replicas
}

// StageOrProduction reports conf.get("stage", "production") or "production":
// a missing OR empty stage is "production".
func (d *Deployment) StageOrProduction() string {
	if d.Stage == "" {
		return "production"
	}
	return d.Stage
}

// AutomationNameOr reports conf.get("automation_name", deployment_id).
func (d *Deployment) AutomationNameOr(depID string) string {
	if d.AutomationName == "" {
		return depID
	}
	return d.AutomationName
}

// parseBitswanYAML parses bitswan.yaml bytes into a Bitswan, hydrating the flat
// deployments view from the business_processes tree when present (mirrors
// gitops utils.read_bitswan_yaml + _tree_to_flat). Deterministic: the flat view
// is what generate_docker_compose consumes.
func parseBitswanYAML(data []byte) (*Bitswan, error) {
	var bs Bitswan
	if err := yaml.Unmarshal(data, &bs); err != nil {
		return nil, fmt.Errorf("parse bitswan.yaml: %w", err)
	}
	bs.hydrate()
	return &bs, nil
}

// hydrate fills Deployments from BusinessProcesses when the tree form is used,
// matching _tree_to_flat: context defaults to the BP key, stage defaults to ""
// for the "production" tree node else the node's stage key.
func (bs *Bitswan) hydrate() {
	for _, d := range bs.Deployments {
		if d != nil {
			d.stageSet = true
		}
	}
	if len(bs.BusinessProcesses) == 0 {
		return
	}
	if bs.Deployments == nil {
		bs.Deployments = map[string]*Deployment{}
	}
	for bp, stages := range bs.BusinessProcesses {
		for stage, node := range stages {
			if node == nil {
				continue
			}
			for depID, conf := range node.Deployments {
				if conf == nil {
					conf = &Deployment{}
				}
				if conf.Context == "" {
					conf.Context = bp
				}
				if !conf.stageSet && conf.Stage == "" {
					if stage != "production" {
						conf.Stage = stage
					}
				}
				bs.Deployments[depID] = conf
			}
		}
	}
}
