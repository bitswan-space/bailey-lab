package k8sdriver

import (
	"context"
	"fmt"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver/core"
	"github.com/bitswan-space/bitswan-workspaces/internal/k8sctl"
	"github.com/bitswan-space/bitswan-workspaces/internal/k8srender"
)

// apply compiles the declaration into objects, applies them, and hands the
// resulting routes to the daemon.
//
// The order matters and is the same order the Docker driver reconciles in: the
// things a workload reads must exist before it starts, the infra a business
// process depends on comes up before the process, and the ingress is converged
// last so nothing is routed at a workload that is not there yet.
func (d *K8sDriver) apply(ctx context.Context, req infradriver.ApplyRequest, report func(step, msg string)) ([]infradriver.Route, error) {
	report("compile", "compiling bitswan.yaml")
	bs, err := core.ParseBitswanYAML([]byte(req.BitswanYAML))
	if err != nil {
		return nil, fmt.Errorf("parse bitswan.yaml: %w", err)
	}

	// Garage mints its access keys server-side, so they are ensured before the
	// compile that bakes them into a workload's environment. On the first apply
	// Garage is not up yet; the compiler writes the placeholder and the
	// post-apply pass mints for real, exactly as the Docker driver does.
	x := execer{d: d}
	report("provision", "Ensuring Garage access keys for scoped backends...")
	core.EnsureGarageKeysPrecompile(x, ctx, req.Ctx, bs, report)

	c := &compileState{
		driver:    d,
		ctx:       req.Ctx,
		bs:        bs,
		workspace: d.workspace,
		domain:    req.Ctx.Domain,
	}
	objs, routes, err := c.compile()
	if err != nil {
		return nil, err
	}
	if len(objs) == 0 {
		report("apply", "nothing declared for this business process")
	} else {
		report("apply", fmt.Sprintf("applying %d object(s)", len(objs)))
		if err := k8sctl.Apply(ctx, objs); err != nil {
			return nil, err
		}
	}

	// What a promotion retires has to actually go away, or the old slot keeps
	// serving beside the new one. The Docker driver gets this from
	// --remove-orphans; here it is an explicit sweep, scoped to this business
	// process so a deploy of one cannot reap a sibling's.
	// Scoped twice over: to this business process, and to the stages this
	// declaration actually describes. A push that carries only production must
	// not reap a live-dev session the author is in the middle of — "absent from
	// this file" and "retired" are different things, and only the second is a
	// reason to delete something.
	if req.Ctx.BP != "" {
		base := k8srender.WorkspaceLabel + "=" + k8srender.LabelValue(d.workspace) +
			",gitops.bp=" + k8srender.LabelValue(req.Ctx.BP)
		keep := appliedNames(objs)
		for _, stage := range stagesIn(objs) {
			selector := base + ",gitops.stage=" + k8srender.LabelValue(stage)
			if err := k8sctl.PruneRetired(ctx, selector, keep); err != nil {
				return nil, fmt.Errorf("prune retired workloads: %w", err)
			}
		}
	}

	// The database a backend connects to has to exist before the backend gives
	// up retrying, and the bucket and the standby database have to exist before
	// a snapshot or a promotion needs them. This is the same provisioning the
	// Docker driver runs post-up, against the same declaration, differing only
	// in how a command reaches a container.
	if len(objs) > 0 {
		report("provision", "Ensuring live databases for (re)created backends...")
		if err := core.EnsureLivePostgresDBs(x, ctx, req.Ctx, bs, nil, runningInfos(ctx, d), report); err != nil {
			return nil, fmt.Errorf("ensure live postgres dbs: %w", err)
		}
		report("provision", "Provisioning per-BP namespaces...")
		core.ProvisionForDeployments(x, ctx, req.Ctx, bs, report)
	}

	// Nothing is routed at a workload that is not serving yet. A Service with no
	// ready endpoints is a 502, and on a promotion that 502 is production: the
	// whole point of running both slots is that the cutover happens after the
	// new one answers, not before.
	if len(routes) > 0 {
		report("wait", fmt.Sprintf("waiting for %d routed workload(s)", len(routes)))
		if err := waitForRouted(ctx, objs, routes, report); err != nil {
			return nil, err
		}
	}

	report("ingress", fmt.Sprintf("converging %d route(s)", len(routes)))
	if err := core.ReconcileIngress(ctx, d.workspace, req.Ctx.BP, routes); err != nil {
		return nil, fmt.Errorf("ingress reconcile: %w", err)
	}
	return routes, nil
}

type compileState struct {
	driver    *K8sDriver
	ctx       infradriver.WorkspaceContext
	bs        *core.Bitswan
	workspace string
	domain    string
	fw        map[fwKey]*fwGroup
}

// compile turns the declaration into the objects that realize it.
func (c *compileState) compile() (k8srender.ObjectSet, []infradriver.Route, error) {
	var objs k8srender.ObjectSet
	var routes []infradriver.Route

	// Decided before any workload is rendered, because a workload in a
	// firewalled group carries the rule installer that points at its proxy.
	c.fw = c.firewallScope()

	// Infra a business process asks for, once per stage rather than once per
	// process: two processes on the same stage share one Postgres and one
	// object store, each with its own database and bucket, exactly as they do on
	// Docker.
	realms := map[string]map[string]bool{}

	depIDs := make([]string, 0, len(c.bs.Deployments))
	for id := range c.bs.Deployments {
		depIDs = append(depIDs, id)
	}
	sort.Strings(depIDs)

	for _, id := range depIDs {
		conf := c.bs.Deployments[id]
		if conf == nil || !conf.EnabledOrDefault() {
			continue
		}
		if c.ctx.BP != "" {
			bp, _ := core.DeriveBPAndCopy(conf.RelativePath)
			if bp != c.ctx.BP && conf.Context != c.ctx.BP {
				continue
			}
		}
		stage := conf.StageOrProduction()
		realm := core.RealmForStage(stage)

		// Production is blue/green: one workload per slot, both running, only
		// one routed. A promote pins the new version onto the idle slot and the
		// ingress flip is what cuts over — so both have to exist at once.
		for _, sd := range core.SlotDBPairs(c.bs, conf) {
			slotConf := core.EffectiveSlotConf(id, conf, sd.Slot, c.bs.Deployments)
			w, extra, route, emit, err := c.workload(id, slotConf, sd.Slot, sd.DB)
			if err != nil {
				return nil, nil, err
			}
			if !emit {
				continue
			}
			objs = append(objs, extra...)
			objs = append(objs, k8srender.Deployment(w)...)
			if route != nil {
				routes = append(routes, *route)
			}
		}

		for _, svc := range enabledServices(conf) {
			if realms[realm] == nil {
				realms[realm] = map[string]bool{}
			}
			realms[realm][svc] = true
		}
	}

	// Rendered after the workloads so the set reads in dependency order, but
	// prepended so it is APPLIED first: a workload that starts before its
	// database exists spends its first seconds crash-looping for no reason.
	var infra k8srender.ObjectSet
	for _, realm := range sortedKeys(realms) {
		for _, svc := range sortedBoolKeys(realms[realm]) {
			infra = append(infra, c.infraService(svc, realm)...)
		}
	}
	return append(append(infra, c.firewallObjects()...), objs...), routes, nil
}

// workload renders one automation. The bool reports whether it should be
// emitted at all: a live-dev deployment with nothing to run is skipped rather
// than being an error, exactly as the Docker compiler skips it.
func (c *compileState) workload(depID string, conf *core.Deployment, slot string, db int) (k8srender.Workload, k8srender.ObjectSet, *infradriver.Route, bool, error) {
	stage := conf.StageOrProduction()
	realm := core.RealmForStage(stage)
	automation := conf.AutomationNameOr(depID)
	bpSlug, copyName := core.DeriveBPAndCopy(conf.RelativePath)
	if bpSlug == "" {
		bpSlug = conf.Context
	}

	// The name a route points at. Derived exactly as the Docker driver derives a
	// container name, so an upstream written by either backend resolves.
	svcName := core.MakeHostnameLabel(c.workspace, automation, conf.Context, stage, slot)

	rel := conf.RelativePath
	source := core.FirstNonEmpty(core.FirstNonEmpty(conf.Source, conf.Checksum), depID)

	// CONTAINMENT (#134): the checksum and the relative path come from the
	// tenant-writable deployment record, and both end up as subPath values the
	// kubelet joins onto a volume root. A "../.." in either would mount
	// something else's directory into a tenant's pod, so the same lexical
	// containment the Docker compiler applies to its bind sources applies here.
	if _, err := core.ContainedJoin(c.ctx.GitopsDir, source); err != nil {
		return k8srender.Workload{}, nil, nil, false, fmt.Errorf("deployment %s: %w", depID, err)
	}
	if rel != "" {
		if _, err := core.ContainedJoin(c.workspaceRepo(), rel); err != nil {
			return k8srender.Workload{}, nil, nil, false, fmt.Errorf("deployment %s: %w", depID, err)
		}
	}

	cfg := c.resolveAutomationConfig(conf)

	switch {
	case stage == "live-dev" && cfg.Image == "":
		return k8srender.Workload{}, nil, nil, false, nil
	case stage == "live-dev" && rel == "":
		return k8srender.Workload{}, nil, nil, false, fmt.Errorf("live-dev deployment %s is missing relative_path", depID)
	}

	// The image, and where the code inside it comes from. Three cases, the same
	// three the Docker compiler has: live-dev runs a base image over the
	// author's working tree, a built deployment runs an image with the source
	// baked in, and anything else runs a base image over the checksum tree.
	//
	// Only the baked one is a registry reference: a build here is a push, so the
	// tag bitswan.yaml records is a name in the namespace's registry, while the
	// base images are published ones the kubelet already knows how to find.
	image := cfg.Image
	var mounts []k8srender.Mount
	switch {
	case stage == "live-dev":
		mounts = append(mounts, k8srender.Mount{
			Path:     cfg.MountPath,
			SubPath:  c.volumeSubPath(rel),
			ReadOnly: true,
		})
	case conf.Image != "":
		image = registryRef(conf.Image)
	default:
		mounts = append(mounts, k8srender.Mount{
			Path:     cfg.MountPath,
			SubPath:  c.volumeSubPath("gitops/" + source),
			ReadOnly: true,
		})
	}
	if image == "" {
		return k8srender.Workload{}, nil, nil, false, fmt.Errorf("deployment %s has no image to run", depID)
	}
	if len(mounts) > 0 && c.volumeClaim() == "" {
		return k8srender.Workload{}, nil, nil, false, fmt.Errorf(
			"deployment %s needs its source mounted but no workspace volume claim is configured", depID)
	}

	port := cfg.Port
	if port == 0 {
		port = 8080
	}

	slotDepID := depID
	if slot != "" {
		slotDepID = depID + "@" + slot
	}
	env := map[string]string{
		"DEPLOYMENT_ID":            slotDepID,
		"BITSWAN_DEPLOYMENT_ID":    slotDepID,
		"BITSWAN_AUTOMATION_STAGE": stage,
		"BITSWAN_WORKSPACE_NAME":   c.workspace,
		"BITSWAN_GITOPS_DOMAIN":    c.domain,
		"BITSWAN_DEPLOY_CHECKSUM":  conf.Checksum,
		"PORT":                     strconv.Itoa(port),
	}
	if cfg.Expose {
		env["BITSWAN_AUTOMATION_URL"] = "https://" +
			core.MakeHostnameLabel(c.workspace, automation, conf.Context, stage, "") + "." + c.domain
	}

	// What the Docker driver hands a worker as a peer address is the firewall
	// gateway it shares a network namespace with. Nothing shares a namespace
	// here, so a peer is its own Service — which is also why a worker can be
	// replicated on Kubernetes and cannot on Docker.
	env["BITSWAN_WORKER_HOSTS"] = c.workerHosts(conf, bpSlug, stage, slot)

	// What this process authenticates as, and where it finds what it talks to.
	resources := c.resourceNames(bpSlug, copyName, stage, db)
	for envName, key := range map[string]string{
		"POSTGRES_DB":       "postgres_db",
		"COUCHDB_DB_PREFIX": "couchdb_prefix",
		"S3_BUCKET":         "s3_bucket",
	} {
		if v := resources[key]; v != "" {
			env[envName] = v
		}
	}
	secretContent, inline := c.credentials(conf, cfg, bpSlug, stage, resources)
	for k, v := range inline {
		env[k] = v
	}
	secretName, extra := credentialSecret(svcName, secretContent)
	var envFrom []string
	if secretName != "" {
		envFrom = append(envFrom, secretName)
	}

	w := k8srender.Workload{
		Name:          svcName,
		ContainerName: svcName,
		Workspace:     c.workspace,
		Image:         image,
		PullPolicy:    builtImagePullPolicy(),
		VolumeClaim:   c.volumeClaim(),
		Mounts:        mounts,
		Replicas:      conf.ReplicasOrOne(),
		Env:           env,
		EnvFrom:       envFrom,
		Ports:         []k8srender.Port{{Name: "app", Port: port}},
		Labels: map[string]string{
			"gitops.automation_name": automation,
			"gitops.context":         conf.Context,
			"gitops.bp":              bpSlug,
			"gitops.stage":           stage,
			"gitops.realm":           realm,
			"gitops.slot":            slot,
		},
		Annotations: map[string]string{
			// The raw values, because a label cannot hold all of them: an
			// identifier carries an "@" once a slot is involved, and a content
			// hash is a character over the limit.
			"gitops.bitswan.io/deployment_id": slotDepID,
			"gitops.bitswan.io/checksum":      conf.Checksum,
		},
		// Kubernetes ignores an image's own HEALTHCHECK, so without this a
		// workload counts as ready the moment it starts and the ingress can be
		// pointed at something still booting.
		Readiness: &k8srender.Probe{TCPPort: port, PeriodSeconds: 3, Failures: 100},
	}
	// Tenant code runs behind the group's egress rules, written by an init
	// container that has NET_ADMIN and is gone by the time this container
	// starts — so the workload itself cannot undo them.
	if g := c.fwGroupFor(conf); g != nil {
		w.InitContainers = append(w.InitContainers, ruleInstaller(g))
	}
	if conf.MemoryReservation != nil && *conf.MemoryReservation > 0 {
		// A request, never a limit: on Docker a workload over its reservation is
		// flagged, not killed, and turning that into an OOM kill would be a
		// behaviour change wearing a port's clothes.
		w.RequestsMem = strconv.Itoa(*conf.MemoryReservation) + "Mi"
		w.Labels["gitops.mem_reservation_mb"] = strconv.Itoa(*conf.MemoryReservation)
	}

	if !cfg.Expose {
		return w, extra, nil, true, nil
	}

	// Which slot answers on the public name. The live one serves the stage's
	// hostname; the standby serves the "dr" hostname so a rehearsal can be
	// opened without touching production; an idle slot mid-promote serves
	// nothing, which is what makes the cutover a single ingress change.
	isDR := slot != "" && slot == core.DRSlotFor(c.bs, conf)
	isLive := slot == "" || slot == core.LiveSlotFor(c.bs, conf)
	hostStage := stage
	if isDR {
		hostStage = "dr"
	}
	if !isLive && !isDR {
		w.Labels["gitops.intended_exposed"] = "false"
		return w, extra, nil, true, nil
	}
	w.Labels["gitops.intended_exposed"] = "true"

	route := &infradriver.Route{
		Hostname:       core.MakeHostnameLabel(c.workspace, automation, conf.Context, hostStage, "") + "." + c.domain,
		Upstream:       fmt.Sprintf("%s:%d", svcName, port),
		Stage:          stage,
		ParentEndpoint: c.workspace + "-dashboard." + c.domain,
		Kind:           "frontend",
	}
	return w, extra, route, true, nil
}

// workspaceRepo is where a live-dev deployment's working tree is read from, the
// same path and the same default the Docker compiler uses.
func (c *compileState) workspaceRepo() string {
	return envOr("BITSWAN_WORKSPACE_REPO_DIR", "/workspace-repo")
}

// volumeClaim is the workspace's volume, the namespace's answer to the named
// volume the Docker compiler mounts subpaths of.
func (c *compileState) volumeClaim() string {
	return os.Getenv("BITSWAN_K8S_VOLUME_CLAIM")
}

// volumeSubPath is where inside that volume a workspace's directory lives. The
// layout is byte-identical to the Docker named volume's, so the same path means
// the same directory whichever backend wrote it.
func (c *compileState) volumeSubPath(rel string) string {
	return path.Join("workspaces", c.workspace, rel)
}

// resolveAutomationConfig reads automation.toml from wherever this deployment's
// canonical source is: the working tree for live-dev, the checksum tree
// otherwise, falling back to the working tree when the source is baked into an
// image and no checksum tree was ever written.
func (c *compileState) resolveAutomationConfig(conf *core.Deployment) core.AutomationConfig {
	stage := conf.StageOrProduction()
	rel := conf.RelativePath

	var sourceDir string
	if stage == "live-dev" && rel != "" {
		sourceDir, _ = core.ContainedJoin(c.workspaceRepo(), rel)
	} else if src := core.FirstNonEmpty(conf.Source, conf.Checksum); src != "" {
		sourceDir, _ = core.ContainedJoin(c.ctx.GitopsDir, src)
	}
	if sourceDir != "" {
		if _, err := os.Stat(sourceDir); err == nil {
			return core.ReadAutomationConfig(sourceDir)
		}
	}
	if rel != "" {
		if wsDir, err := core.ContainedJoin(c.workspaceRepo(), rel); err == nil {
			if _, err := os.Stat(wsDir); err == nil {
				return core.ReadAutomationConfig(wsDir)
			}
		}
	}
	return core.DefaultAutomationConfig()
}

// workerHosts lists the peers an automation can reach, as name=host:port,
// within its own slot: a blue backend talks to the blue worker, not whichever
// one a promote happens to be replacing.
func (c *compileState) workerHosts(conf *core.Deployment, bpSlug, stage, slot string) string {
	var parts []string
	ids := make([]string, 0, len(c.bs.Deployments))
	for id := range c.bs.Deployments {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		peer := c.bs.Deployments[id]
		if peer == nil || !peer.EnabledOrDefault() {
			continue
		}
		if peer.StageOrProduction() != stage {
			continue
		}
		peerBP, _ := core.DeriveBPAndCopy(peer.RelativePath)
		if peerBP == "" {
			peerBP = peer.Context
		}
		if peerBP != bpSlug {
			continue
		}
		cfg := c.resolveAutomationConfig(peer)
		if cfg.Expose {
			continue
		}
		port := cfg.Port
		if port == 0 {
			port = 8080
		}
		name := peer.AutomationNameOr(id)
		host := core.MakeHostnameLabel(c.workspace, name, peer.Context, stage, slot)
		parts = append(parts, fmt.Sprintf("%s=%s:%d", name, host, port))
	}
	return strings.Join(parts, ",")
}

func enabledServices(conf *core.Deployment) []string {
	var out []string
	for name, raw := range conf.Services {
		m, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		if on, ok := m["enabled"].(bool); ok && on {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sortedBoolKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// builtImagePullPolicy is always IfNotPresent, whatever the platform images
// use. The suite pins those to Never so a mistyped tag fails loudly instead of
// quietly pulling a published image — but an image this driver just built lives
// in the registry and nowhere else, so refusing to pull would mean refusing to
// run anything it builds.
func builtImagePullPolicy() string {
	return "IfNotPresent"
}

// appliedNames keys the objects just applied as "<lowercase kind>/<name>", the
// shape PruneRetired asks "did the caller mean to keep this?" with.
func appliedNames(objs k8srender.ObjectSet) map[string]bool {
	keep := map[string]bool{}
	for _, obj := range objs {
		kind, _ := obj["kind"].(string)
		meta, _ := obj["metadata"].(map[string]interface{})
		name, _ := meta["name"].(string)
		if kind == "" || name == "" {
			continue
		}
		keep[strings.ToLower(kind)+"/"+name] = true
	}
	return keep
}

// runningInfos is what the provisioner needs to know about what is already up:
// which deployments have a container, and which of those are running.
//
// Every one of them is reported as pre-existing — the nil set the caller passes
// is the "nothing was just created" case — because on Kubernetes an apply does
// not tell you which pods it replaced, and the provisioner's guard is
// idempotent: it creates a database that is missing and leaves one that is not.
func runningInfos(ctx context.Context, d *K8sDriver) []core.ContainerInfo {
	pods, err := d.pods(ctx, infradriver.ContainerFilter{})
	if err != nil {
		return nil
	}
	out := make([]core.ContainerInfo, 0, len(pods))
	for _, p := range pods {
		out = append(out, core.ContainerInfo{ID: p.id, State: p.state, Labels: p.labels})
	}
	return out
}

// stagesIn is the stages this compile describes, which bounds what a prune may
// consider retired.
func stagesIn(objs k8srender.ObjectSet) []string {
	seen := map[string]bool{}
	for _, obj := range objs {
		meta, _ := obj["metadata"].(map[string]interface{})
		labels, _ := meta["labels"].(map[string]interface{})
		if stage, _ := labels["gitops.stage"].(string); stage != "" {
			seen[stage] = true
		}
	}
	return sortedBoolKeys(seen)
}

// waitForRouted blocks until each routed workload has a ready replica.
//
// The Deployment behind a route is looked up in what was just applied rather
// than re-derived from the Service name: the two names are shortened to
// different budgets, so shortening one again does not reliably produce the
// other.
func waitForRouted(ctx context.Context, objs k8srender.ObjectSet, routes []infradriver.Route, report func(step, msg string)) error {
	deploymentFor := map[string]string{}
	for _, obj := range objs {
		if kind, _ := obj["kind"].(string); kind != "Deployment" {
			continue
		}
		meta, _ := obj["metadata"].(map[string]interface{})
		name, _ := meta["name"].(string)
		labels, _ := meta["labels"].(map[string]interface{})
		if svc, _ := labels[k8srender.NameLabel].(string); svc != "" && name != "" {
			deploymentFor[svc] = name
		}
	}

	seen := map[string]bool{}
	for _, r := range routes {
		svc, _, _ := strings.Cut(r.Upstream, ":")
		dep := deploymentFor[svc]
		if dep == "" || seen[dep] {
			continue
		}
		seen[dep] = true
		if err := k8sctl.WaitAvailable(ctx, dep, routeReadyTimeout); err != nil {
			return fmt.Errorf("%s is routed but never became ready: %w", svc, err)
		}
		report("wait", svc+" is serving")
	}
	return nil
}

// routeReadyTimeout is how long a workload has to start answering before the
// deploy gives up. Generous, because a first pull of a freshly built image on a
// cold node is minutes, and reporting a deploy failed because an image was
// still downloading would be a lie.
const routeReadyTimeout = 10 * time.Minute
