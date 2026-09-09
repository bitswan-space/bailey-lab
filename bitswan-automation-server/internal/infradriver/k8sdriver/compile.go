package k8sdriver

import (
	"context"
	"fmt"
	"path"
	"sort"
	"strconv"
	"strings"

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
}

// compile turns the declaration into the objects that realize it.
func (c *compileState) compile() (k8srender.ObjectSet, []infradriver.Route, error) {
	var objs k8srender.ObjectSet
	var routes []infradriver.Route

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

		w, route, err := c.workload(id, conf)
		if err != nil {
			return nil, nil, err
		}
		objs = append(objs, k8srender.Deployment(w)...)
		if route != nil {
			routes = append(routes, *route)
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
	return append(infra, objs...), routes, nil
}

// workload renders one automation.
func (c *compileState) workload(depID string, conf *core.Deployment) (k8srender.Workload, *infradriver.Route, error) {
	stage := conf.StageOrProduction()
	realm := core.RealmForStage(stage)
	automation := conf.AutomationNameOr(depID)
	bpSlug, _ := core.DeriveBPAndCopy(conf.RelativePath)
	if bpSlug == "" {
		bpSlug = conf.Context
	}

	// The name a route points at. Derived exactly as the Docker driver derives a
	// container name, so an upstream written by either backend resolves.
	svcName := core.MakeHostnameLabel(c.workspace, automation, conf.Context, stage, "")

	image := conf.Image
	if image == "" {
		return k8srender.Workload{}, nil, fmt.Errorf(
			"%s has no built image: the kubernetes driver deploys images built beforehand", depID)
	}

	cfg := core.ReadAutomationConfig(c.sourceDir(conf))
	port := cfg.Port
	if port == 0 {
		port = 8080
	}

	env := map[string]string{
		"DEPLOYMENT_ID":            depID,
		"BITSWAN_DEPLOYMENT_ID":    depID,
		"BITSWAN_AUTOMATION_STAGE": stage,
		"BITSWAN_WORKSPACE_NAME":   c.workspace,
		"BITSWAN_GITOPS_DOMAIN":    c.domain,
		"BITSWAN_DEPLOY_CHECKSUM":  conf.Checksum,
		"PORT":                     strconv.Itoa(port),
	}
	if cfg.Expose {
		env["BITSWAN_AUTOMATION_URL"] = "https://" + svcName + "." + c.domain
	}

	// What the Docker driver hands a worker as a peer address is the firewall
	// gateway it shares a network namespace with. Nothing shares a namespace
	// here, so a peer is its own Service — which is also why a worker can be
	// replicated on Kubernetes and cannot on Docker.
	env["BITSWAN_WORKER_HOSTS"] = c.workerHosts(conf, bpSlug, stage)

	w := k8srender.Workload{
		Name:          svcName,
		ContainerName: svcName,
		Workspace:     c.workspace,
		// The registry reference, not the bare tag. A build here is a push, so
		// the tag bitswan.yaml records is a name in the namespace's registry —
		// the kubelet asked for the bare tag would go looking on Docker Hub.
		Image:      registryRef(image),
		PullPolicy: builtImagePullPolicy(),
		Replicas:      conf.ReplicasOrOne(),
		Env:           env,
		Ports:         []k8srender.Port{{Name: "app", Port: port}},
		Labels: map[string]string{
			"gitops.automation_name": automation,
			"gitops.context":         conf.Context,
			"gitops.bp":              bpSlug,
			"gitops.stage":           stage,
			"gitops.realm":           realm,
		},
		Annotations: map[string]string{
			// The raw values, because a label cannot hold all of them: an
			// identifier carries an "@" once a slot is involved, and a content
			// hash is a character over the limit.
			"gitops.bitswan.io/deployment_id": depID,
			"gitops.bitswan.io/checksum":      conf.Checksum,
		},
		// Kubernetes ignores an image's own HEALTHCHECK, so without this a
		// workload counts as ready the moment it starts and the ingress can be
		// pointed at something still booting.
		Readiness: &k8srender.Probe{TCPPort: port, PeriodSeconds: 3, Failures: 100},
	}
	if conf.MemoryReservation != nil && *conf.MemoryReservation > 0 {
		// A request, never a limit: on Docker a workload over its reservation is
		// flagged, not killed, and turning that into an OOM kill would be a
		// behaviour change wearing a port's clothes.
		w.RequestsMem = strconv.Itoa(*conf.MemoryReservation) + "Mi"
		w.Labels["gitops.mem_reservation_mb"] = strconv.Itoa(*conf.MemoryReservation)
	}

	if !cfg.Expose {
		return w, nil, nil
	}
	route := &infradriver.Route{
		Hostname:       svcName + "." + c.domain,
		Upstream:       fmt.Sprintf("%s:%d", svcName, port),
		Stage:          stage,
		ParentEndpoint: c.workspace + "-dashboard." + c.domain,
		Kind:           "frontend",
	}
	return w, route, nil
}

// workerHosts lists the peers an automation can reach, as name=host:port.
func (c *compileState) workerHosts(conf *core.Deployment, bpSlug, stage string) string {
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
		cfg := core.ReadAutomationConfig(c.sourceDir(peer))
		if cfg.Expose {
			continue
		}
		port := cfg.Port
		if port == 0 {
			port = 8080
		}
		name := peer.AutomationNameOr(id)
		host := core.MakeHostnameLabel(c.workspace, name, peer.Context, stage, "")
		parts = append(parts, fmt.Sprintf("%s=%s:%d", name, host, port))
	}
	return strings.Join(parts, ",")
}

func (c *compileState) sourceDir(conf *core.Deployment) string {
	if conf.Checksum == "" {
		return ""
	}
	return path.Join(c.ctx.GitopsDir, conf.Checksum)
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
