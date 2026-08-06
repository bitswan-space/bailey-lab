package backup

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestMain poisons the image backup's docker touch-points for the whole package.
//
// Any test that reaches RunAll without calling fakeInternalImages would otherwise
// inventory and `docker save` every real image on the host: gigabytes of IO inside a
// unit test, a different result on every machine, and no failure to point at it.
// Three tests did exactly that before this existed. Failing loudly with the name of
// the fix is the difference between noticing and not.
func TestMain(m *testing.M) {
	dockerImagesLister = func(context.Context) (string, error) {
		return "", fmt.Errorf("this test reaches the image backup without stubbing it — " +
			"call fakeInternalImages(t, …)")
	}
	dockerSaveCommand = func(ctx context.Context, _ []string) *exec.Cmd {
		return exec.CommandContext(ctx, "false")
	}
	os.Exit(m.Run())
}

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
		"env > " + envFile + "\n" +
		// Real `restic backup --stdin` reads its input to EOF. A fake that exits
		// without draining leaves the writer holding a full pipe and killed by
		// SIGPIPE, so the caller correctly reports a truncated archive -- a fake
		// failure that looks exactly like a real one. Reading nothing is fine for
		// every other invocation: stdin is /dev/null there, so cat returns at once.
		"cat >/dev/null 2>/dev/null || true\n"
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

// fakeInternalImages replaces the two docker touch-points of the image backup:
// the inventory, and the command that produces the archive. Without it a test that
// reaches RunAll streams every real image on the host through restic -- gigabytes
// of IO in a unit test, and a different result on every machine.
//
// `inventory` is raw `docker images` output ("<id>\t<repo>:<tag>" lines).
func fakeInternalImages(t *testing.T, inventory string) *[]string {
	t.Helper()
	savedList, savedSave := dockerImagesLister, dockerSaveCommand
	t.Cleanup(func() { dockerImagesLister, dockerSaveCommand = savedList, savedSave })

	var savedTags []string
	dockerImagesLister = func(context.Context) (string, error) { return inventory, nil }
	dockerSaveCommand = func(ctx context.Context, tags []string) *exec.Cmd {
		savedTags = append([]string{}, tags...)
		// Stands in for a real archive: a few bytes on stdout, exit 0.
		return exec.CommandContext(ctx, "sh", "-c", "printf 'fake-image-archive'")
	}
	return &savedTags
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
	if target.InDockerNetwork() {
		t.Error("a public AOC should not need the docker network")
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

// EnsureEnabled must mint a key when none exists and must NEVER send it
// anywhere: there is no escrow, by policy.
func TestEnsureEnabled(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	// Not AOC-registered: not runnable, no error.
	status, err := EnsureEnabled(context.Background())
	if err != nil || status.Runnable() {
		t.Fatalf("unregistered: status=%+v err=%v", status, err)
	}

	// Record every request the backup package makes, so an accidental
	// re-introduction of key escrow shows up as a test failure.
	var paths []string
	aoc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		w.WriteHeader(http.StatusOK)
	}))
	defer aoc.Close()

	writeServerConfig(t, aoc.URL)
	fakeRestic(t, 0, "")

	status, err = EnsureEnabled(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !status.Runnable() {
		t.Fatalf("status = %+v, want runnable", status)
	}
	key, _ := LoadKey()
	if key == "" {
		t.Fatal("no key was minted")
	}
	for _, p := range paths {
		if strings.Contains(p, "restic-key") {
			t.Errorf("the key was sent to %s — it must never leave this server", p)
		}
	}

	// A rebuilt server has no key and nothing to recover it from, so it mints
	// a fresh one (a NEW repo) rather than silently reusing anything.
	t.Setenv("HOME", t.TempDir())
	writeServerConfig(t, aoc.URL)
	status, err = EnsureEnabled(context.Background())
	if err != nil || !status.Runnable() {
		t.Fatalf("rebuilt: status=%+v err=%v", status, err)
	}
	if fresh, _ := LoadKey(); fresh == "" || fresh == key {
		t.Errorf("rebuilt server key = %q, want a new one", fresh)
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

// The unsaved-key warning is the only thing standing between an operator and
// unrestorable backups, so it must appear until acknowledged.
func TestUnsavedKeyWarning(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	if w := UnsavedKeyWarning(); w != "" {
		t.Errorf("no key yet, warning = %q, want empty", w)
	}
	if err := SaveKey("some-key"); err != nil {
		t.Fatal(err)
	}
	if w := UnsavedKeyWarning(); w == "" || !strings.Contains(w, "KEY NOT SAVED") {
		t.Errorf("unacknowledged key, warning = %q", w)
	}
	if KeyAcknowledged() {
		t.Error("acknowledged before anyone acknowledged")
	}
	if err := AcknowledgeKey(); err != nil {
		t.Fatal(err)
	}
	if !KeyAcknowledged() || UnsavedKeyWarning() != "" {
		t.Error("acknowledgement did not silence the warning")
	}
}
