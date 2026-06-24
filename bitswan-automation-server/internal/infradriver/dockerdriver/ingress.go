package dockerdriver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

// reconcileIngress declaratively converges the workspace's gitops-managed
// ingress routes to exactly `routes` by POSTing the complete set to the daemon's
// /ingress/reconcile. The driver owns this (k8s-style: whatever applies the
// manifests configures the Ingress) — gitops no longer touches routing.
//
// Transport mirrors gitops's utils._ingress_client_and_base: prefer the daemon's
// trusted UNIX socket (access is gated by socket perms, so no token), falling
// back to BITSWAN_INGRESS_URL for socket-less environments. The driver sidecar
// mounts /var/run/bitswan to reach it.
func reconcileIngress(ctx context.Context, workspaceName string, routes []infradriver.Route) error {
	body, err := json.Marshal(ingressReconcileRequest{
		WorkspaceName: workspaceName,
		Routes:        toIngressRoutes(workspaceName, routes),
	})
	if err != nil {
		return err
	}

	client, base := ingressClientAndBase()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/ingress/reconcile", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("ingress reconcile: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("ingress reconcile: daemon returned HTTP %d", resp.StatusCode)
	}
	return nil
}

// ingressClientAndBase returns an HTTP client + base URL for the daemon ingress.
// Prefers the UNIX socket; falls back to the network URL.
func ingressClientAndBase() (*http.Client, string) {
	socket := os.Getenv("BITSWAN_INGRESS_SOCKET")
	if socket == "" {
		socket = "/var/run/bitswan/automation-server.sock"
	}
	if _, err := os.Stat(socket); err == nil {
		return &http.Client{
			Timeout: 180 * time.Second, // first reconcile applies every route (~1s Traefik write each)
			Transport: &http.Transport{
				DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
					return (&net.Dialer{}).DialContext(ctx, "unix", socket)
				},
			},
		}, "http://daemon"
	}
	base := os.Getenv("BITSWAN_INGRESS_URL")
	if base == "" {
		base = "http://bitswan-automation-server-daemon:8080"
	}
	return &http.Client{Timeout: 180 * time.Second}, base
}

// ingressReconcileRequest mirrors daemon.IngressReconcileRequest.
type ingressReconcileRequest struct {
	WorkspaceName string         `json:"workspace_name"`
	Routes        []ingressRoute `json:"routes"`
}

// ingressRoute mirrors the subset of daemon.IngressAddRouteRequest the compiler
// fills (matching gitops's utils.workspace_route route dict).
type ingressRoute struct {
	Hostname       string `json:"hostname"`
	Upstream       string `json:"upstream"`
	WorkspaceName  string `json:"workspace_name"`
	ParentEndpoint string `json:"parent_endpoint,omitempty"`
	Kind           string `json:"kind,omitempty"`
	Stage          string `json:"stage,omitempty"`
}

func toIngressRoutes(workspaceName string, routes []infradriver.Route) []ingressRoute {
	out := make([]ingressRoute, 0, len(routes))
	for _, r := range routes {
		out = append(out, ingressRoute{
			Hostname:       r.Hostname,
			Upstream:       r.Upstream,
			WorkspaceName:  workspaceName,
			ParentEndpoint: r.ParentEndpoint,
			Kind:           r.Kind,
			Stage:          r.Stage,
		})
	}
	return out
}
