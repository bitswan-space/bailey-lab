// Package images says which image each service should run.
//
// Every answer comes from the registry of the AOC this server is connected to.
// There is no public fallback: a server that cannot reach its AOC's registry
// is told so, rather than quietly pulling something else from somewhere its
// operator did not choose and cannot see.
package images

import (
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
	"github.com/bitswan-space/bitswan-workspaces/internal/aocregistry"
)

const (
	GitopsRepository        = "gitops"
	DashboardRepository     = "workspace-dashboard"
	CodingAgentRepository   = "coding-agent"
	EgressGatewayRepository = "egress-gateway"
	InfraDriverRepository   = "infra-driver"
)

// imageOverride returns an image pinned through the environment, or "".
// The one way to name an image by hand, for a local build or an air-gapped
// install whose registry is not the AOC's.
func imageOverride(envVar string) string {
	return os.Getenv(envVar)
}

var (
	cachedClient *aocregistry.Client
	cachedAt     time.Time
	clientLock   sync.Mutex
)

// Registry is the client for this server's AOC, rebuilt occasionally so a
// server registered or re-keyed after this process started picks it up
// without a restart.
func Registry() (*aocregistry.Client, error) {
	clientLock.Lock()
	defer clientLock.Unlock()
	if cachedClient != nil && time.Since(cachedAt) < 5*time.Minute {
		return cachedClient, nil
	}

	// Asks the AOC for credentials the first time, so a server registered
	// before images came from the AOC repairs itself on the next pull rather
	// than having to be registered again by hand.
	host, key, err := aoc.EnsureRegistryAccess(false)
	if err != nil {
		return nil, fmt.Errorf("this server has no access to its AOC's registry: %w", err)
	}
	client := aocregistry.New(host, key)
	if err := client.DockerLogin(); err != nil {
		return nil, err
	}
	cachedClient = client
	cachedAt = time.Now()
	return cachedClient, nil
}

// track is the repository a build track maps to.
//
// A dev image is built on the machine it runs on and published nowhere, so it
// is named directly and never looked up.
func track(repository string, staging bool) string {
	if staging {
		return repository + "-staging"
	}
	return repository
}

func resolve(envVar, repository string, staging, dev bool) (string, error) {
	if img := imageOverride(envVar); img != "" {
		return img, nil
	}
	if dev {
		return "bitswan/" + repository + "-dev:latest", nil
	}
	registry, err := Registry()
	if err != nil {
		return "", err
	}
	return registry.Resolve("bitswan/" + track(repository, staging))
}

// LatestBuild is the build tag a repository's :latest currently points at.
func LatestBuild(repository string, staging bool) (string, error) {
	registry, err := Registry()
	if err != nil {
		return "", err
	}
	reference, err := registry.Resolve("bitswan/" + track(repository, staging))
	if err != nil {
		return "", err
	}
	for i := len(reference) - 1; i >= 0; i-- {
		if reference[i] == ':' {
			return reference[i+1:], nil
		}
	}
	return "", fmt.Errorf("%s names no build", reference)
}

func ResolveGitopsImage(staging, dev bool) (string, error) {
	return resolve("BITSWAN_GITOPS_IMAGE", GitopsRepository, staging, dev)
}

func ResolveDashboardImage(staging, dev bool) (string, error) {
	return resolve("BITSWAN_DASHBOARD_IMAGE", DashboardRepository, staging, dev)
}

func ResolveCodingAgentImage(staging, dev bool) (string, error) {
	return resolve("BITSWAN_CODING_AGENT_IMAGE", CodingAgentRepository, staging, dev)
}

func ResolveEgressGatewayImage(staging, dev bool) (string, error) {
	return resolve("BITSWAN_EGRESS_GATEWAY_IMAGE", EgressGatewayRepository, staging, dev)
}

func ResolveInfraDriverImage(staging, dev bool) (string, error) {
	return resolve("BITSWAN_INFRA_DRIVER_IMAGE", InfraDriverRepository, staging, dev)
}
