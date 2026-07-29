// Package backup implements server-level backups: the daemon captures every
// workspace's full data tree (including secrets), per-stage logical DB dumps,
// and the server's own state into ONE restic repo per automation server,
// reached through AOC's server-scoped restic REST proxy. This replaces the
// old per-workspace backups gitops used to run — workspaces do no backup
// jobs and hold no backup credentials.
package backup

import (
	"fmt"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// AOCTarget is where this server's backup repo lives: AOC's restic REST
// proxy, authenticated with the server's own access token (the token alone
// scopes the bucket — see AOC's ServerBucketMixin).
type AOCTarget struct {
	URL      string // AOC base URL, no trailing slash
	ServerID string // automation_server_id (restic REST username + --host)
	Token    string // access token (restic REST password / Bearer)
}

// LoadAOCTarget builds the target from the server-level TOML config.
// Errors when the server isn't registered with an AOC — backups are then
// unavailable (there is nowhere to put them).
func LoadAOCTarget() (*AOCTarget, error) {
	cfg, err := config.NewAutomationServerConfig().LoadConfig()
	if err != nil {
		return nil, fmt.Errorf("failed to load automation server config: %w", err)
	}
	aoc := cfg.AutomationOperationsCenter
	if aoc.AOCUrl == "" || aoc.AccessToken == "" {
		return nil, fmt.Errorf("server is not registered with an AOC")
	}

	return NewAOCTarget(aoc.AOCUrl, aoc.AutomationServerId, aoc.AccessToken), nil
}

// NewAOCTarget builds a target from values supplied directly, for the
// daemon-less path: a machine being rebuilt has no config file to read, so
// disaster recovery takes the AOC URL and server id from the recovery command
// and the token from exchanging its OTP.
func NewAOCTarget(url, serverID, token string) *AOCTarget {
	return &AOCTarget{
		URL:      strings.TrimRight(normalizeAOCURL(url), "/"),
		ServerID: serverID,
		Token:    token,
	}
}

// normalizeAOCURL applies the same dev rewrite as
// GetAOCEnvironmentVariables: a .localhost AOC is reached through the docker
// network, not the host loopback.
func normalizeAOCURL(url string) string {
	if strings.Contains(url, ".localhost") {
		return "http://api.bitswan.localhost"
	}
	return url
}

// InDockerNetwork reports whether reaching this AOC requires being on the
// bitswan docker network — true only for the .localhost dev setup, where the
// hostname resolves nowhere else. The container path uses this to decide
// whether restic needs --network.
func (t *AOCTarget) InDockerNetwork() bool {
	return strings.Contains(t.URL, ".localhost")
}

// RepoURL is the restic REST repository URL (rest: scheme prefix added by
// the restic env builder).
func (t *AOCTarget) RepoURL() string {
	return t.URL + "/api/automation_server/backups/repo/"
}
