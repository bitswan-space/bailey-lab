package backup

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// writeRawConfig puts literal JSON at the config path, so a test can present the
// file an older version would have written.
func writeRawConfig(t *testing.T, body string) error {
	t.Helper()
	if err := ensureDir(); err != nil {
		return err
	}
	return os.WriteFile(configPath(), []byte(body), 0o600)
}

// The image backup exists because rebuilding from the recorded revision reproduces
// the TAG (a hash of the source tree) but not necessarily the BYTES: an unpinned
// `pip install` in image/Dockerfile, a fetching build.sh, or a moved upstream FROM
// all break that. So these tests care about two things above all — that every tag
// reaches the archive, and that a truncated archive is never reported as a success.

func TestInternalImagesDedupesByIDAndKeepsEveryTag(t *testing.T) {
	// Three tags, two images: on a real server most tags alias, because the tag
	// hashes the source tree and many workspaces share one. docker save must still
	// receive all three names, since those are what bitswan.yaml pins.
	fakeInternalImages(t, strings.Join([]string{
		"bbb222\tinternal/ws2-bp-frontend:sha2",
		"aaa111\tinternal/ws1-bp-backend:sha1",
		"aaa111\tinternal/ws9-other-backend:sha1",
		"", // blank lines happen when there are no images at all
	}, "\n"))

	ids, tags, err := internalImages(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(ids, ","); got != "aaa111,bbb222" {
		t.Errorf("ids = %q, want the two distinct images", got)
	}
	want := "internal/ws1-bp-backend:sha1,internal/ws2-bp-frontend:sha2,internal/ws9-other-backend:sha1"
	if got := strings.Join(tags, ","); got != want {
		t.Errorf("tags = %q, want all three sorted: %q", got, want)
	}
}

func TestInternalImagesSkipsDanglingImages(t *testing.T) {
	// An untagged leftover cannot be restored to anything addressable and no
	// deployment can pin it, so saving it would only cost bytes.
	fakeInternalImages(t, "aaa111\tinternal/ws1-bp-backend:sha1\nccc333\tinternal/gone:<none>\n")

	ids, tags, err := internalImages(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || len(tags) != 1 {
		t.Errorf("ids=%v tags=%v, want the dangling image dropped", ids, tags)
	}
}

func TestBackupImagesWithNothingToSaveSucceedsAudibly(t *testing.T) {
	// A server with no business processes yet. Reporting a bare success would be
	// indistinguishable from a save that silently captured nothing.
	t.Setenv("HOME", t.TempDir())
	writeServerConfig(t, "https://aoc.example.com")
	fakeRestic(t, 0, "")
	fakeInternalImages(t, "")

	target, _ := LoadAOCTarget()
	var engine Engine
	result := engine.backupImages(context.Background(), NewRestic(target, "k"))

	if !result.Success {
		t.Errorf("no images is not a failure: %+v", result)
	}
	if !strings.Contains(result.Output, "no internal images") {
		t.Errorf("output should say why nothing was saved: %q", result.Output)
	}
}

func TestBackupImagesStreamsToTheImagesSeries(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	writeServerConfig(t, "https://aoc.example.com")
	argvFile, _ := fakeRestic(t, 0, "")
	fakeInternalImages(t, "aaa111\tinternal/ws1-bp-backend:sha1\n")

	target, _ := LoadAOCTarget()
	var engine Engine
	result := engine.backupImages(context.Background(), NewRestic(target, "k"))
	if !result.Success {
		t.Fatalf("backupImages failed: %+v", result)
	}

	argv := readFile(t, argvFile)
	for _, want := range []string{
		"--tag images",
		"--stdin",
		"--stdin-filename internal-images.tar",
		// Retention groups by host,tags, so the series needs the same explicit
		// host as every other backup or it forms its own group per container.
		"--host srv-123",
	} {
		if !strings.Contains(argv, want) {
			t.Errorf("restic argv missing %q:\n%s", want, argv)
		}
	}
}

// The dangerous failure: restic accepts a stream that docker never finished
// writing. restic exits 0, the snapshot exists, and it holds a truncated archive.
// Reporting that green would put an unrestorable archive on record as a good one.
func TestBackupImagesRefusesATruncatedArchive(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	writeServerConfig(t, "https://aoc.example.com")
	fakeRestic(t, 0, "")
	fakeInternalImages(t, "aaa111\tinternal/ws1-bp-backend:sha1\n")
	// docker writes some bytes, then dies.
	dockerSaveCommand = func(ctx context.Context, _ []string) *exec.Cmd {
		return exec.CommandContext(ctx, "sh", "-c", "printf 'half-an-archive'; exit 3")
	}

	target, _ := LoadAOCTarget()
	var engine Engine
	result := engine.backupImages(context.Background(), NewRestic(target, "k"))

	if result.Success {
		t.Fatal("a truncated archive must not be reported as a successful backup")
	}
	if !strings.Contains(result.Output, "incomplete") {
		t.Errorf("output should name the problem: %q", result.Output)
	}
}

func TestImagesAreOnByDefaultAndSwitchableOff(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	// No config file: on, like every other default.
	cfg, _, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Images {
		t.Error("image backups should be on by default")
	}

	// A config file written before the field existed must keep the default rather
	// than silently reading as false -- that is how an upgrade would quietly stop
	// protecting the thing this feature exists to protect.
	if err := writeRawConfig(t, `{"enabled":true,"retention":{"daily":7,"monthly":3}}`); err != nil {
		t.Fatal(err)
	}
	cfg, exists, err := LoadConfig()
	if err != nil || !exists {
		t.Fatalf("LoadConfig = %v exists=%v", err, exists)
	}
	if !cfg.Images {
		t.Error("a config predating the field must inherit the default, not false")
	}
	if cfg.Retention.Daily != 7 {
		t.Errorf("retention lost: %+v", cfg.Retention)
	}

	// Explicitly off is the one way to disable it.
	if err := writeRawConfig(t, `{"enabled":true,"images":false}`); err != nil {
		t.Fatal(err)
	}
	cfg, _, err = LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Images {
		t.Error("an explicit images:false must switch it off")
	}
}
