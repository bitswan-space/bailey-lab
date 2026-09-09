package dockerdriver

import "github.com/bitswan-space/bitswan-workspaces/internal/infradriver/core"

type (
	Bitswan          = core.Bitswan
	Deployment       = core.Deployment
	BackupRec        = core.BackupRec
	SlotRec          = core.SlotRec
	FirewallNode     = core.FirewallNode
	FirewallRule     = core.FirewallRule
	bpNode           = core.BPNode
	automationConfig = core.AutomationConfig
	serviceDep       = core.ServiceDep
	bpRegistry       = core.BPRegistry
	bpRegEntry       = core.BPRegEntry
)

const (
	maxNameLen          = core.MaxNameLen
	maxLabelLen         = core.MaxLabelLen
	defaultRuntimeImage = core.DefaultRuntimeImage
)

var (
	appSlots = core.AppSlots

	containedJoin   = core.ContainedJoin
	assertRealUnder = core.AssertRealUnder

	parseBitswanYAML = core.ParseBitswanYAML

	shortHash               = core.ShortHash
	sanitizeAutomationName  = core.SanitizeAutomationName
	makeHostnameLabel       = core.MakeHostnameLabel
	joinNonEmpty            = core.JoinNonEmpty
	truncate                = core.Truncate
	realmForStage           = core.RealmForStage
	stageForDeployment      = core.StageForDeployment
	postureFor              = core.PostureFor
	allowedHosts            = core.AllowedHosts
	firewallNode            = core.FirewallNodeFor
	deriveBPAndCopy         = core.DeriveBPAndCopy
	bpResourceNames         = core.BPResourceNames
	itoa                    = core.Itoa
	copyBPResourceNames     = core.CopyBPResourceNames
	defaultAutomationConfig = core.DefaultAutomationConfig
	parseAutomationTOML     = core.ParseAutomationTOML
	serviceOrder            = core.ServiceOrder
	readAutomationConfig    = core.ReadAutomationConfig
	firstNonEmpty           = core.FirstNonEmpty
	loadRegistry            = core.LoadRegistry
)
