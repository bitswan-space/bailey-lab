package dockercompose

import (
	"strings"
	"testing"
)

// The infra-driver token must be stable across re-renders when the caller
// provides it (persisted in metadata.yaml so the daemon can call the driver
// for server-level backups), and handed back when generated fresh.
func TestCreateDockerComposeFileDriverToken(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	fresh := &DockerComposeConfig{
		GitopsPath:    "/tmp/ws1",
		WorkspaceName: "ws1",
		GitopsImage:   "bitswan/gitops:latest",
		Domain:        "example.com",
	}
	compose, _, err := fresh.CreateDockerComposeFile()
	if err != nil {
		t.Fatal(err)
	}
	if fresh.InfraDriverToken == "" {
		t.Fatal("generated token not written back to config")
	}
	if !strings.Contains(compose, "BITSWAN_INFRA_DRIVER_TOKEN="+fresh.InfraDriverToken) {
		t.Error("compose does not carry the generated token")
	}

	reuse := &DockerComposeConfig{
		GitopsPath:       "/tmp/ws1",
		WorkspaceName:    "ws1",
		GitopsImage:      "bitswan/gitops:latest",
		Domain:           "example.com",
		InfraDriverToken: "persisted-token-42",
	}
	compose, _, err = reuse.CreateDockerComposeFile()
	if err != nil {
		t.Fatal(err)
	}
	if reuse.InfraDriverToken != "persisted-token-42" {
		t.Errorf("provided token was replaced: %q", reuse.InfraDriverToken)
	}
	if !strings.Contains(compose, "BITSWAN_INFRA_DRIVER_TOKEN=persisted-token-42") {
		t.Error("compose does not reuse the provided token")
	}
	if strings.Count(compose, "BITSWAN_INFRA_DRIVER_TOKEN=persisted-token-42") < 2 {
		t.Error("token should reach both gitops env and the driver service argv/env")
	}
}
