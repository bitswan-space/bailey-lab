package k8sdriver

import (
	"fmt"
	"path"
	"sort"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver/core"
	"github.com/bitswan-space/bitswan-workspaces/internal/k8srender"
)

type fwGroup struct {
	proxy string
	mode  string
	allow []string
	realm string
	bp    string
}

type fwKey struct{ ctx, stage string }

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

func (g *fwGroup) attemptsPath() string {
	return path.Join("/firewall", fmt.Sprintf("%s__%s.attempts.jsonl", g.bp, g.realm))
}

func ruleInstaller(g *fwGroup, peers []string) k8srender.InitContainer {
	return k8srender.InitContainer{
		Name:       "egress-rules",
		Image:      gatewayImage(),
		PullPolicy: builtImagePullPolicy(),
		Env: map[string]string{
			"BITSWAN_FW_ROLE":  "owner",
			"BITSWAN_FW_MODE":  g.mode,
			"BITSWAN_FW_PROXY": k8srender.Name(g.proxy, k8srender.ServiceNameMax),
			"BITSWAN_FW_HOLD":  "0",
			"BITSWAN_FW_PEERS": strings.Join(peers, ","),
		},
		Capabilities: []string{"NET_ADMIN"},
	}
}

func peerAddresses(peers []string, ips map[string]string) string {
	if len(ips) == 0 {
		return ""
	}
	var out []string
	for _, peer := range peers {
		if ip := ips[peer]; ip != "" {
			out = append(out, peer+"="+ip)
		}
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}

func gatewayImage() string {
	return envOr("BITSWAN_EGRESS_GATEWAY_IMAGE", "bitswan/egress-gateway:latest")
}

func (c *compileState) peersFor(realm, bp string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(name string) {
		svc := k8srender.Name(name, k8srender.ServiceNameMax)
		if svc == "" || seen[svc] {
			return
		}
		seen[svc] = true
		out = append(out, svc)
	}

	for _, svc := range []string{"postgres", "garage"} {
		add(c.workspace + "__" + svc + core.ServiceSuffix(realm))
	}
	for _, depID := range core.SortedDepIDs(c.bs.Deployments) {
		peer := c.bs.Deployments[depID]
		if peer == nil || !peer.EnabledOrDefault() {
			continue
		}
		if core.RealmForStage(peer.StageOrProduction()) != realm {
			continue
		}
		peerBP, _ := core.DeriveBPAndCopy(peer.RelativePath)
		if peerBP == "" {
			peerBP = peer.Context
		}
		if peerBP != bp {
			continue
		}
		name := peer.AutomationNameOr(depID)
		for _, sd := range core.SlotDBPairs(c.bs, peer) {
			add(core.MakeHostnameLabel(c.workspace, name, peer.Context, peer.StageOrProduction(), sd.Slot))
		}
	}
	sort.Strings(out)
	return out
}
