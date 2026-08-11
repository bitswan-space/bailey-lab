package dockercompose

import (
	"bytes"
	"fmt"
	"os"
	"runtime"
	"sort"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/certauthority"
	"github.com/dchest/uniuri"
	"gopkg.in/yaml.v3"
)

type OS int

const (
	WindowsMac OS = iota
	Linux
)

// GrypeDBVolume is the shared, external Docker volume that holds grype's
// vulnerability DB. The automation-server daemon downloads + refreshes it (once
// per host per day) and every workspace's gitops container mounts it read-only,
// so the DB download never lands on a workspace's first interactive CVE scan.
const GrypeDBVolume = "bitswan-grype-db"

// GitopsDevSourceMount is where a developer's live bitswan-gitops checkout is
// bind-mounted inside the gitops container, shadowing the copy the image bakes
// there. The gitops image ALSO ships a /src (pyproject.toml + app/, see
// bitswan-gitops/Dockerfile), so the presence of /src proves nothing — dev mode
// must be declared explicitly via BITSWAN_GITOPS_DEV_SOURCE, which is set right
// next to this mount so the two cannot drift apart.
const GitopsDevSourceMount = "/src"

// DockerComposeConfig holds the configuration required for creating a docker-compose file
type DockerComposeConfig struct {
	GitopsPath         string
	WorkspaceName      string
	GitopsImage        string
	InfraDriverImage   string // resolved infra-driver image; falls back to env/:latest when empty
	EgressGatewayImage string // resolved egress-gateway image the driver pins for per-BP gateways
	Domain             string
	AocEnvVars         []string
	GitopsDevSourceDir string
	TrustCA            bool
	LocalRemotePath    string // Host path to local repository (if using local remote)
	LocalRemoteName    string // Mount name for local repository (used for mount point path)
	CodingAgentSecret  string // Bearer token gitops uses to verify coding-agent requests
	// InfraDriverToken authenticates callers of the workspace's infra-driver.
	// Set it to reuse an existing token (from metadata.yaml) across re-renders;
	// left empty, a fresh one is generated and written back to this field so
	// the caller can persist it.
	InfraDriverToken string
}

// CreateDockerComposeFile creates a docker-compose YAML content and returns it along with the generated secret token
func (config *DockerComposeConfig) CreateDockerComposeFile() (string, string, error) {
	return config.CreateDockerComposeFileWithSecret("")
}

// CreateDockerComposeFileWithSecret creates a docker-compose YAML content with an optional existing secret
func (config *DockerComposeConfig) CreateDockerComposeFileWithSecret(existingSecret string) (string, string, error) {
	// Workspace data lives inside the named `bitswan` Docker volume at
	// workspaces/<name>/... — mounted via compose long-form volume + subpath.
	// The host docker daemon resolves the named volume directly, so there's no
	// container→host path translation to apply here anymore.
	homeDir := os.Getenv("HOME")

	// wsVolume builds a long-form named-volume subpath mount entry for this
	// workspace's data subtree inside the external `bitswan` volume.
	wsSubpath := func(subdir string) string {
		return "workspaces/" + config.WorkspaceName + "/" + subdir
	}
	wsVolume := func(subdir, target string) map[string]interface{} {
		return map[string]interface{}{
			"type":   "volume",
			"source": "bitswan",
			"target": target,
			"volume": map[string]interface{}{
				"subpath": wsSubpath(subdir),
			},
		}
	}

	gitConfig := os.Getenv("HOME") + "/.gitconfig"

	hostOsTmp := runtime.GOOS

	var hostOs OS
	switch hostOsTmp {
	case "windows", "darwin":
		hostOs = WindowsMac
	case "linux":
		hostOs = Linux
	default:
		return "", "", fmt.Errorf("unsupported host OS: %s", hostOsTmp)
	}

	// Use existing secret if provided, otherwise generate a new one
	var gitopsSecretToken string
	if existingSecret != "" {
		gitopsSecretToken = existingSecret
	} else {
		gitopsSecretToken = uniuri.NewLen(64)
	}

	// The infra-driver gets its OWN token, distinct from the gitops API secret:
	// a leak of the gitops secret does not grant driver (push + exec =
	// docker.sock) access, and vice versa. Reused across re-renders when the
	// caller provides it (persisted in metadata.yaml so the daemon can call the
	// driver for server-level backups); generated and handed back otherwise.
	if config.InfraDriverToken == "" {
		config.InfraDriverToken = uniuri.NewLen(64)
	}
	driverToken := config.InfraDriverToken

	gitopsService := map[string]interface{}{
		"image":    config.GitopsImage,
		"restart":  "always",
		"hostname": config.WorkspaceName + "-gitops",
		// Labelled with the workspace so the driver permits gitops's scoped
		// self-exec (root cleanup of copy trees) — the driver refuses any
		// container not carrying this workspace label.
		"labels": map[string]string{"gitops.workspace": config.WorkspaceName},
		// bitswan_network: the control-plane inner ring (daemon, infra-driver, …).
		// <ws>-agent: a dedicated bridge shared ONLY with this workspace's coding
		// agent, so the (untrusted) agent reaches gitops's authenticated API/git
		// WITHOUT being on bitswan_network. gitops is multi-homed; it does not
		// route between the two, so the agent gains no path to the inner ring.
		"networks": []string{"bitswan_network", config.WorkspaceName + "-agent"},
		"volumes": []interface{}{
			wsVolume("gitops", "/gitops/gitops"),
			wsVolume("secrets", "/gitops/secrets"),
			// Per-BP stage snapshots (app/services/snapshot_service.py).
			// /gitops itself is the container's writable layer, so anything
			// not bind-mounted there is lost on container recreation.
			wsVolume("snapshots", "/gitops/snapshots"),
			// Egress-firewall attempt telemetry. The per-BP egress gateways
			// (a separate container per firewalled group) append observed/blocked
			// hosts here; the gitops dashboard reads it for the "Needs review"
			// feed. Both sides must point at the SAME volume subpath, so mount it
			// into gitops at the path firewall_service.firewall_dir() resolves to
			// (/gitops/firewall) — otherwise gitops would read its container-local
			// layer while the gateways write the volume, and the feed stays empty.
			wsVolume("firewall", "/gitops/firewall"),
			wsVolume("ssh", "/home/user1000/.ssh"),
			// NO docker.sock: after the infra-driver cut-over gitops never
			// touches Docker — it pushes bitswan.yaml to the driver and calls
			// the driver's scoped primitives. The driver sidecar is the only
			// container with the socket.
			"/var/run/bitswan:/var/run/bitswan",
		},
		"environment": []string{
			"BITSWAN_GITOPS_DIR=/gitops",
			"BITSWAN_GITOPS_DIR_HOST=" + config.GitopsPath,
			"BITSWAN_GITOPS_SECRET=" + gitopsSecretToken,
			"BITSWAN_GITOPS_DOMAIN=" + config.Domain,
			"BITSWAN_WORKSPACE_NAME=" + config.WorkspaceName,
			"BITSWAN_CERTS_DIR=" + homeDir + "/.config/bitswan/certauthorities",
			// The named Docker volume that backs all workspace data. gitops uses
			// this (+ BITSWAN_WORKSPACE_NAME) to mount business-process containers
			// off the volume via subpaths instead of host bind paths.
			"BITSWAN_VOLUME_NAME=bitswan",
			// Per-BP canonical bare repos (<bp>.git, served over smart-HTTP,
			// fast-forward only) and the per-copy checkouts under the
			// workspace-repo dir. Keeping copies at <workspace-repo>/copies
			// makes a deployment's workspace-root-relative path
			// ("copies/<copy>/<rel>") resolve correctly both as a
			// container-local path (join with BITSWAN_WORKSPACE_REPO_DIR) and
			// as a volume subpath (workspaces/<ws>/<rel-path>). The `main`
			// copy is the default scope. BITSWAN_GIT_REMOTE is the BASE URL:
			// each BP clone's origin is <base>/<bp>.git.
			"BITSWAN_GIT_REPOS_DIR=/git",
			"BITSWAN_WORKSPACE_REPO_DIR=/workspace-repo",
			"BITSWAN_COPIES_DIR=/workspace-repo/copies",
			"BITSWAN_GIT_REMOTE=http://" + config.WorkspaceName + "-gitops:8079/git",
		},
	}

	// Authoritative coding-agent secret. With this set in gitops' env,
	// verify_agent_token resolves directly from os.environ instead of
	// falling back to `docker inspect` on the agent container — which
	// would otherwise cache the first secret seen for the lifetime of
	// the gitops process and reject any subsequent re-issued secret.
	if config.CodingAgentSecret != "" {
		gitopsService["environment"] = append(gitopsService["environment"].([]string),
			"BITSWAN_GITOPS_AGENT_SECRET="+config.CodingAgentSecret,
		)
	}

	// Append AOC env variables when workspace is registered as an automation server
	if len(config.AocEnvVars) > 0 {
		gitopsService["environment"] = append(gitopsService["environment"].([]string), config.AocEnvVars...)
	}

	// gitops live-dev: bind-mount the developer's checkout over the image's
	// baked /src AND declare it explicitly via BITSWAN_GITOPS_DEV_SOURCE.
	// Both happen here, in one place, so the mount and the declaration can
	// never drift apart: start.sh keys hot-reload + `pip install -e` off the
	// env var alone and must never infer dev mode from /src existing (the
	// image bakes a /src into every build, production included — inferring
	// from it silently ran every production container under the uvicorn
	// reload supervisor).
	if config.GitopsDevSourceDir != "" {
		gitopsService["volumes"] = append(gitopsService["volumes"].([]interface{}), config.GitopsDevSourceDir+":"+GitopsDevSourceMount+":z")
		gitopsService["environment"] = append(gitopsService["environment"].([]string),
			"BITSWAN_GITOPS_DEV_SOURCE="+GitopsDevSourceMount,
			"DEBUG=true",
		)
	}

	// Mount certificate authorities if specified
	caVolumes, caEnvVars := certauthority.GetCACertMountConfig(config.TrustCA)
	if len(caVolumes) > 0 {
		for _, v := range caVolumes {
			gitopsService["volumes"] = append(gitopsService["volumes"].([]interface{}), v)
		}
		gitopsService["environment"] = append(gitopsService["environment"].([]string), caEnvVars...)
	}

	// Mount the per-BP bare repos dir (each <bp>.git served over smart-HTTP)
	// and the per-copy checkouts (the deploy unit). These replace the old
	// shared workspace working-tree mount + single canonical repo.
	gitopsService["volumes"] = append(gitopsService["volumes"].([]interface{}),
		wsVolume("git-repos", "/git"),
		wsVolume("copies", "/workspace-repo/copies"),
	)

	// Shared, daemon-managed grype vulnerability DB (see daemon.grypeDBVolume).
	// The automation-server daemon downloads + refreshes the DB once per host per
	// day into this volume; every workspace mounts it READ-ONLY, so the ~40s DB
	// download never happens on a workspace's first (interactive) CVE scan, and
	// no workspace can corrupt or poison the shared DB. gitops points grype at it
	// via GRYPE_DB_CACHE_DIR and skips `grype db update` (BITSWAN_GRYPE_DB_MANAGED)
	// since the mount is read-only and the daemon owns updates.
	gitopsService["volumes"] = append(gitopsService["volumes"].([]interface{}),
		GrypeDBVolume+":/grype-db:ro",
	)
	gitopsService["environment"] = append(gitopsService["environment"].([]string),
		"GRYPE_DB_CACHE_DIR=/grype-db",
		"BITSWAN_GRYPE_DB_MANAGED=1",
	)
	if hostOs == WindowsMac {
		gitopsService["volumes"] = append(gitopsService["volumes"].([]interface{}),
			gitConfig+":/root/.gitconfig:z",
		)
	}

	// The infra-driver sidecar: the only container that touches docker.sock
	// after the cut-over. gitops `git push`es the resolved bitswan.yaml to the
	// driver's deploy repo (smart-HTTP, hook compiles + applies) and calls its
	// /v1 primitives — so gitops itself needs no Docker access. The driver runs
	// the same daemon runtime image (docker CLI + compose + git-http-backend),
	// with the bitswan binary bind-mounted exactly as the daemon mounts its own.
	gitopsService["environment"] = append(gitopsService["environment"].([]string),
		"BITSWAN_INFRA_DRIVER_URL=http://"+config.WorkspaceName+"-infra-driver:9090",
		"BITSWAN_INFRA_DRIVER_TOKEN="+driverToken,
		// Per-BP deploy repos: each BP pushes to <base>/<bp>.deploy.git.
		"BITSWAN_DEPLOY_REMOTE_BASE=http://x:"+driverToken+"@"+config.WorkspaceName+"-infra-driver:9090/deploy-repos",
	)

	driverService := config.buildDriverService(driverToken, wsVolume, homeDir)

	// Construct the docker-compose data structure
	dockerCompose := map[string]interface{}{
		"version": "3.8",
		"services": map[string]interface{}{
			"bitswan-gitops":                       gitopsService,
			config.WorkspaceName + "-infra-driver": driverService,
		},
		"networks": map[string]interface{}{
			"bitswan_network": map[string]interface{}{
				"external": true,
			},
			// Dedicated agent↔gitops bridge (ensured before this compose comes up,
			// in workspace init + UpdateWorkspaceDeployment). External so both this
			// compose and the separate coding-agent compose reference the same net.
			config.WorkspaceName + "-agent": map[string]interface{}{
				"external": true,
			},
		},
		"volumes": map[string]interface{}{
			"bitswan": map[string]interface{}{
				"external": true,
			},
			// Daemon-owned shared grype DB volume (created by the daemon before any
			// workspace comes up); mounted read-only into gitops above.
			GrypeDBVolume: map[string]interface{}{
				"external": true,
			},
		},
	}

	var buf bytes.Buffer

	// Serialize the docker-compose data structure to YAML and write it to the file
	encoder := yaml.NewEncoder(&buf)
	encoder.SetIndent(2) // Optional: Set indentation
	if err := encoder.Encode(dockerCompose); err != nil {
		return "", "", fmt.Errorf("failed to encode docker-compose data structure: %w", err)
	}

	return buf.String(), gitopsSecretToken, nil
}

// buildDriverService builds the infra-driver sidecar: its own self-contained
// image (docker CLI + compose + git-http-backend + syft, with the infra-driver
// binary baked in — NOT the bitswan CLI), docker.sock, and the workspace volume
// subpaths the compiler reads/writes. It serves the per-BP deploy repos over git
// smart-HTTP + the /v1 primitives, guarded by the shared token.
func (config *DockerComposeConfig) buildDriverService(token string, wsVolume func(string, string) map[string]interface{}, homeDir string) map[string]interface{} {
	// Prefer the version resolved at init (config.InfraDriverImage). Fall back to
	// the env override / :latest only when unset.
	driverImage := config.InfraDriverImage
	if driverImage == "" {
		driverImage = os.Getenv("BITSWAN_INFRA_DRIVER_IMAGE")
	}
	if driverImage == "" {
		driverImage = "bitswan/infra-driver:latest"
	}

	env := []string{
		"BITSWAN_INFRA_DRIVER_TOKEN=" + token,
		"BITSWAN_VOLUME_NAME=bitswan",
		"BITSWAN_GITOPS_DIR_HOST=" + config.GitopsPath,
		"BITSWAN_CERTS_DIR=" + homeDir + "/.config/bitswan/certauthorities",
		"BITSWAN_WORKSPACE_NAME=" + config.WorkspaceName,
	}
	// Pin the egress-gateway image the compiler stamps into every BP's firewall
	// workers so the compose references an IMMUTABLE tag. That lets the gateway
	// services use pull_policy: missing — pulled once when the version changes,
	// never re-pulled or churned — instead of the old pull_policy: always. Prefer
	// the version resolved at init (config.EgressGatewayImage); fall back to the
	// BITSWAN_EGRESS_GATEWAY_IMAGE env override, else the compiler's own default.
	egressImage := config.EgressGatewayImage
	if egressImage == "" {
		egressImage = os.Getenv("BITSWAN_EGRESS_GATEWAY_IMAGE")
	}
	if egressImage != "" {
		env = append(env, "BITSWAN_EGRESS_GATEWAY_IMAGE="+egressImage)
	}
	// Route per-BP image builds through the automation-server's shared
	// read-through package proxies when they're configured (see
	// dockerdriver.BuildImage). Propagated from the daemon's own env so a
	// deployment WITHOUT proxies builds directly (empty ⇒ no-op, current
	// behaviour). The proxies are pure read-through (no client writes), so they
	// can't be a cross-workspace channel, and BITSWAN_BUILD_NETWORK is a proxy-only
	// network so a build can't reach other workspaces.
	for _, k := range []string{"BITSWAN_BUILD_NETWORK", "BITSWAN_GOPROXY", "BITSWAN_NPM_REGISTRY"} {
		if v := os.Getenv(k); v != "" {
			env = append(env, k+"="+v)
		}
	}
	// The compiler reads the same AOC env gitops used (org group path, etc.).
	env = append(env, config.AocEnvVars...)

	volumes := []interface{}{
		"/var/run/docker.sock:/var/run/docker.sock",
		// The daemon ingress socket — the driver configures ingress itself
		// (converges routes via /ingress/reconcile) after bringing the project up.
		"/var/run/bitswan:/var/run/bitswan",
		wsVolume("deploy-repos", "/git/deploy-repos"),
		// The deployed tree the generated compose's bind-mounts reference
		// (workspaces/<ws>/gitops/<source>); apply materializes the push here.
		wsVolume("gitops", "/gitops/gitops"),
		// The per-copy workspace checkouts (same mount gitops uses). The
		// compiler resolves each deployment's automation.toml (expose/port/
		// services) from here when the source is baked into the image and so
		// has no <checksum>/ tree on the gitops volume — a deployment's
		// relative_path is always "copies/<copy>/<rel>". Without this the
		// compiler falls back to defaults (expose=false) and never emits the
		// frontend's ingress route, so the endpoint 404s.
		wsVolume("copies", "/workspace-repo/copies"),
		wsVolume("secrets", "/gitops/secrets"),
		wsVolume("snapshots", "/gitops/snapshots"),
		wsVolume("firewall", "/gitops/firewall"),
	}
	caVolumes, caEnvVars := certauthority.GetCACertMountConfig(config.TrustCA)
	for _, v := range caVolumes {
		volumes = append(volumes, v)
	}
	env = append(env, caEnvVars...)

	return map[string]interface{}{
		"image":       driverImage,
		"restart":     "always",
		"hostname":    config.WorkspaceName + "-infra-driver",
		"networks":    []string{"bitswan_network"},
		"volumes":     volumes,
		"environment": env,
		"command": []string{
			"/usr/local/bin/infra-driver", "serve",
			"--listen", ":9090",
			"--deploy-repos-dir", "/git/deploy-repos",
			"--gitops-dir", "/gitops/gitops",
			"--secrets-dir", "/gitops/secrets",
			"--workspace", config.WorkspaceName,
			"--domain", config.Domain,
		},
	}
}

// CreateTraefikDockerComposeFile creates a docker-compose file for global Traefik.
// env, when non-nil, is added to the traefik service environment (used to
// configure lego's httpreq DNS-01 provider for wildcard certificates).
// networks parameter is optional - if provided, adds those networks along with bitswan_network.
func CreateTraefikDockerComposeFile(traefikPath string, env map[string]string, networks ...string) (string, error) {
	// Traefik's config lives in the daemon's config volume at
	// <volume>/traefik/... (the daemon mounts the `bitswan` volume at
	// /root/.config/bitswan). Mount those files into Traefik as named-volume
	// subpaths rather than host bind paths — with the config in the volume there
	// is no host file to bind, and Docker would otherwise auto-create the missing
	// source as an empty directory (Traefik then fails: "traefik.yml is a
	// directory"). The docker socket stays a bind.
	tVolume := func(subpath, target string) map[string]interface{} {
		return map[string]interface{}{
			"type":   "volume",
			"source": "bitswan",
			"target": target,
			"volume": map[string]interface{}{
				"subpath": "traefik/" + subpath,
			},
		}
	}
	traefikVolumes := []interface{}{
		tVolume("traefik.yml", "/etc/traefik/traefik.yml"),
		tVolume("dynamic.yml", "/etc/traefik/dynamic.yml"),
		tVolume("certs", "/tls"),
		tVolume("acme", "/acme"),
		"/var/run/docker.sock:/var/run/docker.sock:ro",
	}

	traefikNetworks := []string{"bitswan_network"}
	traefikNetworks = append(traefikNetworks, networks...)

	networksMap := map[string]interface{}{
		"bitswan_network": map[string]interface{}{
			"external": true,
		},
	}
	for _, network := range networks {
		networksMap[network] = map[string]interface{}{
			"external": true,
		}
	}

	traefikService := map[string]interface{}{
		"image":          "traefik:v3.6",
		"restart":        "always",
		"container_name": "traefik",
		// Only the public web entrypoints are published. Traefik's API/dashboard is
		// DISABLED outright in the static config (renderTraefikStaticConfig) — the
		// daemon manages every route via the file provider, so the HTTP API is
		// unused. Publishing ONLY 80/443 (never the admin :8080/:9080) is the second
		// layer of defence: even a mistaken port-publish cannot leak the routing
		// topology, because nothing is listening on the admin port.
		"ports":    []string{"80:80", "443:443"},
		"networks": traefikNetworks,
		"volumes":  traefikVolumes,
	}
	if len(env) > 0 {
		// Sorted for deterministic output — the daemon compares the rendered
		// compose file against the one on disk to detect config drift.
		keys := make([]string, 0, len(env))
		for key := range env {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		envList := make([]string, 0, len(env))
		for _, key := range keys {
			envList = append(envList, fmt.Sprintf("%s=%s", key, env[key]))
		}
		traefikService["environment"] = envList
	}

	dockerCompose := map[string]interface{}{
		"version": "3.8",
		"services": map[string]interface{}{
			"traefik": traefikService,
		},
		"networks": networksMap,
		"volumes": map[string]interface{}{
			"bitswan": map[string]interface{}{
				"external": true,
			},
		},
	}

	var buf bytes.Buffer
	encoder := yaml.NewEncoder(&buf)
	encoder.SetIndent(2)
	if err := encoder.Encode(dockerCompose); err != nil {
		return "", fmt.Errorf("failed to encode docker-compose data structure: %w", err)
	}

	return buf.String(), nil
}

// ProtectedProxyTemplatesTarget is where the proxy's custom sign-in/error page
// templates are mounted inside the container. The daemon points
// OAUTH2_PROXY_CUSTOM_TEMPLATES_DIR at it (protectedProxyOAuthEnv) and writes
// the files into the source subpath below (protectedProxyTemplatesSubpath).
const ProtectedProxyTemplatesTarget = "/etc/bitswan-templates"

// protectedProxyTemplatesSubpath is the templates directory's location inside
// the daemon's `bitswan` config volume — i.e. ~/.config/bitswan/<subpath> as the
// daemon sees it.
const protectedProxyTemplatesSubpath = "protected-proxy/templates"

// CreateProtectedProxyDockerComposeFile creates a docker-compose file for the
// shared bitswan-protected-proxy (an oauth2-proxy instance). It sits between
// platform-traefik and the daemon's protected gate: Traefik routes every
// protected hostname to bitswan-protected-proxy:80, the proxy authenticates the
// request against Keycloak and forwards the identity headers to the gate
// (upstream). Every oauth2-proxy setting comes from env (the upstream image's
// entrypoint is /bin/oauth2-proxy with no args), so the proxy publishes no
// ports — Traefik reaches it over bitswan_network — and mounts nothing but its
// page templates.
//
// env is the full OAUTH2_PROXY_* map; it's rendered sorted for deterministic
// output so the daemon can compare against the on-disk file to detect drift.
func CreateProtectedProxyDockerComposeFile(env map[string]string) (string, error) {
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	envList := make([]string, 0, len(env))
	for _, key := range keys {
		envList = append(envList, fmt.Sprintf("%s=%s", key, env[key]))
	}

	// The Bailey-branded sign-in error page (internal/daemon
	// protected_proxy_error_page.go) replaces oauth2-proxy's stock "500 — Oops!
	// Something went wrong". The daemon writes it into its own config volume, so
	// like Traefik's config this is mounted as a named-volume SUBPATH, not a host
	// bind: there is no host path for a file that lives in a volume, and Docker
	// would silently auto-create the missing bind source as an empty directory.
	// Only the templates subpath is exposed — never the whole volume, which holds
	// bailey.db, the workspace secrets and this proxy's cookie secret.
	//
	// The mount is deliberately strict: Docker refuses to start the container when
	// the subpath is missing, so a proxy that lost its templates fails loudly
	// instead of falling back to the stock page (which, with
	// show_debug_on_error on, would print raw internal errors to the browser).
	proxyService := map[string]interface{}{
		"image":          "quay.io/oauth2-proxy/oauth2-proxy:v7.15.3",
		"restart":        "always",
		"container_name": "bitswan-protected-proxy",
		"networks":       []string{"bitswan_network", "protected-proxy-session"},
		"environment":    envList,
		"depends_on":     []string{"bitswan-protected-proxy-redis"},
		"volumes": []interface{}{
			map[string]interface{}{
				"type":      "volume",
				"source":    "bitswan",
				"target":    ProtectedProxyTemplatesTarget,
				"read_only": true,
				"volume": map[string]interface{}{
					"subpath": protectedProxyTemplatesSubpath,
				},
			},
		},
	}

	// Redis session store. oauth2-proxy holds a per-session refresh LOCK in
	// redis, so concurrent requests can't refresh the same token at once — the
	// first refreshes, the rest wait and use the rotated token. Without this,
	// single-use refresh-token rotation (revokeRefreshToken) self-destructs: a
	// browser's parallel requests each replay the pre-rotation token, Keycloak
	// sees reuse and revokes the whole session (spurious logout). Persisted to a
	// volume with AOF so a redis restart doesn't evict sessions and force
	// re-login.
	//
	// SECURITY: redis runs with no auth, so it must NOT join bitswan_network —
	// every workspace's gitops/infra-driver container (running user-controlled
	// code) is on that network, and an open redis there would let any workspace
	// FLUSHALL every user's session or delete the per-session refresh locks
	// (reintroducing the rotation race this store exists to fix). It lives on a
	// compose-private, internal (no egress) network shared only with the proxy.
	redisService := map[string]interface{}{
		"image":          "redis:7-alpine",
		"restart":        "always",
		"container_name": "bitswan-protected-proxy-redis",
		"networks":       []string{"protected-proxy-session"},
		"command":        []string{"redis-server", "--appendonly", "yes"},
		"volumes":        []string{"bitswan-protected-proxy-redis:/data"},
	}

	dockerCompose := map[string]interface{}{
		"version": "3.8",
		"services": map[string]interface{}{
			"bitswan-protected-proxy":       proxyService,
			"bitswan-protected-proxy-redis": redisService,
		},
		"networks": map[string]interface{}{
			"bitswan_network": map[string]interface{}{
				"external": true,
			},
			"protected-proxy-session": map[string]interface{}{
				"internal": true,
			},
		},
		"volumes": map[string]interface{}{
			"bitswan-protected-proxy-redis": map[string]interface{}{},
			// The daemon's own config volume, created by `bitswan
			// automation-server-daemon init` — the proxy mounts one subpath of it
			// read-only for its page templates.
			"bitswan": map[string]interface{}{
				"external": true,
			},
		},
	}

	var buf bytes.Buffer
	encoder := yaml.NewEncoder(&buf)
	encoder.SetIndent(2)
	if err := encoder.Encode(dockerCompose); err != nil {
		return "", fmt.Errorf("failed to encode docker-compose data structure: %w", err)
	}

	return buf.String(), nil
}

// CreateWorkspaceTraefikDockerComposeFile creates a docker-compose file for workspace sub-traefik.
// workspaceName: name of the workspace (used for container name)
// traefikPath: path to traefik config directory
// domain: the public domain — used to generate Docker labels so the global Traefik auto-discovers this sub-traefik.
// wildcardResolver: when non-empty, the global Traefik resolver that issues a
// shared *.{domain} wildcard certificate (DNS-01) — used instead of
// per-hostname HTTP-01 certificates.
// networks: list of additional networks (bitswan_network is always included)
func CreateWorkspaceTraefikDockerComposeFile(workspaceName, traefikPath, domain, wildcardResolver string, networks []string) (string, error) {
	// The sub-traefik config lives in the `bitswan` volume at
	// workspaces/<ws>/traefik/traefik.yml — mount it as a volume subpath, not a
	// host bind (see CreateTraefikDockerComposeFile for why).
	traefikVolumes := []interface{}{
		map[string]interface{}{
			"type":   "volume",
			"source": "bitswan",
			"target": "/etc/traefik/traefik.yml",
			"volume": map[string]interface{}{
				"subpath": "workspaces/" + workspaceName + "/traefik/traefik.yml",
			},
		},
		// The file-provider dynamic config (routes), shared with the daemon via
		// the same volume subpath. Traefik reloads it on change and on its own
		// restart, so workspace routes survive a sub-traefik restart.
		map[string]interface{}{
			"type":   "volume",
			"source": "bitswan",
			"target": "/etc/traefik/dynamic.yml",
			"volume": map[string]interface{}{
				"subpath": "workspaces/" + workspaceName + "/traefik/dynamic.yml",
			},
		},
	}

	traefikNetworks := []string{"bitswan_network"}
	traefikNetworks = append(traefikNetworks, networks...)

	networksMap := map[string]interface{}{
		"bitswan_network": map[string]interface{}{
			"external": true,
		},
	}
	for _, network := range networks {
		networksMap[network] = map[string]interface{}{
			"external": true,
		}
	}

	containerName := fmt.Sprintf("%s__traefik", workspaceName)

	// Build Docker labels so the global Traefik auto-discovers this sub-traefik
	// and creates a HostRegexp routing rule for all {workspace}-*.{domain} hostnames.
	serviceMap := map[string]interface{}{
		"image":          "traefik:v3.6",
		"restart":        "always",
		"container_name": containerName,
		"networks":       traefikNetworks,
		"volumes":        traefikVolumes,
		// The sub-traefik multi-homes onto every stage bridge to reach app
		// upstreams. It's an L7 proxy and never forwards IP packets, so disable
		// forwarding in its own network namespace: it then CANNOT be used to route
		// one stage network into another at L3 — no cross-stage bridge exists at
		// the packet layer, complementing the L7 ingress ACL. (net.ipv4.ip_forward
		// is per-netns, so this affects only this container, not host bridging.)
		"sysctls": map[string]interface{}{
			"net.ipv4.ip_forward": "0",
		},
	}

	if domain != "" {
		routerName := fmt.Sprintf("%s-routing", workspaceName)
		escapedDomain := strings.ReplaceAll(domain, ".", `\.`)
		pattern1 := fmt.Sprintf(`%s-[^.]+\.%s`, workspaceName, escapedDomain)
		pattern2 := fmt.Sprintf(`[^.]+\.%s-[^.]+\.%s`, workspaceName, escapedDomain)
		rule := fmt.Sprintf("HostRegexp(`%s`) || HostRegexp(`%s`)", pattern1, pattern2)

		labels := map[string]string{
			"traefik.enable": "true",
			fmt.Sprintf("traefik.http.routers.%s.rule", routerName):                      rule,
			fmt.Sprintf("traefik.http.routers.%s.entrypoints", routerName):               "websecure",
			fmt.Sprintf("traefik.http.routers.%s.tls", routerName):                       "true",
			fmt.Sprintf("traefik.http.services.%s.loadbalancer.server.port", routerName): "80",
		}
		if !strings.HasSuffix(domain, ".localhost") {
			if wildcardResolver != "" {
				// One wildcard certificate for the whole domain via DNS-01
				// instead of an HTTP-01 certificate per SNI hostname (which
				// quickly exhausts Let's Encrypt's per-domain rate limit).
				labels[fmt.Sprintf("traefik.http.routers.%s.tls.certresolver", routerName)] = wildcardResolver
				labels[fmt.Sprintf("traefik.http.routers.%s.tls.domains[0].main", routerName)] = domain
				labels[fmt.Sprintf("traefik.http.routers.%s.tls.domains[0].sans", routerName)] = "*." + domain
			} else {
				labels[fmt.Sprintf("traefik.http.routers.%s.tls.certresolver", routerName)] = "letsencrypt"
			}
		}
		serviceMap["labels"] = labels
	}

	dockerCompose := map[string]interface{}{
		"version": "3.8",
		"services": map[string]interface{}{
			"traefik": serviceMap,
		},
		"networks": networksMap,
		"volumes": map[string]interface{}{
			"bitswan": map[string]interface{}{
				"external": true,
			},
		},
	}

	var buf bytes.Buffer
	encoder := yaml.NewEncoder(&buf)
	encoder.SetIndent(2)
	if err := encoder.Encode(dockerCompose); err != nil {
		return "", fmt.Errorf("failed to encode docker-compose data structure: %w", err)
	}

	return buf.String(), nil
}
