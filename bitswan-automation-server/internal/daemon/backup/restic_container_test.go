package backup

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The daemon-less path drives restic through docker, because the machine being
// rebuilt has docker and no restic. These tests pin the two properties that
// matter and are easy to break: the argv is a well-formed `docker run` that
// names restic, and credentials still travel by environment rather than by
// argv — `docker run -e NAME` (no value) would otherwise become
// `-e NAME=secret` in someone's "simplification" and put the repo password in
// the process table.

// fakeDocker installs a shell script as `docker` on PATH, recording argv and
// env the way fakeRestic does.
func fakeDocker(t *testing.T, stdout string) (argvFile, envFile string) {
	t.Helper()
	binDir := t.TempDir()
	argvFile = filepath.Join(binDir, "argv")
	envFile = filepath.Join(binDir, "env")
	script := "#!/bin/sh\n" +
		"echo \"$@\" >> " + argvFile + "\n" +
		"env > " + envFile + "\n"
	if stdout != "" {
		script += "cat <<'EOF'\n" + stdout + "\nEOF\n"
	}
	if err := os.WriteFile(filepath.Join(binDir, "docker"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+":"+os.Getenv("PATH"))
	return argvFile, envFile
}

func containerRestic(t *testing.T, exec *ContainerExec) *Restic {
	t.Helper()
	restic := NewRestic(NewAOCTarget("https://aoc.example.com", "srv-123", "tok-abc"), "s3cret-key")
	restic.Container = exec
	return restic
}

func TestContainerExecRunsResticInDocker(t *testing.T) {
	argvFile, envFile := fakeDocker(t, "")
	restic := containerRestic(t, NewContainerExec("").WithConfigVolume())

	if _, _, err := restic.Run(context.Background(), "snapshots", "--json"); err != nil {
		t.Fatal(err)
	}

	argv := readFile(t, argvFile)
	for _, want := range []string{
		"run --rm -i",
		"--entrypoint restic " + DefaultRuntimeImage,
		"snapshots --json",
		// The volume must land where the snapshot's absolute paths expect it,
		// or `restore --target /` reconstructs into a throwaway container.
		"-v " + BitswanConfigVolume + ":/root/.config/bitswan",
	} {
		if !strings.Contains(argv, want) {
			t.Errorf("docker argv missing %q\ngot: %s", want, argv)
		}
	}

	// Every credential is named but not valued on the command line...
	for _, name := range []string{
		"RESTIC_REPOSITORY", "RESTIC_REST_USERNAME", "RESTIC_REST_PASSWORD", "RESTIC_PASSWORD",
	} {
		if !strings.Contains(argv, "-e "+name) {
			t.Errorf("docker argv should pass -e %s\ngot: %s", name, argv)
		}
	}
	// ...and the secrets themselves never appear in it.
	for _, secret := range []string{"s3cret-key", "tok-abc"} {
		if strings.Contains(argv, secret) {
			t.Errorf("secret %q leaked into the docker argv: %s", secret, argv)
		}
	}

	// They reach docker through its environment instead.
	env := readFile(t, envFile)
	if !strings.Contains(env, "RESTIC_PASSWORD=s3cret-key") {
		t.Errorf("RESTIC_PASSWORD not in docker's env: %s", env)
	}
	if !strings.Contains(env, "RESTIC_REPOSITORY=rest:https://aoc.example.com/api/automation_server/backups/repo/") {
		t.Errorf("repo URL not in docker's env: %s", env)
	}
}

func TestContainerExecJoinsNetworkOnlyForLocalhostAOC(t *testing.T) {
	argvFile, _ := fakeDocker(t, "")
	restic := containerRestic(t, NewContainerExec("custom/image:v1"))
	if _, _, err := restic.Run(context.Background(), "cat", "config"); err != nil {
		t.Fatal(err)
	}
	if argv := readFile(t, argvFile); strings.Contains(argv, "--network") {
		t.Errorf("a public AOC needs no docker network: %s", argv)
	}

	// A .localhost AOC resolves nowhere but the bitswan network.
	local := NewAOCTarget("https://aoc.bitswan.localhost", "srv-123", "tok-abc")
	if !local.InDockerNetwork() {
		t.Fatal("a .localhost AOC should require the docker network")
	}
	argvFile2, _ := fakeDocker(t, "")
	restic2 := NewRestic(local, "key")
	restic2.Container = NewContainerExec("").OnBitswanNetwork()
	if _, _, err := restic2.Run(context.Background(), "cat", "config"); err != nil {
		t.Fatal(err)
	}
	if argv := readFile(t, argvFile2); !strings.Contains(argv, "--network "+BitswanNetwork) {
		t.Errorf("expected --network %s, got: %s", BitswanNetwork, argv)
	}
}

func TestContainerExecUsesTheImageTheBackupRecorded(t *testing.T) {
	// daemon_image names the restic that WROTE the repo, so an explicit image
	// must win over the default.
	argvFile, _ := fakeDocker(t, "")
	restic := containerRestic(t, NewContainerExec("bitswan/automation-server-runtime:2024-05"))
	if _, _, err := restic.Run(context.Background(), "version"); err != nil {
		t.Fatal(err)
	}
	argv := readFile(t, argvFile)
	if !strings.Contains(argv, "bitswan/automation-server-runtime:2024-05") {
		t.Errorf("recorded image not used: %s", argv)
	}
	if strings.Contains(argv, DefaultRuntimeImage) {
		t.Errorf("default image used despite an explicit one: %s", argv)
	}
}

func TestReadServerManifestThroughContainer(t *testing.T) {
	// The whole bootstrap, end to end against a fake docker: a machine with no
	// daemon and no config file reads what the server was.
	manifestJSON := `{"schema_version":1,"bitswan_version":"1.2.3",` +
		`"daemon_image":"bitswan/automation-server-runtime:latest","server_id":"srv-123",` +
		`"workspaces":[{"name":"tenant-a","enabled":{"postgres":["production"]}}]}`
	argvFile, _ := fakeDocker(t, manifestJSON)
	restic := containerRestic(t, NewContainerExec(""))

	manifest, err := ReadServerManifest(context.Background(), restic, "")
	if err != nil {
		t.Fatal(err)
	}
	if manifest.ServerID != "srv-123" || len(manifest.Workspaces) != 1 {
		t.Fatalf("manifest not parsed: %+v", manifest)
	}
	argv := readFile(t, argvFile)
	// "latest" must be scoped to the server series, or it resolves to whatever
	// snapshot is newest — usually a workspace's, which has no manifest.
	if !strings.Contains(argv, "dump --tag server-config latest") {
		t.Errorf("expected a server-scoped dump, got: %s", argv)
	}

	if warning := CheckVersionSkew(manifest, "1.2.3"); warning != "" {
		t.Errorf("no skew expected: %s", warning)
	}
	warning := CheckVersionSkew(manifest, "2.0.0")
	if !strings.Contains(warning, "1.2.3") || !strings.Contains(warning, "2.0.0") {
		t.Errorf("skew warning should name both versions: %q", warning)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}
