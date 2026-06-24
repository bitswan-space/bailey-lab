package dockerdriver

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
	yaml "gopkg.in/yaml.v3"
)

// compileState carries the workspace/environment context the compiler needs.
// It mirrors the AutomationService instance fields generate_docker_compose
// reads (workspace_name, gitops_dir, gitops_dir_host, secrets_dir, domain,
// certs_dir_host) plus the os.environ values the function consults.
type compileState struct {
	workspaceName string
	gitopsDir     string // container path: bitswan.yaml + <checksum>/ trees + secrets/
	gitopsDirHost string // host path used for bind-mount strings
	workspaceDir  string // host path for live-dev binds (workspace/)
	workspaceRepo string // path automation.toml is read from for live-dev/image-baked
	secretsDir    string
	domain        string
	certsDirHost  string

	keycloakURL  string
	orgGroupPath string
	volumeName   string // BITSWAN_VOLUME_NAME
	gatewayImage string // BITSWAN_EGRESS_GATEWAY_IMAGE
	deployTime   string // stamped into BITSWAN_DEPLOY_TIME (UTC isoformat + "Z")
	firewallDir  string // <gitops_dir>/firewall (created when a gateway is active)

	bs               *Bitswan
	registry         bpRegistry
	externalNetworks map[string]bool
	volumes          map[string]interface{}
}

func (c *compileState) stageNetwork(realm string) string {
	return c.workspaceName + "-" + realm
}

// Apply is the bitswan.yaml compiler + reconciler. It parses the declaration,
// generates the docker-compose project + stage networks + ingress routes, brings
// it up, installs CA certs + oauth2 sidecars, and returns the routes. Invoked by
// the git post-receive hook (see infradriver/README.md), so prog writes to the
// hook's stdout, which git relays to the pushing client.
//
// Port of gitops automation_service.generate_docker_compose +
// apply_compose_for_deployments.
func (d *DockerDriver) Apply(ctx context.Context, req infradriver.ApplyRequest, prog func(infradriver.Progress)) ([]infradriver.Route, error) {
	report := func(step, msg string) {
		if prog != nil {
			prog(infradriver.Progress{Step: step, Message: msg})
		}
	}

	bs, err := parseBitswanYAML([]byte(req.BitswanYAML))
	if err != nil {
		return nil, err
	}

	report("compile", "Compiling bitswan.yaml to docker-compose...")
	composeYAML, routes, _, err := compile(req.Ctx, bs)
	if err != nil {
		return nil, fmt.Errorf("compile bitswan.yaml: %w", err)
	}

	if err := reconcile(ctx, req.Ctx, bs, composeYAML, routes, report); err != nil {
		return nil, err
	}
	return routes, nil
}

// newCompileState builds the compiler context from the WorkspaceContext and the
// process environment (the same os.environ keys gitops reads).
func newCompileState(wctx infradriver.WorkspaceContext, bs *Bitswan) *compileState {
	c := &compileState{
		workspaceName: wctx.WorkspaceName,
		gitopsDir:     wctx.GitopsDir,
		gitopsDirHost: envOr("BITSWAN_GITOPS_DIR_HOST", wctx.GitopsDir),
		workspaceDir:  envOr("BITSWAN_WORKSPACE_DIR_HOST", filepath.Join(wctx.GitopsDir, "..", "workspace")),
		workspaceRepo: envOr("BITSWAN_WORKSPACE_REPO_DIR", "/workspace-repo"),
		secretsDir:    wctx.SecretsDir,
		domain:        wctx.Domain,
		certsDirHost:  os.Getenv("BITSWAN_CERTS_DIR"),
		keycloakURL:   os.Getenv("KEYCLOAK_URL"),
		orgGroupPath:  os.Getenv("BITSWAN_ALLOWED_GROUP"),
		volumeName:    os.Getenv("BITSWAN_VOLUME_NAME"),
		gatewayImage:  envOr("BITSWAN_EGRESS_GATEWAY_IMAGE", "bitswan/egress-gateway:latest"),
		deployTime:    time.Now().UTC().Format("2006-01-02T15:04:05.000000") + "Z",

		bs:               bs,
		registry:         loadRegistry(wctx.SecretsDir),
		externalNetworks: map[string]bool{"bitswan_network": true},
		volumes:          map[string]interface{}{},
	}
	if c.secretsDir == "" {
		c.secretsDir = filepath.Join(c.gitopsDir, "secrets")
	}
	c.firewallDir = filepath.Join(c.gitopsDir, "firewall")
	return c
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// compile is the faithful port of automation_service.generate_docker_compose:
// PURE generation (no docker daemon side effects), but it reads automation.toml
// from disk and (re)materializes per-BP secret env files just like the Python.
// Returns the compose YAML, the desired ingress routes, and the merged infra
// service names.
func compile(wctx infradriver.WorkspaceContext, bs *Bitswan) (composeYAML string, routes []infradriver.Route, infraServices []string, err error) {
	c := newCompileState(wctx, bs)

	services := map[string]interface{}{}
	deployments := bs.Deployments
	if deployments == nil {
		deployments = map[string]*Deployment{}
	}

	fwScope := c.computeFirewallScope(deployments)
	workerHosts := c.computeWorkerHosts(deployments, fwScope)

	for _, depID := range sortedDepIDs(deployments) {
		conf := deployments[depID]
		if conf == nil {
			conf = &Deployment{}
			deployments[depID] = conf
		}
		for _, sd := range c.slotDBPairs(conf) {
			entry, serviceName, route, emit, derr := c.buildServiceEntry(depID, conf, sd.slot, sd.db, workerHosts, fwScope)
			if derr != nil {
				return "", nil, nil, derr
			}
			if route != nil {
				routes = append(routes, *route)
			}
			if emit {
				services[serviceName] = entry
			}
		}
	}

	if err := c.emitGateways(services, fwScope); err != nil {
		return "", nil, nil, err
	}

	infraServices = mergeInfraServices(c, services, deployments)

	dc := map[string]interface{}{
		"version":  "3",
		"services": services,
	}
	nets := map[string]interface{}{}
	for net := range c.externalNetworks {
		if net == "bitswan_external_testing" {
			nets[net] = map[string]interface{}{"driver": "bridge"}
		} else {
			nets[net] = map[string]interface{}{"external": true}
		}
	}
	dc["networks"] = nets

	if c.volumeName != "" {
		c.volumes[c.volumeName] = map[string]interface{}{"external": true}
	}
	if len(c.volumes) > 0 {
		dc["volumes"] = c.volumes
	}

	out, merr := yaml.Marshal(dc)
	if merr != nil {
		return "", nil, nil, merr
	}
	return string(out), routes, infraServices, nil
}

type slotDB struct {
	slot string // "" for single-backend (Python None)
	db   int    // 0 for single-backend (Python None)
}

// slotDBPairs ports _slot_db_pairs.
func (c *compileState) slotDBPairs(conf *Deployment) []slotDB {
	if conf.StageOrProduction() != "production" {
		return []slotDB{{"", 0}}
	}
	bpSlug, _ := deriveBPAndCopy(conf.RelativePath)
	if bpSlug == "" {
		return []slotDB{{"", 0}}
	}
	rec := c.backupRec(bpSlug)
	slots := c.slotsFor(rec)
	var pairs []slotDB
	for _, s := range appSlots {
		if sr, ok := slots[s]; ok && sr != nil && sr.DB != nil {
			pairs = append(pairs, slotDB{s, *sr.DB})
		}
	}
	if len(pairs) == 0 {
		return []slotDB{{"", 0}}
	}
	return pairs
}

func (c *compileState) backupRec(bpSlug string) *BackupRec {
	if c.bs.Backups == nil {
		return nil
	}
	return c.bs.Backups[bpSlug]
}

func (c *compileState) slotsFor(rec *BackupRec) map[string]*SlotRec {
	if rec != nil && len(rec.Slots) > 0 {
		return rec.Slots
	}
	one, two := 1, 2
	return map[string]*SlotRec{"a": {DB: &one}, "b": {DB: &two}}
}

// liveSlotFor ports _live_slot_for.
func (c *compileState) liveSlotFor(conf *Deployment) string {
	bpSlug, _ := deriveBPAndCopy(conf.RelativePath)
	rec := c.backupRec(bpSlug)
	if rec != nil && rec.LiveSlot != "" {
		return rec.LiveSlot
	}
	slots := c.slotsFor(rec)
	liveDB := 1
	if rec != nil && rec.LiveDB != nil {
		liveDB = *rec.LiveDB
	}
	for _, s := range appSlots {
		if sr, ok := slots[s]; ok && sr != nil && sr.DB != nil && *sr.DB == liveDB {
			return s
		}
	}
	return "a"
}

// drSlotFor ports _dr_slot_for.
func (c *compileState) drSlotFor(conf *Deployment) string {
	bpSlug, _ := deriveBPAndCopy(conf.RelativePath)
	rec := c.backupRec(bpSlug)
	slots := c.slotsFor(rec)
	liveDB := 1
	if rec != nil && rec.LiveDB != nil {
		liveDB = *rec.LiveDB
	}
	standbyDB := 1
	if liveDB == 1 {
		standbyDB = 2
	}
	live := c.liveSlotFor(conf)
	for _, s := range appSlots {
		if sr, ok := slots[s]; ok && sr != nil && sr.DB != nil && *sr.DB == standbyDB && s != live {
			return s
		}
	}
	return ""
}

func sortedDepIDs(m map[string]*Deployment) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// workspaceRoute ports utils.workspace_route's (hostname, upstream) derivation.
func (c *compileState) workspaceRoute(automationName, depContext, depStage string, port int, upstreamSlot, hostStage string) infradriver.Route {
	hostname := makeHostnameLabel(c.workspaceName, automationName, depContext, hostStage, "") + "." + c.domain
	svcName := makeHostnameLabel(c.workspaceName, automationName, depContext, depStage, upstreamSlot)
	return infradriver.Route{
		Hostname: hostname,
		Upstream: fmt.Sprintf("%s:%d", svcName, port),
		Stage:    depStage,
		// Frontends inherit the workspace dashboard's Bailey ACL, so every
		// workspace member can share what they deploy (mirrors utils.workspace_route).
		ParentEndpoint: c.workspaceName + "-dashboard." + c.domain,
		Kind:           "frontend",
	}
}
