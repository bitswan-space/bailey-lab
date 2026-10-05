package dockerhub

import (
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
	"github.com/bitswan-space/bitswan-workspaces/internal/aocregistry"
)

// fromTheAOC resolves an image against the registry of the AOC this server is
// connected to, rather than Docker Hub.
//
// A server already authenticates to its AOC, and the AOC already knows which
// registry serves it, so there is nothing to configure here. A server that has
// no AOC yet, or whose AOC predates serving images, falls back to Docker Hub:
// that is every server today, and none of them should stop working on the day
// this ships.
func fromTheAOC(repository string) (string, bool) {
	if repository == "" || os.Getenv("BITSWAN_IMAGES_FROM_DOCKER_HUB") != "" {
		return "", false
	}
	client := registryClient()
	if client == nil {
		return "", false
	}
	reference, err := client.Resolve("bitswan/" + repository)
	if err != nil {
		fmt.Fprintf(os.Stderr, "the AOC's registry could not resolve %s (%v); using Docker Hub\n", repository, err)
		return "", false
	}
	return reference, true
}

var (
	cachedClient *aocregistry.Client
	cachedAt     time.Time
	clientLock   sync.Mutex
)

// registryClient is rebuilt occasionally rather than once, so a server that is
// registered, or re-keyed, after this process started picks it up without a
// restart.
func registryClient() *aocregistry.Client {
	clientLock.Lock()
	defer clientLock.Unlock()
	if cachedClient != nil && time.Since(cachedAt) < 5*time.Minute {
		return cachedClient
	}

	// Asks the AOC for credentials the first time, so a server that was
	// registered before images came from the AOC repairs itself on the next
	// pull rather than needing to be registered again by hand.
	host, key, err := aoc.EnsureRegistryAccess(false)
	if err != nil || host == "" || key == "" {
		return nil
	}
	client := aocregistry.New(host, key)
	if err := client.DockerLogin(); err != nil {
		fmt.Fprintf(os.Stderr, "could not sign in to %s (%v); using Docker Hub\n", host, err)
		return nil
	}
	cachedClient = client
	cachedAt = time.Now()
	return cachedClient
}
