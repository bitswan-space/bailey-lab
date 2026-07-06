package daemon

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/dockerhub"
	"github.com/bitswan-space/bitswan-workspaces/internal/workspace"
	"gopkg.in/yaml.v3"
)

// The egress-gateway is a "service" only in a limited sense: it is materialized
// per firewall group by the driver, so it supports just `status` and `update`
// (image bump) — no enable/disable/start/stop.

// currentEgressGatewayImage returns the egress-gateway image the driver is
// currently pinned to (from its BITSWAN_EGRESS_GATEWAY_IMAGE env in the
// workspace's generated core compose), empty when unknown.
func currentEgressGatewayImage(workspaceName string) string {
	composePath := filepath.Join(
		os.Getenv("HOME"), ".config", "bitswan", "workspaces", workspaceName,
		"deployment", "docker-compose.yml",
	)
	data, err := os.ReadFile(composePath)
	if err != nil {
		return ""
	}
	var compose struct {
		Services map[string]struct {
			Environment []string `yaml:"environment"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(data, &compose); err != nil {
		return ""
	}
	for _, e := range compose.Services[workspaceName+"-infra-driver"].Environment {
		if v, ok := strings.CutPrefix(e, "BITSWAN_EGRESS_GATEWAY_IMAGE="); ok {
			return v
		}
	}
	return ""
}

// getInfraServiceStatus reports the pinned egress-gateway image and any active
// per-BP gateway containers.
func (s *Server) getInfraServiceStatus(serviceType, workspace string) (map[string]interface{}, error) {
	switch serviceType {
	case "egress-gateway":
		return map[string]interface{}{
			"service":      "egress-gateway",
			"pinned_image": currentEgressGatewayImage(workspace),
			// Gateways are created per firewall group by the driver on deploy, so
			// there may be zero even when the image is pinned.
			"gateways": listEgressGateways(workspace),
		}, nil
	}
	return nil, fmt.Errorf("unknown infra service: %s", serviceType)
}

// listEgressGateways lists the workspace's running/known egress-gateway
// containers (the driver names them "<ws>-fwgw-…" + a "-proxy" sidecar).
func listEgressGateways(workspace string) []map[string]string {
	out, err := exec.Command("docker", "ps", "-a",
		"--filter", "name="+workspace+"-fwgw-",
		"--format", "{{.Names}}\t{{.Image}}\t{{.State}}").Output()
	if err != nil {
		return nil
	}
	var gws []map[string]string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		f := strings.Split(line, "\t")
		if len(f) != 3 {
			continue
		}
		gws = append(gws, map[string]string{"name": f[0], "image": f[1], "state": f[2]})
	}
	return gws
}

// updateInfraService re-pins the egress-gateway image and regenerates the
// workspace core compose so the driver forwards the new BITSWAN_EGRESS_GATEWAY_IMAGE;
// existing gateways pick it up on the next BP deploy (pull_policy: missing).
// gitops keeps its current pin.
func (s *Server) updateInfraService(serviceType string, req ServiceUpdateRequest) error {
	ws := req.Workspace
	if serviceType != "egress-gateway" {
		return fmt.Errorf("unknown infra service: %s", serviceType)
	}
	img := req.EgressGatewayImage
	if img == "" {
		var err error
		if img, err = dockerhub.ResolveEgressGatewayImage(req.Staging, false); err != nil {
			return fmt.Errorf("failed to resolve egress-gateway image: %w", err)
		}
	}
	// Keep gitops on its current pin; only the egress image changes.
	return workspace.UpdateWorkspaceDeployment(ws, currentGitopsImage(ws), img, req.Staging, false, false)
}
