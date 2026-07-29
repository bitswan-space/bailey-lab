package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeWorkspaceFiles(t *testing.T, name, metadataYAML, composeYAML string) {
	t.Helper()
	wsDir := filepath.Join(WorkspacesDir(), name)
	if err := os.MkdirAll(filepath.Join(wsDir, "deployment"), 0o755); err != nil {
		t.Fatal(err)
	}
	if metadataYAML != "" {
		if err := os.WriteFile(filepath.Join(wsDir, "metadata.yaml"), []byte(metadataYAML), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if composeYAML != "" {
		if err := os.WriteFile(filepath.Join(wsDir, "deployment", "docker-compose.yml"), []byte(composeYAML), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

const legacyCompose = `services:
  bitswan-gitops:
    image: bitswan/gitops:latest
    environment:
      - BITSWAN_GITOPS_SECRET=gitops-secret-1
      - BITSWAN_INFRA_DRIVER_TOKEN=driver-token-from-compose
`

func TestMetadataInfraDriverTokenRoundtrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	meta := WorkspaceMetadata{
		Domain:           "example.com",
		GitopsURL:        "https://ws-gitops.example.com",
		GitopsSecret:     "s",
		InfraDriverToken: "tok-123",
	}
	if err := SaveWorkspaceMetadata("ws1", meta); err != nil {
		t.Fatal(err)
	}
	got, err := GetWorkspaceMetadata("ws1")
	if err != nil {
		t.Fatal(err)
	}
	if got.InfraDriverToken != "tok-123" {
		t.Errorf("InfraDriverToken = %q", got.InfraDriverToken)
	}
}

func TestGetInfraDriverTokenPrefersMetadata(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	writeWorkspaceFiles(t, "ws1",
		"domain: example.com\ngitops-url: u\ngitops-secret: s\ninfra-driver-token: from-metadata\n",
		legacyCompose,
	)
	token, err := GetInfraDriverToken("ws1")
	if err != nil {
		t.Fatal(err)
	}
	if token != "from-metadata" {
		t.Errorf("token = %q, want from-metadata", token)
	}
}

func TestGetInfraDriverTokenComposeFallbackWritesBack(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	// Pre-persistence workspace: metadata without the token, compose with it.
	writeWorkspaceFiles(t, "ws1",
		"domain: example.com\ngitops-url: u\ngitops-secret: s\n",
		legacyCompose,
	)

	token, err := GetInfraDriverToken("ws1")
	if err != nil {
		t.Fatal(err)
	}
	if token != "driver-token-from-compose" {
		t.Errorf("token = %q, want compose fallback", token)
	}

	// Opportunistic migration: the fallback result is now in metadata.
	meta, err := GetWorkspaceMetadata("ws1")
	if err != nil {
		t.Fatal(err)
	}
	if meta.InfraDriverToken != "driver-token-from-compose" {
		t.Errorf("metadata after fallback = %q, want write-back", meta.InfraDriverToken)
	}
	if meta.GitopsSecret != "s" || meta.Domain != "example.com" {
		t.Errorf("write-back clobbered other fields: %+v", meta)
	}
}

func TestGetInfraDriverTokenMissingEverywhere(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	writeWorkspaceFiles(t, "ws1",
		"domain: example.com\ngitops-url: u\ngitops-secret: s\n",
		"services:\n  bitswan-gitops:\n    environment:\n      - OTHER=1\n",
	)
	if _, err := GetInfraDriverToken("ws1"); err == nil {
		t.Fatal("expected error when token is nowhere")
	} else if !strings.Contains(err.Error(), "BITSWAN_INFRA_DRIVER_TOKEN") {
		t.Errorf("error should name the missing env var: %v", err)
	}
}

func TestComposeGitopsEnvValueGitopsSecret(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	writeWorkspaceFiles(t, "ws1", "", legacyCompose)
	secret, err := ComposeGitopsEnvValue("ws1", "BITSWAN_GITOPS_SECRET")
	if err != nil || secret != "gitops-secret-1" {
		t.Errorf("secret = %q, %v", secret, err)
	}
}
