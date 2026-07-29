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

	url := aoc.AOCUrl
	// Same dev rewrite as GetAOCEnvironmentVariables: a .localhost AOC is
	// reached through the docker network, not the host loopback.
	if strings.Contains(url, ".localhost") {
		url = "http://api.bitswan.localhost"
	}

	return &AOCTarget{
		URL:      strings.TrimRight(url, "/"),
		ServerID: aoc.AutomationServerId,
		Token:    aoc.AccessToken,
	}, nil
}

// RepoURL is the restic REST repository URL (rest: scheme prefix added by
// the restic env builder).
func (t *AOCTarget) RepoURL() string {
	return t.URL + "/api/automation_server/backups/repo/"
}

// KeyMirrorURL is where the encryption key is escrowed (server-scoped).
func (t *AOCTarget) KeyMirrorURL() string {
	return t.URL + "/api/automation_server/backups/restic-key"
}
