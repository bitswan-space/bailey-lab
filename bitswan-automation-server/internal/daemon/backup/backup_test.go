package backup

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeServerConfig makes $HOME/.config/bitswan/automation_server_config.toml
// with an AOC registration, matching what LoadAOCTarget reads.
func writeServerConfig(t *testing.T, aocURL string) {
	t.Helper()
	dir := filepath.Join(os.Getenv("HOME"), ".config", "bitswan")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	toml := `[aoc]
aoc_url = "` + aocURL + `"
automation_server_id = "srv-123"
access_token = "tok-abc"
`
	if err := os.WriteFile(filepath.Join(dir, "automation_server_config.toml"), []byte(toml), 0o644); err != nil {
		t.Fatal(err)
	}
}

// fakeRestic installs a shell script as `restic` on PATH that records its
// argv + env into files and exits with the given code.
func fakeRestic(t *testing.T, exitCode int, stderr string) (argvFile, envFile string) {
	t.Helper()
	binDir := t.TempDir()
	argvFile = filepath.Join(binDir, "argv")
	envFile = filepath.Join(binDir, "env")
	script := "#!/bin/sh\n" +
		"echo \"$@\" >> " + argvFile + "\n" +
		"env > " + envFile + "\n"
	if stderr != "" {
		script += "echo '" + stderr + "' >&2\n"
	}
	script += "exit " + map[int]string{0: "0", 1: "1"}[exitCode] + "\n"
	if err := os.WriteFile(filepath.Join(binDir, "restic"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+":"+os.Getenv("PATH"))
	return argvFile, envFile
}

func TestLoadAOCTarget(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if _, err := LoadAOCTarget(); err == nil {
		t.Fatal("expected error with no server config")
	}

	writeServerConfig(t, "https://aoc.example.com/")
	target, err := LoadAOCTarget()
	if err != nil {
		t.Fatal(err)
	}
	if target.RepoURL() != "https://aoc.example.com/api/automation_server/backups/repo/" {
		t.Errorf("RepoURL = %q", target.RepoURL())
	}
	if target.KeyMirrorURL() != "https://aoc.example.com/api/automation_server/backups/restic-key" {
		t.Errorf("KeyMirrorURL = %q", target.KeyMirrorURL())
	}
	if target.ServerID != "srv-123" || target.Token != "tok-abc" {
		t.Errorf("identity = %q/%q", target.ServerID, target.Token)
	}
}

func TestLoadAOCTargetLocalhostRewrite(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	writeServerConfig(t, "https://aoc.bitswan.localhost")
	target, err := LoadAOCTarget()
	if err != nil {
		t.Fatal(err)
	}
	if target.URL != "http://api.bitswan.localhost" {
		t.Errorf("URL = %q, want dev rewrite", target.URL)
	}
}

func TestConfigDefaultsAndRoundtrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	cfg, exists, err := LoadConfig()
	if err != nil || exists {
		t.Fatalf("LoadConfig = %v, exists=%v", err, exists)
	}
	if !cfg.Enabled || cfg.Retention.Daily != 30 || cfg.Retention.Monthly != 12 {
		t.Errorf("defaults = %+v", cfg)
	}

	cfg.Enabled = false
	cfg.Retention.Daily = 7
	if err := SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	got, exists, err := LoadConfig()
	if err != nil || !exists {
		t.Fatalf("LoadConfig after save = %v, exists=%v", err, exists)
	}
	if got.Enabled || got.Retention.Daily != 7 || got.Retention.Monthly != 12 {
		t.Errorf("roundtrip = %+v", got)
	}
}

func TestKeyLifecycle(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	key, err := LoadKey()
	if err != nil || key != "" {
		t.Fatalf("LoadKey empty = %q, %v", key, err)
	}

	key, err = GenerateKey()
	if err != nil || len(key) < 32 {
		t.Fatalf("GenerateKey = %q, %v", key, err)
	}
	if err := SaveKey(key); err != nil {
		t.Fatal(err)
	}

	got, err := LoadKey()
	if err != nil || got != key {
		t.Fatalf("LoadKey = %q, want %q", got, key)
	}

	info, err := os.Stat(filepath.Join(Dir(), "restic-key"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("key perms = %v, want 0600", info.Mode().Perm())
	}
	dirInfo, err := os.Stat(Dir())
	if err != nil {
		t.Fatal(err)
	}
	if dirInfo.Mode().Perm() != 0o700 {
		t.Errorf("dir perms = %v, want 0700", dirInfo.Mode().Perm())
	}
}

func TestResticEnvAndArgs(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	writeServerConfig(t, "https://aoc.example.com")
	_, envFile := fakeRestic(t, 0, "")

	target, err := LoadAOCTarget()
	if err != nil {
		t.Fatal(err)
	}
	r := NewRestic(target, "the-key")
	if _, _, err := r.Run(context.Background(), "snapshots"); err != nil {
		t.Fatal(err)
	}

	envData, err := os.ReadFile(envFile)
	if err != nil {
		t.Fatal(err)
	}
	env := string(envData)
	for _, want := range []string{
		"RESTIC_REPOSITORY=rest:https://aoc.example.com/api/automation_server/backups/repo/",
		"RESTIC_REST_USERNAME=srv-123",
		"RESTIC_REST_PASSWORD=tok-abc",
		"RESTIC_PASSWORD=the-key",
	} {
		if !strings.Contains(env, want+"\n") {
			t.Errorf("restic env missing %q", want)
		}
	}

	args := r.BackupArgs([]string{"files", "ws:tenant-a"}, "/data/tenant-a")
	want := "backup --host srv-123 --tag files --tag ws:tenant-a /data/tenant-a"
	if got := strings.Join(args, " "); got != want {
		t.Errorf("BackupArgs = %q, want %q", got, want)
	}
}

func TestEnsureRepoToleratesExisting(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	writeServerConfig(t, "https://aoc.example.com")
	target, _ := LoadAOCTarget()
	r := NewRestic(target, "k")

	fakeRestic(t, 1, "Fatal: create repository at rest: failed: config file already exists")
	if err := r.EnsureRepo(context.Background()); err != nil {
		t.Errorf("EnsureRepo on existing repo = %v, want nil", err)
	}

	fakeRestic(t, 1, "Fatal: unable to connect")
	if err := r.EnsureRepo(context.Background()); err == nil {
		t.Error("EnsureRepo on real failure = nil, want error")
	}
}

func TestEnsureEnabled(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	// Not AOC-registered: not runnable, no error.
	status, err := EnsureEnabled(context.Background())
	if err != nil || status.Runnable() {
		t.Fatalf("unregistered: status=%+v err=%v", status, err)
	}

	// Escrow server: no mirrored key yet; accepts PUT.
	var mirroredKey string
	mirror := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/backups/restic-key") {
			// restic init from EnsureRepo also lands here; accept anything.
			w.WriteHeader(http.StatusOK)
			return
		}
		switch r.Method {
		case http.MethodGet:
			if mirroredKey == "" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Write([]byte(mirroredKey))
		case http.MethodPut:
			buf := new(strings.Builder)
			if _, err := io.Copy(buf, r.Body); err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			mirroredKey = buf.String()
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer mirror.Close()

	writeServerConfig(t, mirror.URL)
	fakeRestic(t, 0, "")

	status, err = EnsureEnabled(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !status.Runnable() {
		t.Fatalf("status = %+v, want runnable", status)
	}
	localKey, _ := LoadKey()
	if localKey == "" || mirroredKey != localKey {
		t.Errorf("key not escrowed: local=%q mirrored=%q", localKey, mirroredKey)
	}

	// Rebuilt server: wipe local state, keep the escrow — the key must be
	// recovered, not regenerated.
	t.Setenv("HOME", t.TempDir())
	writeServerConfig(t, mirror.URL)
	status, err = EnsureEnabled(context.Background())
	if err != nil || !status.Runnable() {
		t.Fatalf("rebuilt: status=%+v err=%v", status, err)
	}
	recovered, _ := LoadKey()
	if recovered != mirroredKey {
		t.Errorf("recovered key = %q, want escrowed %q", recovered, mirroredKey)
	}

	// Explicitly disabled: not runnable.
	if err := SaveConfig(Config{Enabled: false, Retention: DefaultRetention}); err != nil {
		t.Fatal(err)
	}
	status, err = EnsureEnabled(context.Background())
	if err != nil || status.Runnable() || !status.AOCConnected {
		t.Fatalf("disabled: status=%+v err=%v", status, err)
	}
}
