package daemon

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
	"github.com/bitswan-space/bitswan-workspaces/internal/dockercompose"
	"github.com/bitswan-space/bitswan-workspaces/internal/traefikapi"
	"gopkg.in/yaml.v3"
)

const (
	dexProject       = "bitswan-dex"
	dexContainerName = "bitswan-dex"
	dexPort          = "5556"
	dexProxyClientID = "bailey-protected-proxy"
	dexConnectorAOC  = "aoc"
	dexConnectorSSO  = "sso"
	dexUID           = 1001
	dexGID           = 1001
)

var dexUpstreamScopes = []string{"openid", "profile", "email", "offline_access"}

func dexHost(domain string) string {
	return "auth." + strings.TrimPrefix(domain, ".")
}

func dexIssuerURL(domain string) string {
	return "https://" + dexHost(domain)
}

func dexConfigDir() string {
	return os.Getenv("HOME") + "/.config/bitswan/dex"
}

func buildDexConfig(domain string, aocClient *aoc.OAuthClientResponse, sso ssoConfig, proxySecret string) (string, error) {
	callback := dexIssuerURL(domain) + "/callback"

	connectors := []map[string]any{}
	if !sso.SSOOnly && aocClient != nil && aocClient.ClientID != "" && aocClient.IssuerURL != "" {
		connectors = append(connectors, map[string]any{
			"type": "oidc",
			"id":   dexConnectorAOC,
			"name": "Bitswan account",
			"config": map[string]any{
				"issuer":       aocClient.IssuerURL,
				"clientID":     aocClient.ClientID,
				"clientSecret": aocClient.ClientSecret,
				"redirectURI":  callback,
				"scopes":       dexUpstreamScopes,
				"userNameKey":  "email",
				"claimMapping": map[string]any{"groups": "group_membership"},
			},
		})
	}

	ssoCfg := map[string]any{
		"issuer":               sso.IssuerURL,
		"clientID":             sso.ClientID,
		"clientSecret":         sso.ClientSecret,
		"redirectURI":          callback,
		"scopes":               dexUpstreamScopes,
		"userNameKey":          "email",
		"insecureEnableGroups": true,
	}
	if claim := strings.TrimSpace(sso.GroupsClaim); claim != "" && claim != "groups" {
		ssoCfg["claimMapping"] = map[string]any{"groups": claim}
	}
	connectors = append(connectors, map[string]any{
		"type":   "oidc",
		"id":     dexConnectorSSO,
		"name":   sso.DisplayName,
		"config": ssoCfg,
	})

	cfg := map[string]any{
		"issuer": dexIssuerURL(domain),
		"frontend": map[string]any{
			"issuer":  "Bitswan Bailey",
			"dir":     "/etc/dex/web",
			"theme":   dexThemeName,
			"logoURL": "theme/logo.svg",
		},
		"storage": map[string]any{
			"type":   "sqlite3",
			"config": map[string]any{"file": "/var/dex/dex.db"},
		},
		"web": map[string]any{"http": "0.0.0.0:" + dexPort},
		"oauth2": map[string]any{
			"skipApprovalScreen": true,
		},
		"staticClients": []map[string]any{{
			"id":           dexProxyClientID,
			"name":         "Bitswan Bailey",
			"secret":       proxySecret,
			"redirectURIs": []string{dexProxyRedirectURL(domain)},
		}},
		"connectors":       connectors,
		"enablePasswordDB": false,
	}

	b, err := yaml.Marshal(cfg)
	if err != nil {
		return "", fmt.Errorf("render dex config: %w", err)
	}
	return string(b), nil
}

func dexProxyRedirectURL(domain string) string {
	return "https://bailey." + strings.TrimPrefix(domain, ".") + "/oauth2/callback"
}

func writeDexConfig(domain string, sso ssoConfig, proxySecret string) error {
	dir := dexConfigDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create dex config directory: %w", err)
	}

	var aocOAuth *aoc.OAuthClientResponse
	if client, err := aocProtectedOAuthClient(domain); err == nil {
		aocOAuth = client
	} else {
		fmt.Printf("Warning: no AOC OAuth client for the broker — Bitswan-account sign-in will be unavailable: %v\n", err)
	}

	cfg, err := buildDexConfig(domain, aocOAuth, sso, proxySecret)
	if err != nil {
		return err
	}
	if err := os.WriteFile(dir+"/config.yaml", []byte(cfg), 0600); err != nil {
		return fmt.Errorf("write dex config: %w", err)
	}
	if _, err := writeDexWebTheme(dir); err != nil {
		return err
	}
	if err := chownTree(dir, dexUID, dexGID); err != nil {
		return fmt.Errorf("hand the broker's files to its uid: %w", err)
	}

	sum := sha256.Sum256([]byte(cfg))
	composeYAML, err := dockercompose.CreateDexDockerComposeFile(dexPort, hex.EncodeToString(sum[:]), dexExtraHosts())
	if err != nil {
		return fmt.Errorf("render dex compose: %w", err)
	}
	if err := os.WriteFile(dir+"/docker-compose.yml", []byte(composeYAML), 0600); err != nil {
		return fmt.Errorf("write dex compose: %w", err)
	}
	return nil
}

func dexExtraHosts() []string {
	raw := strings.TrimSpace(os.Getenv("BITSWAN_EXTRA_HOSTS"))
	if raw == "" {
		return nil
	}
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if h := strings.TrimSpace(part); h != "" {
			out = append(out, h)
		}
	}
	return out
}

func chownTree(root string, uid, gid int) error {
	return filepath.Walk(root, func(path string, _ os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		return os.Chown(path, uid, gid)
	})
}

func aocProtectedOAuthClient(domain string) (*aoc.OAuthClientResponse, error) {
	aocClient, err := aoc.NewAOCClient()
	if err != nil {
		return nil, err
	}
	return aocClient.GetOrCreateOAuthClient("bitswan-protected", dexIssuerURL(domain)+"/callback")
}

func startDex() error {
	up := exec.Command("docker", "compose", "-p", dexProject, "up", "-d")
	up.Dir = dexConfigDir()
	up.Stdout = os.Stdout
	up.Stderr = os.Stderr
	if err := up.Run(); err != nil {
		return fmt.Errorf("start %s: %w", dexContainerName, err)
	}
	return nil
}

func stopDex() {
	if !containerRunning(dexContainerName) {
		return
	}
	down := exec.Command("docker", "compose", "-p", dexProject, "down")
	down.Dir = dexConfigDir()
	_ = down.Run()
}

func registerDexRoute(domain string) {
	host := dexHost(domain)
	resolver, tlsDomains := certResolverForHostname(host)
	if err := traefikapi.AddRouteWithTLSDomains(host, dexContainerName+":"+dexPort, "", resolver, tlsDomains); err != nil {
		fmt.Printf("Warning: register broker route for %s: %v\n", host, err)
	}
}

func removeDexRoute(domain string) {
	_ = traefikapi.RemoveRoute(dexHost(domain))
}
