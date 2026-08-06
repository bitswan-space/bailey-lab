package backup

import (
	"context"
	"os"
	"strings"
	"testing"
)

// Loading the archive back. The property that matters most is the one that is not
// about success: a backup with no image archive must be a non-event, because
// snapshots predating this feature (and servers with it switched off) still have to
// recover — gitops rebuilds the images from the recorded revisions instead.

// fakeDockerLoad replaces `docker load` with a recorder, returning what it read and
// reporting the tags it claims to have loaded.
func fakeDockerLoad(t *testing.T, loaded []string, fail error) *string {
	t.Helper()
	saved := dockerLoadRunner
	t.Cleanup(func() { dockerLoadRunner = saved })

	var got string
	dockerLoadRunner = func(_ context.Context, stdin *os.File) (string, error) {
		buf := make([]byte, 4096)
		n, _ := stdin.Read(buf)
		got = string(buf[:n])
		var out strings.Builder
		for _, tag := range loaded {
			out.WriteString("Loaded image: " + tag + "\n")
		}
		return out.String(), fail
	}
	return &got
}

func TestRestoreImagesLoadsTheArchive(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	writeServerConfig(t, "https://aoc.example.com")
	argvFile := fakeResticScript(t, "printf 'THE-ARCHIVE'\n")
	streamed := fakeDockerLoad(t,
		[]string{"internal/ws1-bp-backend:sha1", "internal/ws1-bp-frontend:sha2"}, nil)

	target, _ := LoadAOCTarget()
	result, err := RestoreImages(context.Background(), NewRestic(target, "k"), "")
	if err != nil {
		t.Fatalf("RestoreImages: %v", err)
	}
	if result.Missing {
		t.Error("a present archive must not report Missing")
	}
	if len(result.Loaded) != 2 {
		t.Errorf("Loaded = %v, want both tags", result.Loaded)
	}
	if *streamed != "THE-ARCHIVE" {
		t.Errorf("docker load received %q, want restic's output piped straight through", *streamed)
	}

	argv := readFile(t, argvFile)
	for _, want := range []string{
		// Scoped to the image series: unscoped "latest" resolves to whatever
		// snapshot is newest, usually a workspace's, which holds no archive.
		"--tag images",
		"/internal-images.tar",
		// The archive may be read while authenticated with a recovery OTP, which
		// grants reads only -- and taking a lock is a write.
		"--no-lock",
	} {
		if !strings.Contains(argv, want) {
			t.Errorf("restic argv missing %q:\n%s", want, argv)
		}
	}
}

// Both stderr strings are verbatim restic 0.17.3, captured by running the real
// thing against a real repository — not invented. Inventing them is how this
// classification silently stops working after a restic upgrade.
func TestRestoreImagesTreatsAnAbsentArchiveAsANonEvent(t *testing.T) {
	for _, tc := range []struct {
		name   string
		stderr string
	}{
		{
			// No image snapshot at all: a backup made before this feature, or a
			// server with image backups switched off.
			name: "no image snapshot yet",
			stderr: "Fatal: failed to find snapshot: snapshot filter " +
				"(Paths:[] Tags:[[images]] Hosts:[]): no snapshot found",
		},
		{
			name:   "snapshot without the archive",
			stderr: `Fatal: cannot dump file: path "/internal-images.tar" not found in snapshot`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			writeServerConfig(t, "https://aoc.example.com")
			fakeResticScript(t, "echo '"+tc.stderr+"' >&2\nexit 1\n")
			fakeDockerLoad(t, nil, nil)

			target, _ := LoadAOCTarget()
			result, err := RestoreImages(context.Background(), NewRestic(target, "k"), "")
			if err != nil {
				t.Fatalf("an absent archive must not be an error: %v", err)
			}
			if !result.Missing {
				t.Error("result should say the archive is simply absent")
			}
		})
	}
}

func TestRestoreImagesReportsARealResticFailure(t *testing.T) {
	// Distinct from the case above: the repository is unreachable, which is a
	// genuine problem and must not be mistaken for "no archive here".
	t.Setenv("HOME", t.TempDir())
	writeServerConfig(t, "https://aoc.example.com")
	fakeResticScript(t, "echo 'Fatal: unable to open config file: connection refused' >&2\nexit 1\n")
	fakeDockerLoad(t, nil, nil)

	target, _ := LoadAOCTarget()
	result, err := RestoreImages(context.Background(), NewRestic(target, "k"), "")
	if err == nil {
		t.Fatal("an unreachable repository must surface as an error")
	}
	if result.Missing {
		t.Error("an unreachable repository is not an absent archive")
	}
}

// An archive that restores but loads nothing is worse than one that is absent: the
// converge would then fail on a missing image with no explanation, so say it plainly
// and let the rebuild path take over.
func TestRestoreImagesRejectsAnArchiveThatLoadsNothing(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	writeServerConfig(t, "https://aoc.example.com")
	fakeResticScript(t, "printf 'JUNK'\n")
	fakeDockerLoad(t, nil, nil)

	target, _ := LoadAOCTarget()
	if _, err := RestoreImages(context.Background(), NewRestic(target, "k"), ""); err == nil {
		t.Fatal("loading zero images from a present archive must be an error")
	}
}

func TestParseLoadedTags(t *testing.T) {
	out := "Loaded image: internal/a:sha1\n" +
		"Loaded image ID: sha256:deadbeef\n" + // no tag: not addressable, ignored
		"Loaded image: internal/b:sha2\n"
	got := parseLoadedTags(out)
	if strings.Join(got, ",") != "internal/a:sha1,internal/b:sha2" {
		t.Errorf("parseLoadedTags = %v", got)
	}
}
