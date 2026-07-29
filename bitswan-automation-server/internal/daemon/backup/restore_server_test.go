package backup

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These cover the pre-daemon half of a server recovery, where every operation is
// a throwaway container against a docker volume. Two properties matter most and
// are easy to regress: the restore must be tag-scoped to the server series (a
// bare `latest` resolves to whatever snapshot is newest, usually a workspace's),
// and the encryption key must reach the container on STDIN — never in argv,
// where it would sit in the process table of a machine that was untrusted bare
// metal moments earlier.

// fakeDockerWithStdin is fakeDocker plus a capture of what was piped in.
func fakeDockerWithStdin(t *testing.T, stdout string) (argvFile, stdinFile string) {
	t.Helper()
	binDir := t.TempDir()
	argvFile = filepath.Join(binDir, "argv")
	stdinFile = filepath.Join(binDir, "stdin")
	script := "#!/bin/sh\n" +
		"echo \"$@\" >> " + argvFile + "\n" +
		"cat > " + stdinFile + " 2>/dev/null || true\n"
	if stdout != "" {
		script += "cat <<'EOF'\n" + stdout + "\nEOF\n"
	}
	if err := os.WriteFile(filepath.Join(binDir, "docker"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+":"+os.Getenv("PATH"))
	return argvFile, stdinFile
}

func serverRestic(t *testing.T, withContainer bool) *Restic {
	t.Helper()
	r := NewRestic(NewAOCTarget("https://aoc.example.com", "srv-123", "tok-abc"), "the-key")
	if withContainer {
		r.Container = NewContainerExec("").WithConfigVolume()
	}
	return r
}

func TestRestoreServerStateRefusesWithoutAContainer(t *testing.T) {
	// A bare-machine recovery has no restic binary; failing loudly beats
	// exec'ing something that isn't there.
	_, err := RestoreServerState(context.Background(), serverRestic(t, false), "")
	if err == nil {
		t.Fatal("expected an error without a containerised restic")
	}
	if !strings.Contains(err.Error(), "no restic binary") {
		t.Errorf("error should explain why: %v", err)
	}
}

func TestRestoreServerStateScopesLatestToTheServerSeries(t *testing.T) {
	argvFile, _ := fakeDockerWithStdin(t, "Summary: Restored 58 files/dirs (222.212 KiB) in 0:00")

	summary, err := RestoreServerState(context.Background(), serverRestic(t, true), "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(summary, "Restored 58 files/dirs") {
		t.Errorf("summary should be restic's last line, got %q", summary)
	}

	argv := readFile(t, argvFile)
	for _, want := range []string{
		"restore --target / --tag " + serverStateTag + " latest",
		"-v " + BitswanConfigVolume + ":" + configVolumePath,
	} {
		if !strings.Contains(argv, want) {
			t.Errorf("argv missing %q\ngot: %s", want, argv)
		}
	}
}

func TestRestoreServerStateWithExplicitSnapshotSkipsTagScoping(t *testing.T) {
	argvFile, _ := fakeDockerWithStdin(t, "Summary: Restored 1 files/dirs")
	if _, err := RestoreServerState(context.Background(), serverRestic(t, true), "abc123"); err != nil {
		t.Fatal(err)
	}
	argv := readFile(t, argvFile)
	if !strings.Contains(argv, "restore --target / abc123") {
		t.Errorf("explicit snapshot should not be tag-scoped: %s", argv)
	}
}

func TestInstallResticKeyPipesTheKeyAndNeverArgs(t *testing.T) {
	argvFile, stdinFile := fakeDockerWithStdin(t, "installed")
	const key = "s3cret-restic-key-value"

	out, err := InstallResticKey(context.Background(), "", key)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "0600") {
		t.Errorf("report should mention the mode: %q", out)
	}

	argv := readFile(t, argvFile)
	if strings.Contains(argv, key) {
		t.Fatalf("the encryption key leaked into argv: %s", argv)
	}
	if !strings.Contains(argv, "-i") {
		t.Errorf("stdin must be attached: %s", argv)
	}
	if got := strings.TrimSpace(readFile(t, stdinFile)); got != key {
		t.Errorf("key not piped on stdin: %q", got)
	}
}

func TestPromoteBaileyDatabase(t *testing.T) {
	cases := []struct {
		name    string
		stdout  string
		wantErr string
		wantOut string
	}{
		{"fresh restore", "promoted", "", "promoted to bailey.db"},
		{"already promoted", "already promoted", "", "already in place"},
		{"nothing there", "missing", "no users, devices or access grants", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fakeDockerWithStdin(t, tc.stdout)
			out, err := PromoteBaileyDatabase(context.Background(), "")
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want it to mention %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out, tc.wantOut) {
				t.Errorf("out = %q, want it to mention %q", out, tc.wantOut)
			}
		})
	}
}

func TestCheckRestoredServerState(t *testing.T) {
	cases := []struct {
		name    string
		listing string
		wantErr string
	}{
		{
			name:    "a real restore passes",
			listing: "automation_server_config.toml backup bailey.db certauthorities protected-proxy server-manifest.json traefik",
		},
		{
			name:    "empty volume",
			listing: "",
			wantErr: "nothing was recovered",
		},
		{
			// The one failure mode that otherwise looks like success.
			name:    "a pre-real-paths snapshot",
			listing: "staging backup",
			wantErr: "predates real-path server backups",
		},
		{
			name:    "something that isn't a server snapshot",
			listing: "some-other-file another",
			wantErr: "no automation_server_config.toml",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fakeDockerWithStdin(t, tc.listing)
			err := CheckRestoredServerState(context.Background(), "")
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want it to mention %q", err, tc.wantErr)
			}
		})
	}
}

func TestReadRestoredServerIDParsesTheConfig(t *testing.T) {
	fakeDockerWithStdin(t, "35b655bc-464c-40c3-8c71-d10815c0a27f")
	id, err := ReadRestoredServerID(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if id != "35b655bc-464c-40c3-8c71-d10815c0a27f" {
		t.Errorf("server id = %q", id)
	}
}

func TestReadRestoredServerIDIsEmptyOnAFreshMachine(t *testing.T) {
	// No config at all is the normal bare-machine case, not an error — the
	// wrong-server guard must be able to tell "nothing here" from "someone
	// else's server".
	fakeDockerWithStdin(t, "")
	id, err := ReadRestoredServerID(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if id != "" {
		t.Errorf("expected no server id, got %q", id)
	}
}
