package daemon

import (
	"bufio"
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// The daemon owns a pair of shared, read-through PACKAGE PROXIES that every
// workspace's per-BP image build routes through: Athens (Go modules) and
// Verdaccio (npm). They live on a dedicated bitswan-build-proxy network and are
// backed by persistent volumes, so a package fetched by ANY build — in any
// workspace — is cached once and served locally to every later build, including
// brand-new BPs whose dependency set doesn't match the prewarmed template. That
// is what makes new image builds fast: the common packages are already local.
//
// Security (per the product's constraints): both are PURE READ-THROUGH. Athens
// runs download-mode=sync (fetch + cache upstream, never accept client
// uploads); Verdaccio has user registration disabled, so publish/unpublish
// (which require auth) can never succeed. Builds join only this network — never
// bitswan_network — so a build can reach the proxies + upstream but no other
// workspace. Client-side integrity (GOSUMDB / npm lockfile) still verifies every
// artifact, so a compromised proxy cannot swap package content. The proxies are
// therefore not a cross-workspace communication or contamination channel.
//
// This is idempotent and cooperative: if the containers already exist (e.g. the
// e2e bringup started them) or the operator has pinned BITSWAN_GOPROXY /
// BITSWAN_NPM_REGISTRY themselves, the daemon leaves those in place. The wiring
// is propagated daemon -> per-workspace infra-driver -> `docker build` via env
// (see dockercompose.buildDriverService); this function sets that env when it is
// the one managing the proxies.

const (
	buildProxyNetwork = "bitswan-build-proxy"
	goProxyContainer  = "bitswan-goproxy"
	npmProxyContainer = "bitswan-npmproxy"
	athensVolume      = "bitswan-athens-storage"
	verdaccioStore    = "bitswan-verdaccio-storage"
	verdaccioConfVol  = "bitswan-verdaccio-conf"
	athensImage       = "gomods/athens:latest"
	verdaccioImage    = "verdaccio/verdaccio:6"
	// The `|` (not `,`) makes Go fall through to `direct` on ANY error, so a
	// down/unreachable Athens degrades to a slower direct build, never a broken
	// one (a comma only falls through on HTTP 404/410).
	goProxyURL     = "http://" + goProxyContainer + ":3000|direct"
	npmRegistryURL = "http://" + npmProxyContainer + ":4873"
)

// verdaccioConfig is a pure read-through npm proxy: publish is unreachable
// (registration disabled => no authenticated users), the web UI is off, and the
// only uplink is the public registry. Kept in lockstep with
// e2e/build-proxy/verdaccio.yaml.
const verdaccioConfig = `storage: /verdaccio/storage
web:
  enable: false
auth:
  htpasswd:
    file: /verdaccio/conf/htpasswd
    max_users: -1
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
    cache: true
    maxage: 30m
packages:
  '@*/*':
    access: $all
    publish: $authenticated
    proxy: npmjs
  '**':
    access: $all
    publish: $authenticated
    proxy: npmjs
log: { type: stdout, format: pretty, level: warn }
`

// containerExists reports whether a container of the given name is present (in
// any state) on the host docker daemon.
func containerExists(name string) bool {
	out, err := exec.Command("docker", "inspect", "--type", "container", "--format", "{{.State.Running}}", name).Output()
	if err != nil {
		return false
	}
	running := strings.TrimSpace(string(out)) == "true"
	if !running {
		// Present but stopped — start it so restarts of the daemon recover it.
		_ = exec.Command("docker", "start", name).Run()
	}
	return true
}

// startBuildProxies brings up the shared read-through package proxies unless
// they are already managed externally (containers present, or the operator has
// pinned the proxy env). Runs in the BACKGROUND (image pulls would otherwise
// block daemon startup) and — crucially — only wires the build env AFTER both
// proxies report HEALTHY. That ordering matters: npm has no fallback like
// GOPROXY's `|direct`, so pointing NPM_CONFIG_REGISTRY at a not-yet-ready
// Verdaccio would fail early builds. Until the proxies are healthy, builds go
// direct (correct, just not accelerated). If they never come healthy, the env
// is never set and builds stay direct — never broken.
func startBuildProxies() {
	// Respect an operator-pinned Go proxy: if BITSWAN_GOPROXY is already set we
	// assume the whole proxy setup is externally managed (operator or e2e
	// bringup) and do nothing — including not touching the env below.
	if os.Getenv("BITSWAN_GOPROXY") != "" {
		return
	}
	go func() {
		// Dedicated network (idempotent — ignore "already exists" / pool errors;
		// if it can't be created the proxies won't come up and builds go direct).
		_ = exec.Command("docker", "network", "create", buildProxyNetwork).Run()

		// Go module proxy (Athens). ATHENS_STORAGE_TYPE=disk REQUIRES an existing
		// storage root — the image default is a `/path/on/disk` placeholder that
		// does not exist, so we set ATHENS_DISK_STORAGE_ROOT + back it with a
		// persistent volume (the cache that accumulates common modules). A
		// healthcheck lets us wait for readiness via docker events below.
		if !containerExists(goProxyContainer) {
			_ = exec.Command("docker", "volume", "create", athensVolume).Run()
			if out, err := exec.Command("docker", "run", "-d",
				"--name", goProxyContainer, "--network", buildProxyNetwork,
				"--restart", "unless-stopped",
				"--health-cmd", "wget -qO- http://localhost:3000/healthz || exit 1",
				"--health-interval", "3s", "--health-retries", "20", "--health-start-period", "2s",
				"-e", "ATHENS_DOWNLOAD_MODE=sync",
				"-e", "ATHENS_STORAGE_TYPE=disk",
				"-e", "ATHENS_DISK_STORAGE_ROOT=/var/lib/athens",
				"-v", athensVolume+":/var/lib/athens",
				athensImage).CombinedOutput(); err != nil {
				fmt.Printf("Warning: could not start Go module proxy: %v: %s\n", err, strings.TrimSpace(string(out)))
			}
		}

		// npm registry proxy (Verdaccio). Seed its config into a volume via a
		// throwaway container, then run with persistent storage. Run as root so it
		// can write the (root-owned) named volumes for its cache + htpasswd.
		if !containerExists(npmProxyContainer) {
			_ = exec.Command("docker", "volume", "create", verdaccioStore).Run()
			_ = exec.Command("docker", "volume", "create", verdaccioConfVol).Run()
			// Seed config.yaml into the conf volume via a throwaway container
			// (base64 to dodge shell-quoting of the YAML). busybox ships base64 -d.
			b64 := base64.StdEncoding.EncodeToString([]byte(verdaccioConfig))
			if out, err := exec.Command("docker", "run", "--rm",
				"-v", verdaccioConfVol+":/conf", "busybox", "sh", "-c",
				"echo "+b64+" | base64 -d > /conf/config.yaml").CombinedOutput(); err != nil {
				fmt.Printf("Warning: could not seed npm proxy config: %v: %s\n", err, strings.TrimSpace(string(out)))
			}
			if out, err := exec.Command("docker", "run", "-d",
				"--name", npmProxyContainer, "--network", buildProxyNetwork,
				"--restart", "unless-stopped", "--user", "0",
				"--health-cmd", "wget -qO- http://localhost:4873/-/ping || exit 1",
				"--health-interval", "3s", "--health-retries", "20", "--health-start-period", "3s",
				"-v", verdaccioConfVol+":/verdaccio/conf",
				"-v", verdaccioStore+":/verdaccio/storage",
				verdaccioImage).CombinedOutput(); err != nil {
				fmt.Printf("Warning: could not start npm registry proxy: %v: %s\n", err, strings.TrimSpace(string(out)))
			}
		}

		// Wire the build path to the proxies ONLY once both are healthy (see the
		// doc comment: npm has no direct fallback). buildDriverService +
		// dockerdriver.BuildImage read these from the environment at deploy time.
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		if !waitContainerHealthy(ctx, goProxyContainer) || !waitContainerHealthy(ctx, npmProxyContainer) {
			fmt.Println("Warning: build proxies did not become healthy; per-BP builds will fetch packages directly")
			return
		}
		_ = os.Setenv("BITSWAN_BUILD_NETWORK", buildProxyNetwork)
		_ = os.Setenv("BITSWAN_GOPROXY", goProxyURL)
		_ = os.Setenv("BITSWAN_NPM_REGISTRY", npmRegistryURL)
		fmt.Println("Shared read-through build proxies ready (Athens + Verdaccio, daemon-managed)")
	}()
}

// waitContainerHealthy blocks until the named container reports healthy, or ctx
// expires. It subscribes to docker health-status events (no polling / sleeps),
// with an inspect both before subscribing and immediately after (to close the
// race where the container became healthy in between).
func waitContainerHealthy(ctx context.Context, name string) bool {
	if containerHealthy(name) {
		return true
	}
	cmd := exec.CommandContext(ctx, "docker", "events",
		"--filter", "type=container", "--filter", "container="+name,
		"--filter", "event=health_status", "--format", "{{.Status}}")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return false
	}
	if err := cmd.Start(); err != nil {
		return false
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	if containerHealthy(name) { // became healthy between the check above and subscribing
		return true
	}
	sc := bufio.NewScanner(stdout)
	for sc.Scan() {
		if line := sc.Text(); strings.Contains(line, "healthy") && !strings.Contains(line, "unhealthy") {
			return true
		}
	}
	return false
}

// containerHealthy reports whether the container's healthcheck currently reads
// "healthy". False for a missing container or one without a healthcheck.
func containerHealthy(name string) bool {
	out, err := exec.Command("docker", "inspect", "--format",
		"{{if .State.Health}}{{.State.Health.Status}}{{end}}", name).Output()
	return err == nil && strings.TrimSpace(string(out)) == "healthy"
}
