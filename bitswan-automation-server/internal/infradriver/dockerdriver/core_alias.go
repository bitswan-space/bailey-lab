package dockerdriver

import (
	"context"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver/core"
)

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
	containerInfo    = core.ContainerInfo
)

const (
	maxNameLen          = core.MaxNameLen
	maxLabelLen         = core.MaxLabelLen
	defaultRuntimeImage = core.DefaultRuntimeImage
)

var (
	appSlots = core.AppSlots

	ownForGitops    = core.OwnForGitops
	containedJoin   = core.ContainedJoin
	assertRealUnder = core.AssertRealUnder

	parseBitswanYAML = core.ParseBitswanYAML
	sortedDepIDs     = core.SortedDepIDs

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
	reconcileIngress        = core.ReconcileIngress
)

type dockerExecer struct{}

func (dockerExecer) Exec(ctx context.Context, container string, args ...string) (string, string, int) {
	return dockerExec(ctx, container, args...)
}

func (dockerExecer) Running(ctx context.Context, container string) bool {
	return containerRunning(ctx, container)
}

func (dockerExecer) WaitReady(ctx context.Context, container string, timeout time.Duration) error {
	return waitForHealthy(ctx, container, timeout)
}

var dockerX core.Execer = dockerExecer{}

var (
	serviceContainerName  = core.ServiceContainerName
	serviceSecrets        = core.ServiceSecrets
	getOrCreateDBCreds    = core.GetOrCreateDBCreds
	dbCredsPath           = core.DbCredsPath
	bucketCredsPath       = core.BucketCredsPath
	ensureBucketCredsFile = core.EnsureBucketCredsFile
	systemKeyName         = core.SystemKeyName
	productionDBNumbers   = core.ProductionDBNumbers
	scopedPGRole          = core.ScopedPGRole
	scopedROPGRole        = core.ScopedROPGRole
	readEnvFile           = core.ReadEnvFile
	readBucketCreds       = core.ReadBucketCreds
	bpSecretEnvFilePath   = core.BPSecretEnvFilePath
	decryptSecrets        = core.DecryptSecrets
	materializeEnv        = core.MaterializeEnv
	secretsContentHash    = core.SecretsContentHash
	writeBucketCreds      = core.WriteBucketCreds
)

func ensureBPRole(ctx context.Context, container, adminUser, secretsDir, realm, dbName string) error {
	return core.EnsureBPRole(dockerX, ctx, container, adminUser, secretsDir, realm, dbName)
}

func ensureLivePostgresDBs(ctx context.Context, wctx infradriver.WorkspaceContext, bs *Bitswan, preExistingIDs map[string]bool, infos []core.ContainerInfo, report func(step, msg string)) error {
	return core.EnsureLivePostgresDBs(dockerX, ctx, wctx, bs, preExistingIDs, infos, report)
}

func ensureGarageKeysPrecompile(ctx context.Context, wctx infradriver.WorkspaceContext, bs *Bitswan, report func(step, msg string)) {
	core.EnsureGarageKeysPrecompile(dockerX, ctx, wctx, bs, report)
}

func provisionForDeployments(ctx context.Context, wctx infradriver.WorkspaceContext, bs *Bitswan, report func(step, msg string)) []string {
	return core.ProvisionForDeployments(dockerX, ctx, wctx, bs, report)
}

func reconcileGarageBuckets(ctx context.Context, wctx infradriver.WorkspaceContext, realm string, want map[string]bool, report func(step, msg string)) []string {
	return core.ReconcileGarageBuckets(dockerX, ctx, wctx, realm, want, report)
}
