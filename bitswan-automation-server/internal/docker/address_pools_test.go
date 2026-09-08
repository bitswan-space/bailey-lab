package docker

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const exhaustedStderr = "Error response from daemon: all predefined address pools have been fully subnetted"

func fakeDocker(t *testing.T, script string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return dir
}

func createFails(t *testing.T, stderr string) string {
	return fakeDocker(t, `
case "$2" in
  ls) echo '{"Name":"bridge"}' ;;
  create) echo `+shellQuote(stderr)+` >&2; touch "$MARKER"; exit 1 ;;
esac
`)
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func TestAddressPoolsExhausted_MatchesDockersOwnWording(t *testing.T) {
	if !AddressPoolsExhausted(exhaustedStderr) {
		t.Error("did not recognise the message Docker actually prints")
	}
	if !AddressPoolsExhausted(strings.ToUpper(exhaustedStderr)) {
		t.Error("matching must not depend on case")
	}
}

func TestAddressPoolsExhausted_IgnoresUnrelatedFailures(t *testing.T) {
	for _, msg := range []string{
		"Error response from daemon: network with name foo already exists",
		"Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
		"",
	} {
		if AddressPoolsExhausted(msg) {
			t.Errorf("wrongly treated %q as pool exhaustion", msg)
		}
	}
}

func TestEnsureDockerNetwork_ExhaustionIsReportedNotSwallowed(t *testing.T) {
	dir := createFails(t, exhaustedStderr)
	t.Setenv("MARKER", filepath.Join(dir, "created"))

	ok, err := EnsureDockerNetwork("ws-dev", false)

	if err == nil {
		t.Fatal("no error: the caller would carry on as if the network existed")
	}
	if ok {
		t.Error("reported the network as ensured when creating it failed")
	}
	if !IsAddressPoolsExhausted(err) {
		t.Errorf("error is not recognisable as pool exhaustion: %v", err)
	}
}

func TestEnsureDockerNetwork_ExhaustionSaysHowToFixIt(t *testing.T) {
	dir := createFails(t, exhaustedStderr)
	t.Setenv("MARKER", filepath.Join(dir, "created"))

	_, err := EnsureDockerNetwork("ws-dev", false)

	if err == nil {
		t.Fatal("a failed create reported success")
	}
	msg := err.Error()
	for _, want := range []string{
		"/etc/docker/daemon.json",
		"default-address-pools",
		`"base": "10.0.0.0/12"`,
		`"size": 27`,
		"systemctl restart docker",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("the operator is never told about %q:\n%s", want, msg)
		}
	}
}

func TestEnsureDockerNetwork_NamesTheNetworkItCouldNotCreate(t *testing.T) {
	dir := createFails(t, exhaustedStderr)
	t.Setenv("MARKER", filepath.Join(dir, "created"))

	_, err := EnsureDockerNetwork("meridian-production", false)

	if err == nil {
		t.Fatal("a failed create reported success")
	}
	if !strings.Contains(err.Error(), "meridian-production") {
		t.Errorf("error does not say which network failed: %v", err)
	}
}

func TestEnsureDockerNetwork_ConcurrentCreateIsNotAFailure(t *testing.T) {
	dir := createFails(t, "Error response from daemon: network with name ws-dev already exists")
	t.Setenv("MARKER", filepath.Join(dir, "created"))

	ok, err := EnsureDockerNetwork("ws-dev", false)

	if err != nil {
		t.Errorf("losing the create race must not be an error: %v", err)
	}
	if !ok {
		t.Error("the network does exist, so it is ensured")
	}
}

func TestEnsureDockerNetwork_OtherFailuresKeepDockersMessage(t *testing.T) {
	dir := createFails(t, "Error response from daemon: something else went wrong")
	t.Setenv("MARKER", filepath.Join(dir, "created"))

	_, err := EnsureDockerNetwork("ws-dev", false)

	if err == nil {
		t.Fatal("a failed create reported success")
	}
	if !strings.Contains(err.Error(), "something else went wrong") {
		t.Errorf("Docker's own message was dropped: %v", err)
	}
	if IsAddressPoolsExhausted(err) {
		t.Error("an unrelated failure was blamed on the address pools")
	}
}

func TestEnsureDockerNetwork_ExistingNetworkIsNotRecreated(t *testing.T) {
	dir := fakeDocker(t, `
case "$2" in
  ls) echo '{"Name":"bridge"}'; echo '{"Name":"ws-dev"}' ;;
  create) touch "$MARKER"; exit 0 ;;
esac
`)
	marker := filepath.Join(dir, "created")
	t.Setenv("MARKER", marker)

	ok, err := EnsureDockerNetwork("ws-dev", false)

	if err != nil || !ok {
		t.Fatalf("EnsureDockerNetwork(existing) = %v, %v; want true, nil", ok, err)
	}
	if _, statErr := os.Stat(marker); statErr == nil {
		t.Error("tried to create a network that already exists")
	}
}

func TestEnsureDockerNetwork_SucceedsWhenDockerDoes(t *testing.T) {
	dir := fakeDocker(t, `
case "$2" in
  ls) echo '{"Name":"bridge"}' ;;
  create) touch "$MARKER"; exit 0 ;;
esac
`)
	marker := filepath.Join(dir, "created")
	t.Setenv("MARKER", marker)

	ok, err := EnsureDockerNetwork("ws-dev", false)

	if err != nil || !ok {
		t.Fatalf("EnsureDockerNetwork = %v, %v; want true, nil", ok, err)
	}
	if _, statErr := os.Stat(marker); statErr != nil {
		t.Error("never ran docker network create")
	}
}
