package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/dockerhub"
	"gopkg.in/yaml.v3"
)

// Update detection. A workspace/server "has an update available" when the
// image tag it is currently running is older than the latest tag on its track
// (staging by default for Bailey — see useStagingTrack). We read the deployed
// tag from the generated compose files (the only place per-workspace image
// versions live) and compare against the Docker Hub resolvers. Results are
// cached briefly so listing workspaces doesn't hit Docker Hub per row.

// useStagingTrack reports whether this server tracks the staging image line.
// Bailey servers run staging images, so default to true; a future setting can
// override it.
func useStagingTrack() bool { return true }

// tagOf returns the ":tag" portion of a "repo:tag" image reference, or "".
func tagOf(image string) string {
	if i := strings.LastIndex(image, ":"); i >= 0 {
		return image[i+1:]
	}
	return ""
}

// deployedServiceImage reads the image reference for a service from one of a
// workspace's generated compose files. composeFile is relative to the
// workspace's deployment dir (e.g. "docker-compose.yml").
func deployedServiceImage(workspaceName, composeFile, service string) string {
	path := filepath.Join(
		os.Getenv("HOME"), ".config", "bitswan", "workspaces", workspaceName,
		"deployment", composeFile,
	)
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var doc struct {
		Services map[string]struct {
			Image string `yaml:"image"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return ""
	}
	return doc.Services[service].Image
}

// latestVersions is the cached set of latest tags per component on this
// server's track. Resolving hits Docker Hub, so cache for a few minutes.
type latestVersions struct {
	gitops    string
	dashboard string
	at        time.Time
}

var (
	latestVerMu    sync.Mutex
	latestVerCache latestVersions
)

const latestVerTTL = 5 * time.Minute

func resolveLatestVersions() latestVersions {
	latestVerMu.Lock()
	defer latestVerMu.Unlock()
	if time.Since(latestVerCache.at) < latestVerTTL && latestVerCache.gitops != "" {
		return latestVerCache
	}
	staging := useStagingTrack()
	lv := latestVersions{at: time.Now()}
	if img, err := dockerhub.ResolveGitopsImage(staging, false); err == nil {
		lv.gitops = tagOf(img)
	}
	if img, err := dockerhub.ResolveDashboardImage(staging, false); err == nil {
		lv.dashboard = tagOf(img)
	}
	// Only cache a fully-resolved set; a transient Docker Hub failure shouldn't
	// pin empty "latest" values for the whole TTL.
	if lv.gitops != "" {
		latestVerCache = lv
	}
	return lv
}

// workspaceVersions reports a workspace's deployed component tags and whether
// any is behind the latest on its track.
type workspaceVersions struct {
	Gitops          string `json:"gitops,omitempty"`
	Dashboard       string `json:"dashboard,omitempty"`
	LatestGitops    string `json:"latest_gitops,omitempty"`
	LatestDashboard string `json:"latest_dashboard,omitempty"`
	UpdateAvailable bool   `json:"update_available"`
}

func detectWorkspaceVersions(workspaceName string) workspaceVersions {
	gitops := tagOf(deployedServiceImage(workspaceName, "docker-compose.yml", "bitswan-gitops"))
	dashboard := tagOf(deployedServiceImage(workspaceName, "docker-compose-dashboard.yml", "bitswan-dashboard"))
	lv := resolveLatestVersions()
	wv := workspaceVersions{
		Gitops:          gitops,
		Dashboard:       dashboard,
		LatestGitops:    lv.gitops,
		LatestDashboard: lv.dashboard,
	}
	// "behind" only when we successfully resolved a latest AND have a deployed
	// tag to compare — never flag an update we can't name.
	if lv.gitops != "" && gitops != "" && gitops != lv.gitops {
		wv.UpdateAvailable = true
	}
	if lv.dashboard != "" && dashboard != "" && dashboard != lv.dashboard {
		wv.UpdateAvailable = true
	}
	return wv
}

// serverVersionInfo reports the running daemon version and, if resolvable, the
// latest published CLI release, plus whether the server is behind.
type serverVersionInfo struct {
	Current         string `json:"current"`
	Latest          string `json:"latest,omitempty"`
	UpdateAvailable bool   `json:"update_available"`
}

func detectServerVersion(current string) serverVersionInfo {
	info := serverVersionInfo{Current: current}
	latest, err := dockerhub.GetLatestGitHubRelease()
	if err != nil || latest == "" {
		return info
	}
	info.Latest = latest
	// Compare loosely: only claim an update when both are real, tagged versions
	// and differ. A "dev"/git-sha build never nags.
	if isReleaseVersion(current) && current != latest {
		info.UpdateAvailable = true
	}
	return info
}

// isReleaseVersion reports whether v looks like a published release tag
// (vYYYY.MM.DD.N), as opposed to a dev / git-sha build.
func isReleaseVersion(v string) bool {
	v = strings.TrimSpace(v)
	return strings.HasPrefix(v, "v20") && !strings.Contains(v, "git") && !strings.Contains(v, "dirty")
}
