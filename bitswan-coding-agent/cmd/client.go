package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func getGitopsURL() string {
	url := os.Getenv("BITSWAN_GITOPS_URL")
	if url == "" {
		url = "http://localhost:8079"
	}
	return strings.TrimRight(url, "/")
}

func getAgentSecret() string {
	return os.Getenv("BITSWAN_GITOPS_AGENT_SECRET")
}

// detectWorktree detects the current worktree name from the working directory.
// It looks for the path pattern /workspace/worktrees/{name}/...
func detectWorktree() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("failed to get working directory: %w", err)
	}

	// Look for /workspace/worktrees/{name} in the path
	prefix := "/workspace/worktrees/"
	idx := strings.Index(cwd, prefix)
	if idx == -1 {
		return "", fmt.Errorf("not inside a worktree directory (expected path containing %s)", prefix)
	}

	rest := cwd[idx+len(prefix):]
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) == 0 || parts[0] == "" {
		return "", fmt.Errorf("could not detect worktree name from path: %s", cwd)
	}

	return parts[0], nil
}

// detectWorktreeOrFlag returns the worktree name from the flag or auto-detects it.
func detectWorktreeOrFlag(flag string) (string, error) {
	if flag != "" {
		return flag, nil
	}
	return detectWorktree()
}

func agentRequest(method, path string, body interface{}) (*http.Response, error) {
	baseURL := getGitopsURL()
	url := baseURL + "/agent" + path

	var reqBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal request body: %w", err)
		}
		reqBody = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, url, reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+getAgentSecret())
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}

	if resp.StatusCode >= 400 {
		defer resp.Body.Close()
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error (HTTP %d): %s", resp.StatusCode, string(respBody))
	}

	return resp, nil
}

func agentRequestJSON(method, path string, body interface{}, result interface{}) error {
	resp, err := agentRequest(method, path, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if result != nil {
		return json.NewDecoder(resp.Body).Decode(result)
	}
	return nil
}

// requirementsFilePath returns the path to the requirements file for a worktree.
func requirementsFilePath(worktree string) string {
	return filepath.Join("/workspace/worktrees", worktree, ".requirements.json")
}
