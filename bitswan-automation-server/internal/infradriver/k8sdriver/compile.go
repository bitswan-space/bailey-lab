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

func (d *K8sDriver) apply(ctx context.Context, req infradriver.ApplyRequest, report func(step, msg string)) ([]infradriver.Route, error) {
	report("compile", "compiling bitswan.yaml")
	bs, err := core.ParseBitswanYAML([]byte(req.BitswanYAML))
	if err != nil {
		return nil, fmt.Errorf("parse bitswan.yaml: %w", err)
	}

	x := execer{d: d}
	report("provision", "Ensuring Garage access keys for scoped backends...")
	core.EnsureGarageKeysPrecompile(x, ctx, req.Ctx, bs, report)

	c := &compileState{
		driver:    d,
		ctx:       req.Ctx,
		bs:        bs,
		workspace: d.workspace,
		domain:    req.Ctx.Domain,
		claim:     os.Getenv("BITSWAN_K8S_VOLUME_CLAIM"),
	}
	if ips, err := k8sctl.ServiceClusterIPs(ctx); err == nil {
		c.peerIPs = ips
	}
	report("compile", "workspace volume: "+describeClaim(c.claim))
	foundation, workloads, routes, err := c.compile()
	if err != nil {
		return nil, err
	}
	if len(foundation) == 0 && len(workloads) == 0 {
		report("apply", "nothing declared for this business process")
		return routes, nil
	}

	if len(foundation) > 0 {
		report("apply", fmt.Sprintf("applying %d foundation object(s)", len(foundation)))
		if err := k8sctl.Apply(ctx, foundation); err != nil {
			return nil, err
		}
		report("wait", "waiting for the stage's infrastructure")
		if err := waitForFoundation(ctx, foundation, report); err != nil {
			return nil, err
		}
	}

	report("provision", "Ensuring live databases for (re)created backends...")
	if err := core.EnsureLivePostgresDBs(x, ctx, req.Ctx, bs, nil, runningInfos(ctx, d), report); err != nil {
		return nil, fmt.Errorf("ensure live postgres dbs: %w", err)
	}
	report("provision", "Provisioning per-BP namespaces...")
	if changed := core.ProvisionForDeployments(x, ctx, req.Ctx, bs, report); len(changed) > 0 {
		report("provision", fmt.Sprintf("credentials arrived for %d resource(s); recompiling", len(changed)))
		if _, workloads, routes, err = c.compile(); err != nil {
			return nil, err
		}
	}

	if len(workloads) > 0 {
		report("apply", fmt.Sprintf("applying %d workload object(s)", len(workloads)))
		if err := k8sctl.Apply(ctx, workloads); err != nil {
			return nil, err
		}
	}

	applied := append(append(k8srender.ObjectSet{}, foundation...), workloads...)

	if req.Ctx.BP != "" {
		keep := appliedNames(applied)
		for _, scope := range prunableScopes(applied) {
			selector := k8srender.WorkspaceLabel + "=" + k8srender.LabelValue(d.workspace) +
				",gitops.bp=" + scope.bp + ",gitops.stage=" + scope.stage +
				",gitops.context=" + scope.context
			if err := k8sctl.PruneRetired(ctx, selector, keep); err != nil {
				return nil, fmt.Errorf("prune retired workloads: %w", err)
			}
		}
	}

	if len(routes) > 0 {
		report("wait", fmt.Sprintf("waiting for %d routed workload(s)", len(routes)))
		if err := waitForRouted(ctx, workloads, routes, report); err != nil {
			return nil, err
		}
	}

	report("ingress", fmt.Sprintf("converging %d route(s)", len(routes)))
	if err := core.ReconcileIngress(ctx, d.workspace, req.Ctx.BP, routes); err != nil {
		return nil, fmt.Errorf("ingress reconcile: %w", err)
	}
	return routes, nil
}

func waitForFoundation(ctx context.Context, foundation k8srender.ObjectSet, report func(step, msg string)) error {
	for _, obj := range foundation {
		kind, _ := obj["kind"].(string)
		if kind != "StatefulSet" && kind != "Deployment" {
			continue
		}
		meta, _ := obj["metadata"].(map[string]interface{})
		name, _ := meta["name"].(string)
		if name == "" {
			continue
		}
		if err := k8sctl.WaitRollout(ctx, kind, name, foundationReadyTimeout); err != nil {
			return fmt.Errorf("%s is what this business process runs on: %w", name, err)
		}
		report("wait", name+" is ready")
	}
	return nil
}

const foundationReadyTimeout = 10 * time.Minute

type compileState struct {
	driver    *K8sDriver
	ctx       infradriver.WorkspaceContext
	bs        *core.Bitswan
	workspace string
	domain    string
	fw        map[fwKey]*fwGroup
	claim     string
	peerIPs   map[string]string
}

func (c *compileState) compile() (foundation, workloads k8srender.ObjectSet, routes []infradriver.Route, err error) {
	var objs k8srender.ObjectSet

	c.fw = c.firewallScope()

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

		if conf.Active != nil && !*conf.Active {
			routes = append(routes, c.routesKeptWhileAsleep(id, conf)...)
			continue
		}

		for _, sd := range core.SlotDBPairs(c.bs, conf) {
			slotConf := core.EffectiveSlotConf(id, conf, sd.Slot, c.bs.Deployments)
			w, extra, route, emit, err := c.workload(id, slotConf, sd.Slot, sd.DB)
			if err != nil {
				return nil, nil, nil, err
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

	var infra k8srender.ObjectSet
	for _, realm := range sortedKeys(realms) {
		for _, svc := range sortedBoolKeys(realms[realm]) {
			rendered, ierr := c.infraService(svc, realm)
			if ierr != nil {
				return nil, nil, nil, ierr
			}
			infra = append(infra, rendered...)
		}
	}
	return append(infra, c.firewallObjects()...), objs, routes, nil
}

func (c *compileState) workload(depID string, conf *core.Deployment, slot string, db int) (k8srender.Workload, k8srender.ObjectSet, *infradriver.Route, bool, error) {
	stage := conf.StageOrProduction()
	realm := core.RealmForStage(stage)
	automation := conf.AutomationNameOr(depID)
	bpSlug, copyName := core.DeriveBPAndCopy(conf.RelativePath)
	if bpSlug == "" {
		bpSlug = conf.Context
	}

	svcName := core.MakeHostnameLabel(c.workspace, automation, conf.Context, stage, slot)

	rel := conf.RelativePath
	source := core.FirstNonEmpty(core.FirstNonEmpty(conf.Source, conf.Checksum), depID)

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
		image = conf.Image
	default:
		mounts = append(mounts, k8srender.Mount{
			Path:     cfg.MountPath,
			SubPath:  c.volumeSubPath("gitops/" + source),
			ReadOnly: true,
		})
	}
	image = resolveImage(image)
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

	isLiveSlot := slot == "" || slot == core.LiveSlotFor(c.bs, conf)
	slotDepID := depID
	if !isLiveSlot {
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

	env["BITSWAN_WORKER_HOSTS"] = c.workerHosts(conf, bpSlug, stage, slot)

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
	secretName, extra := credentialSecret(svcName, secretContent, map[string]interface{}{
		k8srender.WorkspaceLabel: k8srender.LabelValue(c.workspace),
		"gitops.bp":              k8srender.LabelValue(bpSlug),
		"gitops.stage":           k8srender.LabelValue(stage),
		"gitops.context":         k8srender.LabelValue(conf.Context),
	})
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
			"bitswan.io/credentials":          c.credentialsFingerprint(slot, secretContent),
			"gitops.bitswan.io/deployment_id": slotDepID,
			"gitops.bitswan.io/checksum":      conf.Checksum,
		},
		Readiness: &k8srender.Probe{TCPPort: port, PeriodSeconds: 3, Failures: 100},
	}
	if g := c.fwGroupFor(conf); g != nil {
		peers := c.peersFor(realm, bpSlug)
		w.InitContainers = append(w.InitContainers, ruleInstaller(g, peers))
		if pinned := peerAddresses(peers, c.peerIPs); pinned != "" {
			w.Annotations["bitswan.io/fw-peers"] = pinned
		}
	}
	if conf.MemoryReservation != nil && *conf.MemoryReservation > 0 {
		w.RequestsMem = strconv.Itoa(*conf.MemoryReservation) + "Mi"
		w.Labels["gitops.mem_reservation_mb"] = strconv.Itoa(*conf.MemoryReservation)
	}

	if !cfg.Expose {
		return w, extra, nil, true, nil
	}

	isDR := slot != "" && slot == core.DRSlotFor(c.bs, conf)
	isLive := isLiveSlot
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

func (c *compileState) workspaceRepo() string {
	return envOr("BITSWAN_WORKSPACE_REPO_DIR", "/workspace-repo")
}

func (c *compileState) volumeClaim() string {
	return c.claim
}

func describeClaim(claim string) string {
	if claim == "" {
		return "none configured (BITSWAN_K8S_VOLUME_CLAIM is unset)"
	}
	return claim
}

func (c *compileState) volumeSubPath(rel string) string {
	return path.Join("workspaces", c.workspace, rel)
}

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

func builtImagePullPolicy() string {
	return "IfNotPresent"
}

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

type pruneScope struct{ bp, stage, context string }

func prunableScopes(objs k8srender.ObjectSet) []pruneScope {
	seen := map[pruneScope]bool{}
	for _, obj := range objs {
		meta, _ := obj["metadata"].(map[string]interface{})
		labels, _ := meta["labels"].(map[string]interface{})
		bp, _ := labels["gitops.bp"].(string)
		stage, _ := labels["gitops.stage"].(string)
		context, _ := labels["gitops.context"].(string)
		if bp == "" || stage == "" || context == "" {
			continue
		}
		seen[pruneScope{bp: bp, stage: stage, context: context}] = true
	}
	out := make([]pruneScope, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].bp != out[j].bp {
			return out[i].bp < out[j].bp
		}
		if out[i].stage != out[j].stage {
			return out[i].stage < out[j].stage
		}
		return out[i].context < out[j].context
	})
	return out
}

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

const routeReadyTimeout = 10 * time.Minute

func resolveImage(image string) string {
	if strings.HasPrefix(image, builtImagePrefix) {
		return registryRef(image)
	}
	return image
}

const builtImagePrefix = "internal/"

func (c *compileState) routesKeptWhileAsleep(depID string, conf *core.Deployment) []infradriver.Route {
	automation := conf.AutomationNameOr(depID)
	stage := conf.StageOrProduction()
	var out []infradriver.Route
	for _, sd := range core.SlotDBPairs(c.bs, conf) {
		slotConf := core.EffectiveSlotConf(depID, conf, sd.Slot, c.bs.Deployments)
		cfg := c.resolveAutomationConfig(slotConf)
		if !cfg.Expose || cfg.Port == 0 {
			continue
		}
		isLive := sd.Slot == "" || sd.Slot == core.LiveSlotFor(c.bs, slotConf)
		isDR := sd.Slot != "" && sd.Slot == core.DRSlotFor(c.bs, slotConf)
		if !isLive && !isDR {
			continue
		}
		hostStage := stage
		if isDR {
			hostStage = "dr"
		}
		out = append(out, infradriver.Route{
			Hostname: core.MakeHostnameLabel(c.workspace, automation, slotConf.Context, hostStage, "") + "." + c.domain,
			Upstream: fmt.Sprintf("%s:%d",
				core.MakeHostnameLabel(c.workspace, automation, slotConf.Context, stage, sd.Slot), cfg.Port),
			Stage:          stage,
			ParentEndpoint: c.workspace + "-dashboard." + c.domain,
			Kind:           "frontend",
		})
	}
	return out
}

func (c *compileState) credentialsFingerprint(slot string, content map[string]string) string {
	if slot != "" {
		return "none"
	}
	if h := core.SecretsContentHash(c.ctx.SecretsDir, content); h != "" {
		return h
	}
	return "none"
}
