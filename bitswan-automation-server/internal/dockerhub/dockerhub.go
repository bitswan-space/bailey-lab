package dockerhub

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
)

// imageOverride returns a pinned image set via environment, or "". Operators
// running a private/air-gapped registry (or CI testing locally-built images)
// set e.g. BITSWAN_DASHBOARD_IMAGE to bypass the Docker Hub "latest" lookup.
func imageOverride(envVar string) string {
	return os.Getenv(envVar)
}

func GetLatestDockerHubVersion(url string) (string, error) {
	// Get the latest version of the bitswan-gitops image by looking it up on dockerhub
	resp, err := http.Get(url) //nolint:gosec
	if err != nil {
		return "latest", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "latest", err
	}
	var data map[string]interface{}
	err = json.Unmarshal(body, &data)
	if err != nil {
		return "latest", err
	}
	// Docker Hub returns `{"results": [...]}` on success, but a missing or
	// renamed repository can return `{}` / an error envelope / a non-200
	// body. Tolerate that instead of panicking on the type assertion —
	// callers expect an error, not a goroutine crash.
	rawResults, ok := data["results"]
	if !ok {
		return "latest", fmt.Errorf("docker hub response missing 'results' field (status %d, url %s)", resp.StatusCode, url)
	}
	results, ok := rawResults.([]interface{})
	if !ok {
		return "latest", fmt.Errorf("docker hub 'results' is not an array (url %s)", url)
	}

	pattern := `^\d{4}-\d+-git-[a-fA-F0-9]+$`
	re := regexp.MustCompile(pattern)

	for _, result := range results {
		entry, ok := result.(map[string]interface{})
		if !ok {
			continue
		}
		name, ok := entry["name"].(string)
		if !ok {
			continue
		}
		if re.MatchString(name) {
			return name, nil
		}
	}
	return "latest", errors.New("No valid version found")
}

// GetLatestKafkaVersion gets the latest version of the bitswan-kafka image
func GetLatestKafkaVersion() (string, error) {
	return GetLatestDockerHubVersion("https://hub.docker.com/v2/repositories/bitswan/bitswan-kafka/tags/")
}

// GetLatestZookeeperVersion gets the latest version of the bitswan-zookeeper image
func GetLatestZookeeperVersion() (string, error) {
	return GetLatestDockerHubVersion("https://hub.docker.com/v2/repositories/bitswan/bitswan-zookeeper/tags/")
}

// GetLatestCouchDBVersion gets the latest version of the bitswan-couchdb image
func GetLatestCouchDBVersion() (string, error) {
	return GetLatestDockerHubVersion("https://hub.docker.com/v2/repositories/bitswan/bitswan-couchdb/tags/")
}

// GetLatestGitopsStagingVersion gets the latest version of the gitops-staging image
func GetLatestGitopsStagingVersion() (string, error) {
	return GetLatestDockerHubVersion("https://hub.docker.com/v2/repositories/bitswan/gitops-staging/tags/")
}

// ResolveGitopsImage returns the full gitops image string based on the staging flag.
func ResolveGitopsImage(staging bool) (string, error) {
	if img := imageOverride("BITSWAN_GITOPS_IMAGE"); img != "" {
		return img, nil
	}
	if staging {
		version, err := GetLatestGitopsStagingVersion()
		if err != nil {
			return "", err
		}
		return "bitswan/gitops-staging:" + version, nil
	}
	version, err := GetLatestDockerHubVersion("https://hub.docker.com/v2/repositories/bitswan/gitops/tags/")
	if err != nil {
		return "", err
	}
	return "bitswan/gitops:" + version, nil
}

// GetLatestDashboardVersion gets the latest version of the workspace-dashboard image
func GetLatestDashboardVersion() (string, error) {
	return GetLatestDockerHubVersion("https://hub.docker.com/v2/repositories/bitswan/workspace-dashboard/tags/")
}

// GetLatestDashboardStagingVersion gets the latest version of the workspace-dashboard-staging image
func GetLatestDashboardStagingVersion() (string, error) {
	return GetLatestDockerHubVersion("https://hub.docker.com/v2/repositories/bitswan/workspace-dashboard-staging/tags/")
}

// ResolveDashboardImage returns the full workspace-dashboard image string based on the staging flag.
func ResolveDashboardImage(staging bool) (string, error) {
	if img := imageOverride("BITSWAN_DASHBOARD_IMAGE"); img != "" {
		return img, nil
	}
	if staging {
		version, err := GetLatestDashboardStagingVersion()
		if err != nil {
			return "", err
		}
		return "bitswan/workspace-dashboard-staging:" + version, nil
	}
	version, err := GetLatestDashboardVersion()
	if err != nil {
		return "", err
	}
	return "bitswan/workspace-dashboard:" + version, nil
}

// GetLatestCodingAgentVersion gets the latest version of the coding-agent image
func GetLatestCodingAgentVersion() (string, error) {
	return GetLatestDockerHubVersion("https://hub.docker.com/v2/repositories/bitswan/coding-agent/tags/")
}

// GetLatestCodingAgentStagingVersion gets the latest version of the coding-agent-staging image
func GetLatestCodingAgentStagingVersion() (string, error) {
	return GetLatestDockerHubVersion("https://hub.docker.com/v2/repositories/bitswan/coding-agent-staging/tags/")
}

// ResolveCodingAgentImage returns the full coding-agent image string based on the staging flag.
func ResolveCodingAgentImage(staging bool) (string, error) {
	if img := imageOverride("BITSWAN_CODING_AGENT_IMAGE"); img != "" {
		return img, nil
	}
	if staging {
		version, err := GetLatestCodingAgentStagingVersion()
		if err != nil {
			return "", err
		}
		return "bitswan/coding-agent-staging:" + version, nil
	}
	version, err := GetLatestCodingAgentVersion()
	if err != nil {
		return "", err
	}
	return "bitswan/coding-agent:" + version, nil
}
