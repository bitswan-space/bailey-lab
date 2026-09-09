package daemon

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/k8sctl"
	"github.com/bitswan-space/bitswan-workspaces/internal/k8srender"
)

// bringUpWorkspaceK8s starts a workspace's own services in this namespace: the
// gitops state manager, the dashboard people work in, and the coding agent.
//
// It is the namespace's answer to `docker compose -p <ws>-site up -d`. Every
// path a service reads is a subdirectory of the volume this daemon already
// carries — the same layout a Docker host keeps under
// ~/.config/bitswan/workspaces/<ws> — so the daemon can do all of a workspace's
// filesystem work directly, exactly as it does today, and the services mount
// subpaths of it.
//
// One consequence worth stating: a ReadWriteOnce volume is single-NODE, not
// single-pod, so these land on the node the daemon is on. That is the same
// topology a Docker host has, and a cluster that wants them spread needs a
// volume class that allows it.
func bringUpWorkspaceK8s(ctx context.Context, cfg workspaceK8sConfig) error {
	objs := workspaceObjects(cfg)
	if err := k8sctl.Apply(ctx, objs); err != nil {
		return fmt.Errorf("apply workspace objects: %w", err)
	}
	// gitops is what the dashboard and the agent talk to, and what the console
	// polls, so it is the one worth blocking on. The other two are reported by
	// the console as they arrive.
	if err := k8sctl.WaitAvailable(ctx, k8srender.Name(cfg.Workspace+"-gitops", k8srender.WorkloadNameMax), 5*time.Minute); err != nil {
		return err
	}
	return nil
}

// workspaceK8sConfig is what a workspace needs to run, gathered by the caller
// that already computes it for the Docker path.
type workspaceK8sConfig struct {
	Workspace         string
	Domain            string
	VolumeClaim       string
	GitopsImage       string
	DashboardImage    string
	CodingAgentImage  string
	PullPolicy        string
	GitopsSecret      string
	CodingAgentSecret string
	CertsDir          string
	WithDashboard     bool
	WithCodingAgent   bool
}

// workspaceObjects renders everything a workspace runs. Pure, so the shape is a
// test rather than something only a cluster can tell you.
func workspaceObjects(cfg workspaceK8sConfig) k8srender.ObjectSet {
	ws := cfg.Workspace
	sub := func(dir string) string { return "workspaces/" + ws + "/" + dir }

	gitops := k8srender.Workload{
		Name:          ws + "-gitops",
		ContainerName: ws + "-gitops",
		Workspace:     ws,
		Image:         cfg.GitopsImage,
		PullPolicy:    cfg.PullPolicy,
		VolumeClaim:   cfg.VolumeClaim,
		Ports:         []k8srender.Port{{Name: "api", Port: 8079}, {Name: "agent-ssh", Port: 2222}},
		Env: map[string]string{
			"BITSWAN_GITOPS_DIR":         "/gitops",
			"BITSWAN_GITOPS_DIR_HOST":    "/gitops",
			"BITSWAN_GITOPS_SECRET":      cfg.GitopsSecret,
			"BITSWAN_GITOPS_DOMAIN":      cfg.Domain,
			"BITSWAN_WORKSPACE_NAME":     ws,
			"BITSWAN_CERTS_DIR":          cfg.CertsDir,
			"BITSWAN_GIT_REPOS_DIR":      "/git",
			"BITSWAN_WORKSPACE_REPO_DIR": "/workspace-repo",
			"BITSWAN_COPIES_DIR":         "/workspace-repo/copies",
			"BITSWAN_GIT_REMOTE":         "http://" + ws + "-gitops:8079/git",
			// The volume name is how the Docker compiler decides to mount a
			// business process off a named volume instead of a host path. In a
			// namespace there is no host path to fall back to, and the driver
			// renders volume mounts itself, so it is left unset.
			"BITSWAN_GITOPS_AGENT_SECRET": cfg.CodingAgentSecret,
		},
		Mounts: []k8srender.Mount{
			{Path: "/gitops/gitops", SubPath: sub("gitops")},
			{Path: "/gitops/secrets", SubPath: sub("secrets")},
			{Path: "/gitops/snapshots", SubPath: sub("snapshots")},
			{Path: "/gitops/firewall", SubPath: sub("firewall")},
			{Path: "/home/user1000/.ssh", SubPath: sub("ssh")},
			{Path: "/git", SubPath: sub("git-repos")},
			{Path: "/workspace-repo/copies", SubPath: sub("copies")},
		},
		Readiness: &k8srender.Probe{TCPPort: 8079, PeriodSeconds: 5, Failures: 60},
	}

	objs := k8srender.Deployment(gitops)

	if cfg.WithDashboard {
		objs = append(objs, k8srender.Deployment(k8srender.Workload{
			Name:          ws + "-dashboard",
			ContainerName: ws + "-dashboard",
			Workspace:     ws,
			Image:         cfg.DashboardImage,
			PullPolicy:    cfg.PullPolicy,
			VolumeClaim:   cfg.VolumeClaim,
			Ports:         []k8srender.Port{{Name: "http", Port: 8080}},
			Env: map[string]string{
				"BITSWAN_WORKSPACE_NAME": ws,
				"BITSWAN_DEPLOY_URL":     "http://" + ws + "-gitops:8079",
				"BITSWAN_DEPLOY_SECRET":  cfg.GitopsSecret,
				"PORT":                   "8080",
				"INTERNAL_PORT":          "8081",
			},
			Mounts: []k8srender.Mount{
				{Path: "/workspace/workspace/copies", SubPath: sub("copies")},
				{Path: "/workspace/.ssh", SubPath: sub("ssh"), ReadOnly: true},
				{Path: "/workspace/agent-sessions", SubPath: sub("coding-agent-sessions"), ReadOnly: true},
			},
			Readiness: &k8srender.Probe{TCPPort: 8080, PeriodSeconds: 5, Failures: 60},
		})...)
	}

	if cfg.WithCodingAgent {
		objs = append(objs, k8srender.Deployment(k8srender.Workload{
			Name:          ws + "-coding-agent",
			ContainerName: ws + "-coding-agent",
			Workspace:     ws,
			Image:         cfg.CodingAgentImage,
			PullPolicy:    cfg.PullPolicy,
			VolumeClaim:   cfg.VolumeClaim,
			Ports:         []k8srender.Port{{Name: "ssh", Port: 22}},
			Env: map[string]string{
				"BITSWAN_WORKSPACE_NAME":      ws,
				"BITSWAN_GITOPS_URL":          "http://" + ws + "-gitops:8079",
				"BITSWAN_GITOPS_AGENT_SECRET": cfg.CodingAgentSecret,
			},
			Mounts: []k8srender.Mount{
				{Path: "/workspace/copies", SubPath: sub("copies")},
				{Path: "/home/agent", SubPath: sub("coding-agent-home")},
				{Path: "/var/log/agent-sessions", SubPath: sub("coding-agent-sessions")},
			},
			Labels: map[string]string{"bitswan.io/role": "coding-agent"},
		})...)
		objs = append(objs, codingAgentIsolation(ws))
	}

	return objs
}

// codingAgentIsolation is the namespace's form of the dedicated bridge the agent
// gets on a Docker host.
//
// The agent runs code its users and an AI wrote, so its entire reachable surface
// must be the authenticated gitops API and nothing else — not the daemon's gate,
// not the dashboard, not another workspace. On Docker that is a private network
// it shares only with gitops. In a namespace every pod can reach every pod by
// default, so the same property has to be stated as policy, and stated as egress:
// what matters is not who can reach the agent but what the agent can reach.
func codingAgentIsolation(ws string) k8srender.Object {
	agentSelector := map[string]interface{}{
		"matchLabels": map[string]interface{}{
			k8srender.NameLabel: k8srender.Name(ws+"-coding-agent", k8srender.ServiceNameMax),
		},
	}
	gitopsPeer := map[string]interface{}{
		"podSelector": map[string]interface{}{
			"matchLabels": map[string]interface{}{
				k8srender.NameLabel: k8srender.Name(ws+"-gitops", k8srender.ServiceNameMax),
			},
		},
	}
	return k8srender.Object{
		"apiVersion": "networking.k8s.io/v1",
		"kind":       "NetworkPolicy",
		"metadata": map[string]interface{}{
			"name": k8srender.Name(ws+"-coding-agent-isolation", k8srender.ServiceNameMax),
			"labels": map[string]interface{}{
				k8srender.ManagedByLabel: k8srender.ManagedBy,
				k8srender.WorkspaceLabel: k8srender.LabelValue(ws),
			},
		},
		"spec": map[string]interface{}{
			"podSelector": agentSelector,
			"policyTypes": []interface{}{"Egress"},
			"egress": []interface{}{
				map[string]interface{}{"to": []interface{}{gitopsPeer}},
				// Without an explicit allowance for DNS, an egress policy takes
				// name resolution with it and every failure looks like something
				// else.
				map[string]interface{}{
					"to": []interface{}{
						map[string]interface{}{
							"namespaceSelector": map[string]interface{}{
								"matchLabels": map[string]interface{}{
									"kubernetes.io/metadata.name": "kube-system",
								},
							},
						},
					},
					"ports": []interface{}{
						map[string]interface{}{"protocol": "UDP", "port": 53},
						map[string]interface{}{"protocol": "TCP", "port": 53},
					},
				},
			},
		},
	}
}

// k8sWorkspaceVolumeClaim is the volume a workspace's services mount subpaths
// of. It is the same volume the daemon keeps its own state on, because that is
// where a workspace's tree lives — the namespace equivalent of the one named
// volume a Docker host shares between the daemon and every workspace.
func k8sWorkspaceVolumeClaim() string {
	if c := os.Getenv("BITSWAN_K8S_VOLUME_CLAIM"); c != "" {
		return c
	}
	return "bailey-config"
}

// k8sPullPolicy defaults to IfNotPresent, and is set to Never by the suite so a
// mistyped tag fails loudly instead of quietly pulling a published image and
// testing code that is not the code under test.
// k8sWorkspaceImages reports the images a workspace's services run, which in a
// namespace can only come from this daemon's own environment: there is no
// `--dev` host flag and no image resolution against a local Docker.
func k8sWorkspaceImages(gitops, dashboard, agent string) (string, string, string) {
	if v := os.Getenv("BITSWAN_GITOPS_IMAGE"); v != "" {
		gitops = v
	}
	if v := os.Getenv("BITSWAN_DASHBOARD_IMAGE"); v != "" {
		dashboard = v
	}
	if v := os.Getenv("BITSWAN_CODING_AGENT_IMAGE"); v != "" {
		agent = v
	}
	return gitops, dashboard, agent
}

func k8sPullPolicy() string {
	if p := os.Getenv("BITSWAN_K8S_PULL_POLICY"); p != "" {
		return p
	}
	return "IfNotPresent"
}
