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

// The infra-driver and egress-gateway are "services" only in a limited sense:
// the infra-driver is a mandatory core sidecar and the egress-gateway is
// materialized per firewall group by the driver. So they support just `status`
// and `update` (image bump) — no enable/disable/start/stop.

// driverServiceFromCompose reads the infra-driver service's image + environment
// from the workspace's generated core compose (mirrors currentGitopsImage).
func driverServiceFromCompose(workspaceName string) (image string, env []string) {
	composePath := filepath.Join(
		os.Getenv("HOME"), ".config", "bitswan", "workspaces", workspaceName,
		"deployment", "docker-compose.yml",
	)
	data, err := os.ReadFile(composePath)
	if err != nil {
		return "", nil
	}
	var compose struct {
		Services map[string]struct {
			Image       string   `yaml:"image"`
			Environment []string `yaml:"environment"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(data, &compose); err != nil {
		return "", nil
	}
	svc := compose.Services[workspaceName+"-infra-driver"]
	return svc.Image, svc.Environment
}

// currentInfraDriverImage returns the infra-driver image currently pinned in the
// workspace compose (empty when unknown).
func currentInfraDriverImage(workspaceName string) string {
	img, _ := driverServiceFromCompose(workspaceName)
	return img
}

// currentEgressGatewayImage returns the egress-gateway image the driver is
// currently pinned to (from its BITSWAN_EGRESS_GATEWAY_IMAGE env), empty when
// unknown.
func currentEgressGatewayImage(workspaceName string) string {
	_, env := driverServiceFromCompose(workspaceName)
	for _, e := range env {
		if v, ok := strings.CutPrefix(e, "BITSWAN_EGRESS_GATEWAY_IMAGE="); ok {
			return v
		}
	}
	return ""
}

// getInfraServiceStatus reports the runtime state of the infra-driver sidecar or
// the active per-BP egress gateways.
func (s *Server) getInfraServiceStatus(serviceType, workspace string) (map[string]interface{}, error) {
	switch serviceType {
	case "infra-driver":
		name := workspace + "-infra-driver"
		return map[string]interface{}{
			"service":   "infra-driver",
			"container": name,
			"running":   containerRunning(name),
			"image":     currentInfraDriverImage(workspace),
		}, nil
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

// updateInfraService re-pins the infra-driver or egress-gateway image and
// regenerates the workspace core compose (recreating the driver). Only the
// targeted image changes — gitops and the other sidecar keep their current
// pins. For egress-gateway the new image lands on the driver's
// BITSWAN_EGRESS_GATEWAY_IMAGE; existing gateways pick it up on the next BP
// deploy (pull_policy: always).
func (s *Server) updateInfraService(serviceType string, req ServiceUpdateRequest) error {
	ws := req.Workspace
	// Keep the untargeted images stable (fall back to a re-resolve inside
	// UpdateWorkspaceDeployment only when the current value can't be read).
	gitops := currentGitopsImage(ws)
	infra := currentInfraDriverImage(ws)
	egress := currentEgressGatewayImage(ws)

	switch serviceType {
	case "infra-driver":
		img := req.InfraDriverImage
		if img == "" {
			var err error
			if img, err = dockerhub.ResolveInfraDriverImage(req.Staging); err != nil {
				return fmt.Errorf("failed to resolve infra-driver image: %w", err)
			}
		}
		infra = img
	case "egress-gateway":
		img := req.EgressGatewayImage
		if img == "" {
			var err error
			if img, err = dockerhub.ResolveEgressGatewayImage(req.Staging); err != nil {
				return fmt.Errorf("failed to resolve egress-gateway image: %w", err)
			}
		}
		egress = img
	default:
		return fmt.Errorf("unknown infra service: %s", serviceType)
	}

	return workspace.UpdateWorkspaceDeployment(ws, gitops, infra, egress, req.Staging, false)
}
