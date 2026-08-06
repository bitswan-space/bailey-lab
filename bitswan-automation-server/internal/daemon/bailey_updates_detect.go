package daemon

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
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
	return workspaceVersions{
		Gitops:          gitops,
		Dashboard:       dashboard,
		LatestGitops:    lv.gitops,
		LatestDashboard: lv.dashboard,
		UpdateAvailable: tagBehind(gitops, lv.gitops) || tagBehind(dashboard, lv.dashboard),
	}
}

// tagBehind reports whether a deployed tag is behind the latest one. It is
// deliberately conservative: we only claim an update when BOTH tags are known
// and they differ — never flag an update we can't name (an unresolved latest,
// or a workspace whose deployed tag we couldn't read).
func tagBehind(deployed, latest string) bool {
	return deployed != "" && latest != "" && deployed != latest
}

// serverVersionInfo reports the running daemon version and, if resolvable, the
// latest published CLI release, plus whether the server is behind.
type serverVersionInfo struct {
	Current         string `json:"current"`
	Latest          string `json:"latest,omitempty"`
	UpdateAvailable bool   `json:"update_available"`
}

var (
	serverLatestMu  sync.Mutex
	serverLatestVal string
	serverLatestAt  time.Time
)

// latestServerRelease returns the version the AOC serves for this server's
// binary — the version the server-update button would install. The AOC is the
// mirror/source of truth for the official binary (it proxies GitHub / accepts
// uploads), so availability is decided against the AOC, NOT GitHub directly: a
// GitHub outage or rate-limit must never affect this flow. Cached for
// latestVerTTL; a transient failure keeps the last good value.
func latestServerRelease() string {
	serverLatestMu.Lock()
	defer serverLatestMu.Unlock()
	if serverLatestVal != "" && time.Since(serverLatestAt) < latestVerTTL {
		return serverLatestVal
	}
	if v := fetchAOCBinaryVersion(); v != "" {
		serverLatestVal = v
		serverLatestAt = time.Now()
	}
	return serverLatestVal
}

// fetchAOCBinaryVersion asks the AOC which binary version it serves
// (GET /api/automation_server/bitswan/version). The mirror is linux/amd64-only,
// so the arch this used to send is gone.
func fetchAOCBinaryVersion() string {
	settings, err := config.NewAutomationServerConfig().GetAutomationOperationsCenterSettings()
	if err != nil || settings.AOCUrl == "" {
		return ""
	}
	url := strings.TrimRight(settings.AOCUrl, "/") + "/api/automation_server/bitswan/version"
	// Bounded timeout: this runs on the console version-display path, so a
	// black-holed AOC must not hang the caller (matches the other AOC calls).
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	var body struct {
		Version string `json:"version"`
	}
	if json.NewDecoder(resp.Body).Decode(&body) != nil {
		return ""
	}
	return strings.TrimSpace(body.Version)
}

func detectServerVersion(current string) serverVersionInfo {
	info := serverVersionInfo{Current: current}
	latest := latestServerRelease()
	if latest == "" {
		return info
	}
	info.Latest = latest
	// Only claim an update when current is genuinely OLDER than latest — not
	// merely different. A server running a version NEWER than the latest
	// published release (e.g. a pre-release build) is up to date, not "behind",
	// and must not offer a downgrade-as-update. Dev/git-sha builds never nag.
	if isReleaseVersion(current) && isReleaseVersion(latest) && versionLess(current, latest) {
		info.UpdateAvailable = true
	}
	return info
}

// versionLess reports whether release version a is strictly older than b.
// Versions look like vYYYY.MM.DD.N; compare component-by-component numerically
// (lexical compare breaks on the unpadded build number, e.g. .9 vs .10). If
// either can't be parsed, report false — never fabricate an update.
func versionLess(a, b string) bool {
	pa, oka := parseReleaseVersion(a)
	pb, okb := parseReleaseVersion(b)
	if !oka || !okb {
		return false
	}
	for i := 0; i < len(pa) && i < len(pb); i++ {
		if pa[i] != pb[i] {
			return pa[i] < pb[i]
		}
	}
	return len(pa) < len(pb)
}

func parseReleaseVersion(v string) ([]int, bool) {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(v, "v")
	parts := strings.Split(v, ".")
	nums := make([]int, 0, len(parts))
	for _, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil, false
		}
		nums = append(nums, n)
	}
	if len(nums) == 0 {
		return nil, false
	}
	return nums, true
}

// isReleaseVersion reports whether v looks like a published release tag
// (vYYYY.MM.DD.N), as opposed to a dev / git-sha build.
func isReleaseVersion(v string) bool {
	v = strings.TrimSpace(v)
	return strings.HasPrefix(v, "v20") && !strings.Contains(v, "git") && !strings.Contains(v, "dirty")
}
