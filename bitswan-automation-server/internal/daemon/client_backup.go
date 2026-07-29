package daemon

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// Client methods for the server-level backup API (/backup/*). All calls ride
// the unix socket; key/snapshot calls also carry the host-admin bearer token
// (doRequest always sends it), which the daemon verifies for those routes.

// backupJSON performs a /backup request and decodes the JSON response into
// out (or returns the error body's message on non-2xx).
func (c *Client) backupJSON(method, path string, body interface{}, out interface{}) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("failed to marshal request: %w", err)
		}
		reader = strings.NewReader(string(data))
	}
	req, err := http.NewRequest(method, "http://unix"+path, reader)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.doStreamingRequest(req) // no client timeout: snapshot listings hit the network
	if err != nil {
		return fmt.Errorf("failed to connect to daemon: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var errResp ErrorResponse
		if json.Unmarshal(data, &errResp) == nil && errResp.Error != "" {
			return fmt.Errorf("%s", errResp.Error)
		}
		return fmt.Errorf("unexpected status code: %d, body: %s", resp.StatusCode, string(data))
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("failed to decode response: %w", err)
		}
	}
	return nil
}

// BackupStatus fetches GET /backup/status.
func (c *Client) BackupStatus() (*BackupStatusResponse, error) {
	var status BackupStatusResponse
	if err := c.backupJSON(http.MethodGet, "/backup/status", nil, &status); err != nil {
		return nil, err
	}
	return &status, nil
}

// BackupRun starts a backup run; with wait=true it streams the job's
// progress to stdout until completion.
func (c *Client) BackupRun(wait bool) error {
	var resp struct {
		JobID string `json:"job_id"`
	}
	if err := c.backupJSON(http.MethodPost, "/backup/run", nil, &resp); err != nil {
		return err
	}
	if !wait {
		fmt.Printf("Backup run started (job %s). Follow it with the console or last-run status.\n", resp.JobID)
		return nil
	}
	return c.StreamJobOutput(resp.JobID, os.Stdout, os.Stdin)
}

// BackupSetConfig updates enabled/retention (nil fields untouched).
func (c *Client) BackupSetConfig(enabled *bool, daily, monthly *int) error {
	payload := map[string]interface{}{}
	if enabled != nil {
		payload["enabled"] = *enabled
	}
	if daily != nil {
		payload["retention_daily"] = *daily
	}
	if monthly != nil {
		payload["retention_monthly"] = *monthly
	}
	return c.backupJSON(http.MethodPost, "/backup/config", payload, nil)
}

// BackupKey returns the restic encryption key (admin token verified daemon-side).
func (c *Client) BackupKey() (string, error) {
	var resp struct {
		Key string `json:"key"`
	}
	if err := c.backupJSON(http.MethodGet, "/backup/key", nil, &resp); err != nil {
		return "", err
	}
	return resp.Key, nil
}

// BackupKeyMirrorStatus reports whether the key is escrowed at AOC.
func (c *Client) BackupKeyMirrorStatus() (bool, error) {
	var resp struct {
		Mirrored bool `json:"mirrored"`
	}
	if err := c.backupJSON(http.MethodGet, "/backup/key/mirror", nil, &resp); err != nil {
		return false, err
	}
	return resp.Mirrored, nil
}

// BackupKeyMirror escrows the key at AOC.
func (c *Client) BackupKeyMirror() error {
	return c.backupJSON(http.MethodPost, "/backup/key/mirror", nil, nil)
}

// BackupSnapshots lists restic snapshots (optionally one workspace's) as raw
// restic JSON.
func (c *Client) BackupSnapshots(workspace, tag string) (json.RawMessage, error) {
	query := url.Values{}
	if workspace != "" {
		query.Set("workspace", workspace)
	}
	if tag != "" {
		query.Set("tag", tag)
	}
	path := "/backup/snapshots"
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	var raw json.RawMessage
	if err := c.backupJSON(http.MethodGet, path, nil, &raw); err != nil {
		return nil, err
	}
	return raw, nil
}
