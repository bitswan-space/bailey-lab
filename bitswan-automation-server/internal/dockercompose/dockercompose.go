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

// DockerComposeConfig holds the configuration required for creating a docker-compose file
type DockerComposeConfig struct {
	GitopsPath         string
	WorkspaceName      string
	GitopsImage        string
	Domain             string
	AocEnvVars         []string
	OAuthEnvVars       []string
	GitopsDevSourceDir string
	TrustCA            bool
	LocalRemotePath    string // Host path to local repository (if using local remote)
	LocalRemoteName    string // Mount name for local repository (used for mount point path)
	KeycloakURL        string // Keycloak base URL for authentication
	CodingAgentSecret  string // Bearer token gitops uses to verify coding-agent requests
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

	// The infra-driver gets its OWN token, distinct from the gitops API secret.
	// gitops and its driver are a pair (generated together, so it need not be
	// persisted), but keeping it separate means a leak of the gitops secret does
	// not grant driver (push + exec = docker.sock) access, and vice versa.
	driverToken := uniuri.NewLen(64)

	gitopsService := map[string]interface{}{
		"image":    config.GitopsImage,
		"restart":  "always",
		"hostname": config.WorkspaceName + "-gitops",
		// Labelled with the workspace so the driver permits gitops's scoped
		// self-exec (root cleanup of copy trees) — the driver refuses any
		// container not carrying this workspace label.
		"labels":   map[string]string{"gitops.workspace": config.WorkspaceName},
		"networks": []string{"bitswan_network"},
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
			// Canonical bare repo (served over smart-HTTP, fast-forward only)
			// and the per-copy checkouts under the workspace-repo dir. Keeping
			// copies at <workspace-repo>/copies makes a deployment's
			// workspace-root-relative path ("copies/<copy>/<rel>") resolve
			// correctly both as a container-local path (join with
			// BITSWAN_WORKSPACE_REPO_DIR) and as a volume subpath
			// (workspaces/<ws>/<rel-path>). The `main` copy is the default scope.
			"BITSWAN_GIT_REPOS_DIR=/git",
			"BITSWAN_WORKSPACE_REPO_DIR=/workspace-repo",
			"BITSWAN_COPIES_DIR=/workspace-repo/copies",
			"BITSWAN_GIT_REMOTE=http://" + config.WorkspaceName + "-gitops:8079/git/repo.git",
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

	// Add Keycloak URL if configured
	if config.KeycloakURL != "" {
		gitopsService["environment"] = append(gitopsService["environment"].([]string), "KEYCLOAK_URL="+config.KeycloakURL)
	}

	// Append AOC env variables when workspace is registered as an automation server
	if len(config.AocEnvVars) > 0 {
		gitopsService["environment"] = append(gitopsService["environment"].([]string), config.AocEnvVars...)
	}

	// Append OAuth env variables when OAuth is configured
	if len(config.OAuthEnvVars) > 0 {
		gitopsService["environment"] = append(gitopsService["environment"].([]string), config.OAuthEnvVars...)
	}

	// Add dev source directory volume mount and DEBUG env var if provided
	if config.GitopsDevSourceDir != "" {
		gitopsService["volumes"] = append(gitopsService["volumes"].([]interface{}), config.GitopsDevSourceDir+":/src:z")
		gitopsService["environment"] = append(gitopsService["environment"].([]string), "DEBUG=true")
	}

	// Mount certificate authorities if specified
	caVolumes, caEnvVars := certauthority.GetCACertMountConfig(config.TrustCA)
	if len(caVolumes) > 0 {
		for _, v := range caVolumes {
			gitopsService["volumes"] = append(gitopsService["volumes"].([]interface{}), v)
		}
		gitopsService["environment"] = append(gitopsService["environment"].([]string), caEnvVars...)
	}

	// Mount the canonical bare repo (served over smart-HTTP) and the per-copy
	// checkouts (the deploy unit). These replace the old shared workspace
	// working-tree mount + gitops orphan-worktree gitdir rewrite.
	gitopsService["volumes"] = append(gitopsService["volumes"].([]interface{}),
		wsVolume("repo.git", "/git/repo.git"),
		wsVolume("copies", "/workspace-repo/copies"),
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
		"BITSWAN_DEPLOY_REMOTE=http://x:"+driverToken+"@"+config.WorkspaceName+"-infra-driver:9090/deploy.git",
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
		},
		"volumes": map[string]interface{}{
			"bitswan": map[string]interface{}{
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

// buildDriverService builds the infra-driver sidecar: the same daemon runtime
// image (docker CLI + compose + git-http-backend), the bitswan binary
// bind-mounted as the daemon mounts its own, docker.sock, and the workspace
// volume subpaths the compiler reads/writes. It serves the deploy repo over
// git smart-HTTP + the /v1 primitives, guarded by the shared token.
func (config *DockerComposeConfig) buildDriverService(token string, wsVolume func(string, string) map[string]interface{}, homeDir string) map[string]interface{} {
	driverImage := os.Getenv("BITSWAN_INFRA_DRIVER_IMAGE")
	if driverImage == "" {
		driverImage = "bitswan/automation-server-runtime:latest"
	}
	// The host path of the bitswan binary to bind-mount. The daemon forwards its
	// own host binary path as BITSWAN_HOST_BINARY (it cannot use os.Executable()
	// from inside its container); a host-CLI `workspace init` falls back to its
	// own executable.
	driverBinary := os.Getenv("BITSWAN_HOST_BINARY")
	if driverBinary == "" {
		if exe, err := os.Executable(); err == nil {
			driverBinary = exe
		} else {
			driverBinary = "/usr/local/bin/bitswan"
		}
	}

	env := []string{
		"BITSWAN_INFRA_DRIVER_TOKEN=" + token,
		"BITSWAN_VOLUME_NAME=bitswan",
		"BITSWAN_GITOPS_DIR_HOST=" + config.GitopsPath,
		"BITSWAN_CERTS_DIR=" + homeDir + "/.config/bitswan/certauthorities",
		"BITSWAN_WORKSPACE_NAME=" + config.WorkspaceName,
	}
	if config.KeycloakURL != "" {
		env = append(env, "KEYCLOAK_URL="+config.KeycloakURL)
	}
	// The compiler reads the same AOC/OAuth env gitops used (org group path,
	// oauth2-proxy config it materializes per BP, etc.).
	env = append(env, config.AocEnvVars...)
	env = append(env, config.OAuthEnvVars...)

	volumes := []interface{}{
		driverBinary + ":/usr/local/bin/bitswan:ro",
		"/var/run/docker.sock:/var/run/docker.sock",
		// The daemon ingress socket — the driver configures ingress itself
		// (converges routes via /ingress/reconcile) after bringing the project up.
		"/var/run/bitswan:/var/run/bitswan",
		wsVolume("deploy.git", "/git/deploy.git"),
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
			"/usr/local/bin/bitswan", "infra-driver", "serve",
			"--listen", ":9090",
			"--git-dir", "/git/deploy.git",
			"--gitops-dir", "/gitops/gitops",
			"--secrets-dir", "/gitops/secrets",
			"--workspace", config.WorkspaceName,
			"--domain", config.Domain,
		},
	}
}

func CreateCaddyDockerComposeFile(caddyPath string) (string, error) {
	caddyVolumes := []string{
		caddyPath + "/Caddyfile:/etc/caddy/Caddyfile:z",
		caddyPath + "/data:/data:z",
		caddyPath + "/config:/config:z",
		caddyPath + "/certs:/tls:z",
	}

	// Construct the docker-compose data structure
	dockerCompose := map[string]interface{}{
		"version": "3.8",
		"services": map[string]interface{}{
			"caddy": map[string]interface{}{
				"image":          "caddy:2.9",
				"restart":        "always",
				"container_name": "caddy",
				"ports":          []string{"80:80", "443:443", "2019:2019"},
				"networks":       []string{"bitswan_network"},
				"volumes":        caddyVolumes,
				"entrypoint":     []string{"caddy", "run", "--resume", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"},
			},
		},
		"networks": map[string]interface{}{
			"bitswan_network": map[string]interface{}{
				"external": true,
			},
		},
	}

	var buf bytes.Buffer

	// Serialize the docker-compose data structure to YAML and write it to the file
	encoder := yaml.NewEncoder(&buf)
	encoder.SetIndent(2) // Optional: Set indentation
	if err := encoder.Encode(dockerCompose); err != nil {
		return "", fmt.Errorf("failed to encode docker-compose data structure: %w", err)
	}

	return buf.String(), nil
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
		// Only the public web entrypoints are published. Traefik's API/dashboard
		// (:8080, api.insecure — unauthenticated; leaks the full routing topology)
		// is NOT published to the host: the daemon and workspace components reach it
		// in-network via BITSWAN_TRAEFIK_HOST=traefik:8080 on bitswan_network (which
		// automations are not attached to), so there is no reason to expose it on
		// the host at all.
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

// CreateProtectedProxyDockerComposeFile creates a docker-compose file for the
// shared bitswan-protected-proxy (an oauth2-proxy instance). It sits between
// platform-traefik and the daemon's protected gate: Traefik routes every
// protected hostname to bitswan-protected-proxy:80, the proxy authenticates the
// request against Keycloak and forwards the identity headers to the gate
// (upstream). All oauth2-proxy settings come from env (the upstream image's
// entrypoint is /bin/oauth2-proxy with no args), so the service needs no
// volumes or published ports — Traefik reaches it over bitswan_network.
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

	proxyService := map[string]interface{}{
		"image":          "quay.io/oauth2-proxy/oauth2-proxy:v7.7.1",
		"restart":        "always",
		"container_name": "bitswan-protected-proxy",
		"networks":       []string{"bitswan_network"},
		"environment":    envList,
	}

	dockerCompose := map[string]interface{}{
		"version": "3.8",
		"services": map[string]interface{}{
			"bitswan-protected-proxy": proxyService,
		},
		"networks": map[string]interface{}{
			"bitswan_network": map[string]interface{}{
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
