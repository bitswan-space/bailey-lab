package k8sdriver

import (
	"fmt"
	"path"
	"sort"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver/core"
	"github.com/bitswan-space/bitswan-workspaces/internal/k8srender"
)

// The egress firewall, in a namespace.
//
// The Docker arrangement is two containers: one owns a network namespace and
// installs the rules, the worker joins that namespace with NET_ADMIN dropped,
// and a separate proxy elsewhere does the SNI allow-listing. The point of the
// split is that nothing privileged is ever co-resident with tenant code.
//
// A pod already owns a network namespace, so the owner becomes an init
// container: it writes the rules and exits before the app container starts.
// That is the same guarantee with less running — there is no privileged sibling
// at all, only a privileged step that is over.
//
// The proxy stays exactly what it was: its own workload, its own namespace,
// unprivileged, reached by Service name.

// fwGroup is one firewalled scope: every deployment in a (context, stage) pair
// shares a posture, an allow-list and a proxy.
type fwGroup struct {
	proxy string
	mode  string
	allow []string
	realm string
	bp    string
}

type fwKey struct{ ctx, stage string }

// firewallScope decides which groups are firewalled and how.
//
// Fail closed, the same way the Docker compiler does: an enforcing realm gets a
// group even when the declaration names no firewall node for it, because a
// missing node means an empty allow-list — default deny — and not "no firewall".
func (c *compileState) firewallScope() map[fwKey]*fwGroup {
	scope := map[fwKey]*fwGroup{}
	for _, depID := range core.SortedDepIDs(c.bs.Deployments) {
		conf := c.bs.Deployments[depID]
		if conf == nil || !conf.EnabledOrDefault() {
			continue
		}
		if conf.Active != nil && !*conf.Active {
			continue
		}
		stage := conf.StageOrProduction()
		realm := core.RealmForStage(stage)
		bp, _ := core.DeriveBPAndCopy(conf.RelativePath)
		if bp == "" {
			bp = conf.Context
		}
		key := fwKey{conf.Context, stage}
		if _, seen := scope[key]; seen {
			continue
		}
		mode := core.PostureFor(realm)
		if node := core.FirewallNodeFor(c.bs, bp, realm); node != nil && node.Posture != "" {
			mode = node.Posture
		}
		scope[key] = &fwGroup{
			proxy: core.MakeHostnameLabel(c.workspace, "fwgw", conf.Context, stage, "") + "-proxy",
			mode:  mode,
			allow: core.AllowedHosts(c.bs, bp, realm),
			realm: realm,
			bp:    bp,
		}
	}
	return scope
}

func (c *compileState) fwGroupFor(conf *core.Deployment) *fwGroup {
	if c.fw == nil {
		return nil
	}
	return c.fw[fwKey{conf.Context, conf.StageOrProduction()}]
}

// firewallObjects renders one proxy per group.
func (c *compileState) firewallObjects() k8srender.ObjectSet {
	keys := make([]fwKey, 0, len(c.fw))
	for k := range c.fw {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].ctx != keys[j].ctx {
			return keys[i].ctx < keys[j].ctx
		}
		return keys[i].stage < keys[j].stage
	})

	var objs k8srender.ObjectSet
	for _, k := range keys {
		g := c.fw[k]
		objs = append(objs, k8srender.Deployment(k8srender.Workload{
			Name:          g.proxy,
			ContainerName: g.proxy,
			Workspace:     c.workspace,
			Image:         gatewayImage(),
			PullPolicy:    builtImagePullPolicy(),
			VolumeClaim:   c.volumeClaim(),
			Env: map[string]string{
				"BITSWAN_FW_ROLE":     "proxy",
				"BITSWAN_FW_MODE":     g.mode,
				"BITSWAN_FW_ALLOW":    strings.Join(g.allow, ","),
				"BITSWAN_FW_ATTEMPTS": g.attemptsPath(),
			},
			Mounts: []k8srender.Mount{
				{Path: "/firewall", SubPath: c.volumeSubPath("firewall")},
			},
			Ports: []k8srender.Port{
				{Name: "https", Port: 18443},
				{Name: "http", Port: 18080},
				{Name: "health", Port: 18077},
			},
			Readiness: &k8srender.Probe{TCPPort: 18077, PeriodSeconds: 3, Failures: 40},
			Labels: map[string]string{
				"gitops.firewall_proxy": "true",
				"gitops.bp":             g.bp,
				"gitops.context":        k.ctx,
				"gitops.stage":          k.stage,
				"gitops.realm":          g.realm,
			},
		})...)
	}
	return objs
}

// attemptsPath is where the proxy records what was reached for. The name is the
// Docker one, because the same dashboard reads it.
func (g *fwGroup) attemptsPath() string {
	return path.Join("/firewall", fmt.Sprintf("%s__%s.attempts.jsonl", g.bp, g.realm))
}

// ruleInstaller is the init container that writes this pod's egress rules.
//
// It runs the same image and the same entrypoint as the Docker owner, told not
// to hold the namespace: in a pod there is nothing to hold it for, and an init
// container that does not exit is a pod that never starts.
func ruleInstaller(g *fwGroup) k8srender.InitContainer {
	return k8srender.InitContainer{
		Name:       "egress-rules",
		Image:      gatewayImage(),
		PullPolicy: builtImagePullPolicy(),
		Env: map[string]string{
			"BITSWAN_FW_ROLE":  "owner",
			"BITSWAN_FW_MODE":  g.mode,
			"BITSWAN_FW_PROXY": k8srender.Name(g.proxy, k8srender.ServiceNameMax),
			"BITSWAN_FW_HOLD":  "0",
		},
		Capabilities: []string{"NET_ADMIN"},
	}
}

func gatewayImage() string {
	return envOr("BITSWAN_EGRESS_GATEWAY_IMAGE", "bitswan/egress-gateway:latest")
}
