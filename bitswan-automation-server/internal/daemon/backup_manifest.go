package daemon

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/pem"
	"os"
	"path/filepath"
	"sort"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/daemon/backup"
	"github.com/bitswan-space/bitswan-workspaces/internal/traefikapi"
)

// Assembling the server manifest.
//
// This lives in the daemon package rather than in backup because it needs the
// workspace list, the per-workspace compose image pins, the global route table
// and the daemon's own version — and backup is imported BY daemon, so it cannot
// reach back. The engine calls it through Engine.ManifestBuilder.

// imagePinEnvVars are the overrides that exist ONLY in the daemon container's
// environment (forwarded at container creation, cmd/automationserverdaemon/init.go).
// Nothing on disk records them, so without the manifest a rebuilt server
// silently reverts to default images.
var imagePinEnvVars = []string{
	"BITSWAN_GITOPS_IMAGE",
	"BITSWAN_DASHBOARD_IMAGE",
	"BITSWAN_CODING_AGENT_IMAGE",
	"BITSWAN_INFRA_DRIVER_IMAGE",
	"BITSWAN_EGRESS_GATEWAY_IMAGE",
	"BITSWAN_BUILD_NETWORK",
	"BITSWAN_GOPROXY",
	"BITSWAN_NPM_REGISTRY",
}

// serverVolumeNames are the server-level Docker volumes, recorded so a recovery
// knows what should exist. Only `bitswan` holds irreplaceable state; the rest
// are caches or (for mkcert) deliberately not backed up.
var serverVolumeNames = []string{
	"bitswan",
	"bitswan-mkcert",
	"bitswan-grype-db",
	"bitswan-athens-storage",
	"bitswan-verdaccio-storage",
	"bitswan-verdaccio-conf",
}

// buildServerManifest renders the manifest for the current server state.
// Every field is best-effort: a manifest missing a section is far better than a
// backup that fails because one lookup did.
func (s *Server) buildServerManifest() ([]byte, error) {
	manifest := backup.ServerManifest{
		BitswanVersion: s.version,
		DaemonImage:    daemonRuntimeImage,
		DeliberatelyExcluded: []string{
			"~/.local/share/mkcert (CA private key — kept out of off-site storage by policy; " +
				"expect a different CA after recovery and re-trust it on developer machines)",
			"the restic key (circular — it decrypts this repo)",
			"grype / Athens / Verdaccio / proxy-redis volumes (rebuildable caches)",
			"per-business-process images (local image store only — a fresh host needs a rebuild pass)",
		},
	}

	if cfg, err := config.NewAutomationServerConfig().LoadConfig(); err == nil && cfg != nil {
		aoc := cfg.AutomationOperationsCenter
		manifest.ServerID = aoc.AutomationServerId
		manifest.AOCUrl = aoc.AOCUrl
		manifest.Domain = aoc.Domain
		manifest.ProtectedDomain = cfg.ProtectedHostnameDomain()
		manifest.Proxied = aoc.Proxied
		manifest.RelayAddr = aoc.RelayAddr
	}

	manifest.ImagePins = map[string]string{}
	for _, key := range imagePinEnvVars {
		if v := os.Getenv(key); v != "" {
			manifest.ImagePins[key] = v
		}
	}

	manifest.Workspaces = s.manifestWorkspaces()
	manifest.Routes = manifestRoutes()
	manifest.ServerVolumes = serverVolumeNames
	manifest.MkcertCAFingerprint = mkcertCAFingerprint()

	return manifest.Marshal()
}

// manifestWorkspaces records what a recovery needs per workspace: its AOC id
// (so it can be reconciled rather than re-registered), which services were
// enabled where, and the image pins its compose carried.
func (s *Server) manifestWorkspaces() []backup.ManifestWorkspace {
	names, err := listWorkspaceNames()
	if err != nil {
		return nil
	}
	sort.Strings(names)

	stages := []string{"dev", "staging", "production"}
	services := []string{"postgres", "couchdb", "garage", "kafka"}

	out := make([]backup.ManifestWorkspace, 0, len(names))
	for _, name := range names {
		entry := backup.ManifestWorkspace{Name: name}
		if metadata, err := config.GetWorkspaceMetadata(name); err == nil {
			entry.Domain = metadata.Domain
			if metadata.WorkspaceId != nil {
				entry.WorkspaceID = *metadata.WorkspaceId
			}
		}

		enabled := map[string][]string{}
		for _, service := range services {
			for _, stage := range stages {
				if backup.ServiceEnabled(name, service, stage) {
					enabled[service] = append(enabled[service], stage)
				}
			}
		}
		if len(enabled) > 0 {
			entry.Enabled = enabled
		}

		images := map[string]string{}
		for service, composeFile := range map[string]string{
			"gitops":       "docker-compose.yml",
			"infra-driver": "docker-compose.yml",
			"dashboard":    "docker-compose-dashboard.yml",
			"coding-agent": "docker-compose-coding-agent.yml",
		} {
			// The compose service names differ from the logical names.
			composeService := map[string]string{
				"gitops":       "bitswan-gitops",
				"infra-driver": name + "-infra-driver",
				"dashboard":    "bitswan-dashboard",
				"coding-agent": "bitswan-coding-agent",
			}[service]
			if img := deployedServiceImage(name, composeFile, composeService); img != "" {
				images[service] = img
			}
		}
		if len(images) > 0 {
			entry.Images = images
		}

		out = append(out, entry)
	}
	return out
}

// manifestRoutes lists the global ingress hostnames, so a recovery can tell
// whether the restored rest-state.json really carries what was there.
func manifestRoutes() []string {
	routes, err := traefikapi.ListRoutes()
	if err != nil {
		return nil
	}
	var hosts []string
	for _, route := range routes {
		for _, match := range route.Match {
			hosts = append(hosts, match.Host...)
		}
	}
	sort.Strings(hosts)
	return hosts
}

// mkcertCAFingerprint fingerprints the local CA certificate. The CA is
// deliberately not backed up, so recording this is how a recovery confirms the
// post-restore CA is genuinely a new one rather than a silent mix-up.
func mkcertCAFingerprint() string {
	path := filepath.Join(os.Getenv("HOME"), ".local", "share", "mkcert", "rootCA.pem")
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return ""
	}
	sum := sha256.Sum256(block.Bytes)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// daemonRuntimeImage mirrors the image the daemon container runs, which a
// bare-machine restore needs in order to get a restic that matches this repo.
const daemonRuntimeImage = "bitswan/automation-server-runtime:latest"
