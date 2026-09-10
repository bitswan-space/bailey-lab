package daemon

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/k8sctl"
	"github.com/bitswan-space/bitswan-workspaces/internal/k8srender"
)

func bringUpWorkspaceK8s(ctx context.Context, cfg workspaceK8sConfig) error {
	adoptBuildProxyEnvK8s(ctx)
	objs := workspaceObjects(cfg)
	if err := k8sctl.Apply(ctx, objs); err != nil {
		return fmt.Errorf("apply workspace objects: %w", err)
	}
	for _, name := range []string{cfg.Workspace + "-gitops", cfg.Workspace + "-infra-driver"} {
		if err := k8sctl.WaitAvailable(ctx, k8srender.Name(name, k8srender.WorkloadNameMax), 5*time.Minute); err != nil {
			return err
		}
	}
	return nil
}

type workspaceK8sConfig struct {
	Workspace          string
	Domain             string
	VolumeClaim        string
	GitopsImage        string
	DashboardImage     string
	CodingAgentImage   string
	PullPolicy         string
	GitopsSecret       string
	CodingAgentSecret  string
	CertsDir           string
	WithDashboard      bool
	WithCodingAgent    bool
	EditorSSHPublicKey string
	InfraDriverImage   string
	InfraDriverToken   string
	IngressURL         string
}

const driverServiceAccount = "bitswan-infra-driver"

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
			"BITSWAN_GITOPS_DIR":          "/gitops",
			"BITSWAN_GITOPS_DIR_HOST":     "/gitops",
			"BITSWAN_GITOPS_SECRET":       cfg.GitopsSecret,
			"BITSWAN_GITOPS_DOMAIN":       cfg.Domain,
			"BITSWAN_WORKSPACE_NAME":      ws,
			"BITSWAN_CERTS_DIR":           cfg.CertsDir,
			"BITSWAN_GIT_REPOS_DIR":       "/git",
			"BITSWAN_WORKSPACE_REPO_DIR":  "/workspace-repo",
			"BITSWAN_COPIES_DIR":          "/workspace-repo/copies",
			"BITSWAN_GIT_REMOTE":          "http://" + ws + "-gitops:8079/git",
			"GRYPE_DB_CACHE_DIR":          "/grype-db",
			"BITSWAN_GRYPE_DB_MANAGED":    "1",
			"BITSWAN_GITOPS_AGENT_SECRET": cfg.CodingAgentSecret,
			"BITSWAN_INGRESS_URL":         cfg.IngressURL,
			"BITSWAN_INGRESS_TOKEN":       os.Getenv(workspaceAPITokenEnv),
			"BITSWAN_INFRA_DRIVER_URL":    "http://" + ws + "-infra-driver:9090",
			"BITSWAN_INFRA_DRIVER_TOKEN":  cfg.InfraDriverToken,
			"BITSWAN_DEPLOY_REMOTE_BASE":  "http://x:" + cfg.InfraDriverToken + "@" + ws + "-infra-driver:9090/deploy-repos",
		},
		Mounts: []k8srender.Mount{
			{Path: "/gitops/gitops", SubPath: sub("gitops")},
			{Path: "/gitops/secrets", SubPath: sub("secrets")},
			{Path: "/gitops/snapshots", SubPath: sub("snapshots")},
			{Path: "/gitops/firewall", SubPath: sub("firewall")},
			{Path: "/home/user1000/.ssh", SubPath: sub("ssh")},
			{Path: "/git", SubPath: sub("git-repos")},
			{Path: "/workspace-repo/copies", SubPath: sub("copies")},
			{Path: "/grype-db", SubPath: grypeDBSubPath, ReadOnly: true},
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

	objs = append(objs, k8srender.Deployment(k8srender.Workload{
		Name:           ws + "-infra-driver",
		ContainerName:  ws + "-infra-driver",
		Workspace:      ws,
		Image:          cfg.InfraDriverImage,
		PullPolicy:     cfg.PullPolicy,
		VolumeClaim:    cfg.VolumeClaim,
		ServiceAccount: driverServiceAccount,
		Ports:          []k8srender.Port{{Name: "api", Port: 9090}},
		Command: []string{
			"/usr/local/bin/infra-driver", "serve",
			"--listen", ":9090",
			"--deploy-repos-dir", "/git/deploy-repos",
			"--gitops-dir", "/gitops/gitops",
			"--secrets-dir", "/gitops/secrets",
			"--workspace", ws,
			"--domain", cfg.Domain,
			"--driver", "k8s",
		},
		Env: map[string]string{
			"BITSWAN_INFRA_DRIVER_TOKEN": cfg.InfraDriverToken,
			"BITSWAN_INFRA_DRIVER_KIND":  "k8s",
			"BITSWAN_K8S_PULL_POLICY":    cfg.PullPolicy,
			"BITSWAN_WORKSPACE_NAME":     ws,
			"BITSWAN_INGRESS_URL":        cfg.IngressURL,
			"BITSWAN_INGRESS_TOKEN":      os.Getenv(workspaceAPITokenEnv),
			"BITSWAN_K8S_VOLUME_CLAIM":   cfg.VolumeClaim,
			"BITSWAN_EGRESS_GATEWAY_IMAGE": envOrDefault(
				"BITSWAN_EGRESS_GATEWAY_IMAGE", "bitswan/egress-gateway:latest"),
			"BITSWAN_WORKSPACE_REPO_DIR":    "/workspace-repo",
			"BITSWAN_K8S_REGISTRY":          envOrDefault("BITSWAN_K8S_REGISTRY", "bitswan-registry:5000"),
			"BITSWAN_K8S_REGISTRY_INSECURE": os.Getenv("BITSWAN_K8S_REGISTRY_INSECURE"),
			"BITSWAN_BUILDKIT_ADDR":         envOrDefault("BITSWAN_BUILDKIT_ADDR", "tcp://bitswan-buildkit:1234"),
			"BITSWAN_GOPROXY":               os.Getenv("BITSWAN_GOPROXY"),
			"BITSWAN_NPM_REGISTRY":          os.Getenv("BITSWAN_NPM_REGISTRY"),
		},
		Mounts: []k8srender.Mount{
			{Path: "/git/deploy-repos", SubPath: sub("deploy-repos")},
			{Path: "/gitops/gitops", SubPath: sub("gitops")},
			{Path: "/gitops/secrets", SubPath: sub("secrets")},
			{Path: "/gitops/snapshots", SubPath: sub("snapshots")},
			{Path: "/gitops/firewall", SubPath: sub("firewall")},
			{Path: "/workspace-repo/copies", SubPath: sub("copies")},
		},
		Readiness: &k8srender.Probe{TCPPort: 9090, PeriodSeconds: 5, Failures: 60},
	})...)

	if cfg.WithCodingAgent {
		objs = append(objs, k8srender.Deployment(k8srender.Workload{
			Name:          ws + "-coding-agent",
			ContainerName: ws + "-coding-agent",
			Workspace:     ws,
			Image:         cfg.CodingAgentImage,
			PullPolicy:    cfg.PullPolicy,
			VolumeClaim:   cfg.VolumeClaim,
			Ports:         []k8srender.Port{{Name: "ssh", Port: 22}},
			Env:           codingAgentEnv(ws, cfg),
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

func k8sWorkspaceVolumeClaim() string {
	if c := os.Getenv("BITSWAN_K8S_VOLUME_CLAIM"); c != "" {
		return c
	}
	return "bailey-config"
}

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

func codingAgentEnv(ws string, cfg workspaceK8sConfig) map[string]string {
	env := map[string]string{
		"BITSWAN_WORKSPACE_NAME":      ws,
		"BITSWAN_GITOPS_URL":          "http://" + ws + "-gitops:8079",
		"BITSWAN_GITOPS_AGENT_SECRET": cfg.CodingAgentSecret,
		"BITSWAN_GIT_REMOTE":          "http://" + ws + "-gitops:8079/git",
	}
	if key := strings.TrimSpace(cfg.EditorSSHPublicKey); key != "" {
		env["EDITOR_SSH_PUBLIC_KEY"] = key
	}
	return env
}

func readWorkspaceSSHPublicKey(workspacePath string) string {
	b, err := os.ReadFile(filepath.Join(workspacePath, "ssh", "id_ed25519.pub"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func envOrDefault(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
