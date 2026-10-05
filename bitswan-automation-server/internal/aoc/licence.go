package aoc

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// RegistryAccess is what the AOC tells a server about pulling images.
//
// The key is shown once, when it is issued. A server that already has one is
// told only where to use it, so a reply carrying no key is the normal case
// rather than a failure.
type RegistryAccess struct {
	Host      string `json:"host"`
	Key       string `json:"key"`
	KeyPrefix string `json:"key_prefix"`
	Issued    bool   `json:"issued"`
}

type Licence struct {
	Registry RegistryAccess `json:"registry"`
	Tier     string         `json:"tier"`
	Expired  bool           `json:"expired"`
}

// GetLicence asks the AOC what this server is entitled to, which is also where
// its registry credentials come from: the server already authenticates here, so
// nobody has to issue it a key by hand.
//
// rotate asks for a replacement, for a server that lost the one it was given.
func (c *AOCClient) GetLicence(rotate bool) (*Licence, error) {
	url := fmt.Sprintf("%s/api/automation_server/license", c.settings.AOCUrl)
	if rotate {
		url += "?rotate=1"
	}
	resp, err := c.sendRequest("GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("asking the AOC for this server's licence: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("the AOC answered %s for this server's licence", resp.Status)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var licence Licence
	if err := json.Unmarshal(body, &licence); err != nil {
		return nil, fmt.Errorf("decoding the licence: %w", err)
	}
	return &licence, nil
}
