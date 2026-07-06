//go:build integration

package daemon

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/docker"
	"github.com/bitswan-space/bitswan-workspaces/internal/traefikapi"
)

// cleanup stops and removes the Traefik ingress container and config
func cleanup(t *testing.T) {
	t.Helper()
	exec.Command("docker", "rm", "-f", "traefik").Run()
	exec.Command("docker", "compose", "-p", "bitswan-traefik", "down", "--volumes").Run()
	homeDir := os.Getenv("HOME")
	os.RemoveAll(homeDir + "/.config/bitswan/traefik")
	time.Sleep(2 * time.Second)
}

func waitForHTTP(url string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			resp.Body.Close()
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("timeout waiting for %s", url)
}

// --- Unit-level ingress tests ---

func TestTraefikSetup(t *testing.T) {
	cleanup(t)
	defer cleanup(t)

	docker.EnsureDockerNetwork("bitswan_network", false)

	newlyInitialized, err := initTraefikIngress(true)
	if err != nil {
		t.Fatalf("failed to start Traefik: %v", err)
	}
	if !newlyInitialized {
		t.Error("expected Traefik to be newly initialized")
	}

	if !containerRunning("traefik") {
		t.Error("expected traefik container to be running")
	}

	if err := waitForHTTP("http://localhost:9080/api/overview", 10*time.Second); err != nil {
		t.Fatalf("Traefik API not reachable: %v", err)
	}

	// Add route
	err = addRouteToIngress(IngressAddRouteRequest{
		Hostname: "test-service.bitswan.localhost",
		Upstream: "localhost:9999",
	}, "")
	if err != nil {
		t.Fatalf("failed to add route via Traefik: %v", err)
	}

	// Verify route exists
	routes, err := traefikapi.ListRoutes()
	if err != nil {
		t.Fatalf("failed to list Traefik routes: %v", err)
	}
	found := false
	for _, route := range routes {
		for _, match := range route.Match {
			for _, host := range match.Host {
				if host == "test-service.bitswan.localhost" {
					found = true
				}
			}
		}
	}
	if !found {
		t.Error("route not found in Traefik after adding")
	}

	// Remove route
	err = removeRouteFromIngress("test-service.bitswan.localhost")
	if err != nil {
		t.Fatalf("failed to remove route from Traefik: %v", err)
	}

	// Verify route is gone
	routes, err = traefikapi.ListRoutes()
	if err != nil {
		t.Fatalf("failed to list routes after removal: %v", err)
	}
	for _, route := range routes {
		for _, match := range route.Match {
			for _, host := range match.Host {
				if host == "test-service.bitswan.localhost" {
					t.Error("route still exists after removal")
				}
			}
		}
	}

	// Idempotency
	newlyInitialized, err = initTraefikIngress(false)
	if err != nil {
		t.Fatalf("second init failed: %v", err)
	}
	if newlyInitialized {
		t.Error("expected Traefik to NOT be newly initialized on second call")
	}
}

func TestInitIngress_StartsTraefik(t *testing.T) {
	cleanup(t)
	defer cleanup(t)

	docker.EnsureDockerNetwork("bitswan_network", false)

	newlyInitialized, err := initIngress(false)
	if err != nil {
		t.Fatalf("initIngress failed: %v", err)
	}
	if !newlyInitialized {
		t.Error("expected new initialization")
	}

	if !containerRunning("traefik") {
		t.Error("expected Traefik to be running for new installs")
	}
}
