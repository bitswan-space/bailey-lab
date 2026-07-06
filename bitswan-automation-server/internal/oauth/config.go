package oauth

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v2"
)

// Config holds the OAuth client details the Bailey management surface needs to
// build a Keycloak end-session URL on sign-out (see daemon.signoutRedirect).
// All workspace endpoint auth is handled by the shared bitswan-protected-proxy;
// this is not a per-service oauth2-proxy config.
type Config struct {
	ClientId     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	IssuerUrl    string `json:"issuer_url"`
	CookieSecret string `json:"cookie_secret"`
}

func GetOauthConfig(workspaceName string) (*Config, error) {
	var config Config
	workspacePath := os.Getenv("HOME") + "/.config/bitswan/workspaces/" + workspaceName
	configPath := workspacePath + "/oauth-config.yaml"

	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		return nil, err
	}

	fileContent, err := os.ReadFile(configPath)
	if err != nil {
		fmt.Println("Error reading OAuth config file:", err)
		return nil, fmt.Errorf("error reading OAuth config file: %w", err)
	}

	if err := yaml.Unmarshal(fileContent, &config); err != nil {
		fmt.Println("Error unmarshalling OAuth config file:", err)
		return nil, fmt.Errorf("error unmarshalling OAuth config file: %w", err)
	}

	if config.ClientId == "" || config.ClientSecret == "" || config.IssuerUrl == "" || config.CookieSecret == "" {
		fmt.Println("Error: all required fields are not set")
		return nil, fmt.Errorf("all required fields are not set")
	}

	return &config, nil
}
