package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	// v3, not the v2 the rest of this package uses: v3 unmarshals nested
	// mappings as map[string]interface{}, which the compose walk relies on.
	yaml "gopkg.in/yaml.v3"
)

// WorkspacesDir is the root under which every workspace's data tree lives.
func WorkspacesDir() string {
	return filepath.Join(os.Getenv("HOME"), ".config", "bitswan", "workspaces")
}

// ComposeGitopsEnvValue reads one environment variable off the gitops service
// in a workspace's persisted deployment/docker-compose.yml. The compose file
// is the source of truth for render-time values that predate their
// metadata.yaml fields (e.g. BITSWAN_INFRA_DRIVER_TOKEN before it was
// persisted), so it doubles as the backward-compat fallback.
func ComposeGitopsEnvValue(workspaceName, key string) (string, error) {
	composeFilePath := filepath.Join(
		WorkspacesDir(), workspaceName, "deployment", "docker-compose.yml",
	)

	data, err := os.ReadFile(composeFilePath)
	if err != nil {
		return "", err
	}

	var composeConfig map[string]interface{}
	if err := yaml.Unmarshal(data, &composeConfig); err != nil {
		return "", err
	}

	services, ok := composeConfig["services"].(map[string]interface{})
	if !ok {
		return "", fmt.Errorf("services section not found")
	}

	gitopsService, ok := services["bitswan-gitops"].(map[string]interface{})
	if !ok {
		return "", fmt.Errorf("gitops service not found")
	}

	env, ok := gitopsService["environment"].([]interface{})
	if !ok {
		return "", fmt.Errorf("environment section not found")
	}

	prefix := key + "="
	for _, item := range env {
		envVar, ok := item.(string)
		if !ok {
			continue
		}
		if strings.HasPrefix(envVar, prefix) {
			return strings.TrimPrefix(envVar, prefix), nil
		}
	}

	return "", fmt.Errorf("%s not found in gitops environment", key)
}

// GetInfraDriverToken resolves the token the daemon needs to call a
// workspace's infra-driver. metadata.yaml is authoritative; workspaces
// deployed before the token was persisted fall back to the token embedded in
// their compose file, which is then written back into metadata so the
// fallback runs at most once per workspace (no redeploy needed).
func GetInfraDriverToken(workspaceName string) (string, error) {
	metadata, err := GetWorkspaceMetadata(workspaceName)
	if err != nil {
		return "", fmt.Errorf("failed to read workspace metadata: %w", err)
	}
	if metadata.InfraDriverToken != "" {
		return metadata.InfraDriverToken, nil
	}

	token, err := ComposeGitopsEnvValue(workspaceName, "BITSWAN_INFRA_DRIVER_TOKEN")
	if err != nil {
		return "", fmt.Errorf("infra-driver token not in metadata and compose fallback failed: %w", err)
	}

	metadata.InfraDriverToken = token
	if err := SaveWorkspaceMetadata(workspaceName, metadata); err != nil {
		// The token itself is good — surface the persistence failure as a
		// warning-by-error-message only if the caller cares; next call
		// simply falls back again.
		fmt.Printf("Warning: could not persist infra-driver token for %s: %v\n", workspaceName, err)
	}
	return token, nil
}
