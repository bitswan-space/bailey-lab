package infradriver

import (
	"context"
	"errors"
	"io"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

// fakeDriver is a programmable Driver for transport tests.
type fakeDriver struct {
	containers  []Container
	gotFilter   ContainerFilter
	logLines    []LogLine
	logsErr     error
	stopped     string
	restarted   string
	restartErr  error
	applyCalled bool
	buildLogs   []string
	buildImage  ImageRef
	buildErr    error
	execSpec    ExecSpec
	execStdin   []byte
	execStdout  []byte
	execStderr  []byte
	execCode    int
}

func (f *fakeDriver) Apply(_ context.Context, _ ApplyRequest, _ func(Progress)) ([]Route, error) {
	f.applyCalled = true
	return nil, nil
}

func (f *fakeDriver) BuildImage(_ context.Context, _ BuildRequest, prog func(string)) (ImageRef, error) {
	for _, l := range f.buildLogs {
		prog(l)
	}
	return f.buildImage, f.buildErr
}

func (f *fakeDriver) ContainerList(_ context.Context, _ WorkspaceContext, filter ContainerFilter) ([]Container, error) {
	f.gotFilter = filter
	return f.containers, nil
}

func (f *fakeDriver) ContainerLogs(_ context.Context, _ WorkspaceContext, _ string, _ int, _ bool, sink func(LogLine)) error {
	for _, l := range f.logLines {
		sink(l)
	}
	return f.logsErr
}

func (f *fakeDriver) ContainerStop(_ context.Context, _ WorkspaceContext, container string) error {
	f.stopped = container
	return nil
}

func (f *fakeDriver) ContainerRestart(_ context.Context, _ WorkspaceContext, container string) error {
	f.restarted = container
	return f.restartErr
}

func (f *fakeDriver) ContainerExec(_ context.Context, _ WorkspaceContext, spec ExecSpec, in io.Reader, out func(bool, []byte)) (int, error) {
	f.execSpec = spec
	if in != nil {
		f.execStdin, _ = io.ReadAll(in)
	}
	if len(f.execStdout) > 0 {
		out(false, f.execStdout)
	}
	if len(f.execStderr) > 0 {
		out(true, f.execStderr)
	}
	return f.execCode, nil
}

func newTestPair(d Driver) (*Client, func()) {
	ts := httptest.NewServer(NewServer(d).Handler())
	return newClientFor(ts.Client(), ts.URL), ts.Close
}

func TestBuildImageStreamsLogsThenImage(t *testing.T) {
	fd := &fakeDriver{
		buildLogs:  []string{"Step 1/3", "Step 2/3", "Step 3/3"},
		buildImage: ImageRef{FullTag: "internal/acme-frontend:sha1", ImageID: "sha256:abc", CacheHit: false},
	}
	client, closeFn := newTestPair(fd)
	defer closeFn()

	var logs []string
	img, err := client.BuildImage(context.Background(),
		BuildRequest{Ctx: WorkspaceContext{WorkspaceName: "acme"}, SourcePath: "/repo/src", BaseImage: "node:20", SourceSHA: "sha1"},
		func(l string) { logs = append(logs, l) })
	if err != nil {
		t.Fatalf("BuildImage: %v", err)
	}
	if !reflect.DeepEqual(logs, fd.buildLogs) {
		t.Errorf("build logs = %v, want %v", logs, fd.buildLogs)
	}
	if img != fd.buildImage {
		t.Errorf("image = %+v, want %+v", img, fd.buildImage)
	}
}

func TestContainerListRoundTrip(t *testing.T) {
	fd := &fakeDriver{containers: []Container{
		{ID: "abc", Name: "acme-frontend-dev", State: "running", Health: "healthy",
			Labels: map[string]string{"gitops.stage": "dev"}},
	}}
	client, closeFn := newTestPair(fd)
	defer closeFn()

	got, err := client.ContainerList(context.Background(),
		WorkspaceContext{WorkspaceName: "acme"},
		ContainerFilter{Labels: map[string]string{"gitops.stage": "dev"}})
	if err != nil {
		t.Fatalf("ContainerList: %v", err)
	}
	if !reflect.DeepEqual(got, fd.containers) {
		t.Errorf("containers = %v, want %v", got, fd.containers)
	}
	if fd.gotFilter.Labels["gitops.stage"] != "dev" {
		t.Errorf("filter not propagated: %v", fd.gotFilter)
	}
}

func TestContainerLogsStream(t *testing.T) {
	fd := &fakeDriver{logLines: []LogLine{
		{Line: "starting"}, {Line: "listening on :8080"}, {Line: "warn: x", Stderr: true},
	}}
	client, closeFn := newTestPair(fd)
	defer closeFn()

	var got []LogLine
	if err := client.ContainerLogs(context.Background(), WorkspaceContext{}, "c", 100, false,
		func(l LogLine) { got = append(got, l) }); err != nil {
		t.Fatalf("ContainerLogs: %v", err)
	}
	if !reflect.DeepEqual(got, fd.logLines) {
		t.Errorf("log lines = %v, want %v", got, fd.logLines)
	}
}

func TestContainerLogsError(t *testing.T) {
	fd := &fakeDriver{
		logLines: []LogLine{{Line: "one"}},
		logsErr:  errors.New("container gone"),
	}
	client, closeFn := newTestPair(fd)
	defer closeFn()

	var got []LogLine
	err := client.ContainerLogs(context.Background(), WorkspaceContext{}, "c", 0, true,
		func(l LogLine) { got = append(got, l) })
	if err == nil {
		t.Fatal("expected an error from the terminal error frame")
	}
	if len(got) != 1 {
		t.Errorf("log lines before error = %d, want 1", len(got))
	}
	if want := "container gone"; !strings.Contains(err.Error(), want) {
		t.Errorf("error = %q, want it to contain %q", err.Error(), want)
	}
}

func TestContainerStopAndRestart(t *testing.T) {
	fd := &fakeDriver{}
	client, closeFn := newTestPair(fd)
	defer closeFn()

	if err := client.ContainerStop(context.Background(), WorkspaceContext{}, "c1"); err != nil {
		t.Fatalf("ContainerStop: %v", err)
	}
	if fd.stopped != "c1" {
		t.Errorf("stopped = %q, want c1", fd.stopped)
	}
	if err := client.ContainerRestart(context.Background(), WorkspaceContext{}, "c2"); err != nil {
		t.Fatalf("ContainerRestart: %v", err)
	}
	if fd.restarted != "c2" {
		t.Errorf("restarted = %q, want c2", fd.restarted)
	}
}

func TestContainerExecRoundTrip(t *testing.T) {
	fd := &fakeDriver{
		execStdout: []byte{0x00, 0x01, 0x02, 'P', 'G', 0xff}, // binary-safe (a dump)
		execStderr: []byte("pg_dump: done"),
		execCode:   0,
	}
	client, closeFn := newTestPair(fd)
	defer closeFn()

	var gotOut, gotErr []byte
	code, err := client.ContainerExec(context.Background(), WorkspaceContext{WorkspaceName: "acme"},
		ExecSpec{Container: "acme-postgres", Cmd: []string{"pg_dump", "-Fc", "db"}},
		strings.NewReader("stdin-payload"),
		func(stderr bool, chunk []byte) {
			if stderr {
				gotErr = append(gotErr, chunk...)
			} else {
				gotOut = append(gotOut, chunk...)
			}
		})
	if err != nil {
		t.Fatalf("ContainerExec: %v", err)
	}
	if code != 0 {
		t.Errorf("exit code = %d, want 0", code)
	}
	if !reflect.DeepEqual(gotOut, fd.execStdout) {
		t.Errorf("stdout = %v, want %v (binary must round-trip)", gotOut, fd.execStdout)
	}
	if string(gotErr) != "pg_dump: done" {
		t.Errorf("stderr = %q", gotErr)
	}
	if string(fd.execStdin) != "stdin-payload" {
		t.Errorf("stdin not streamed to driver: %q", fd.execStdin)
	}
	if !reflect.DeepEqual(fd.execSpec.Cmd, []string{"pg_dump", "-Fc", "db"}) {
		t.Errorf("spec.Cmd = %v", fd.execSpec.Cmd)
	}
}

func TestContainerExecNonZeroExit(t *testing.T) {
	fd := &fakeDriver{execStderr: []byte("psql: FATAL"), execCode: 1}
	client, closeFn := newTestPair(fd)
	defer closeFn()

	code, err := client.ContainerExec(context.Background(), WorkspaceContext{}, ExecSpec{Container: "c", Cmd: []string{"false"}}, nil,
		func(bool, []byte) {})
	if err != nil {
		t.Fatalf("ContainerExec: %v", err)
	}
	if code != 1 {
		t.Errorf("exit code = %d, want 1", code)
	}
}

func TestContainerRestartError(t *testing.T) {
	fd := &fakeDriver{restartErr: errors.New("no such container")}
	client, closeFn := newTestPair(fd)
	defer closeFn()

	err := client.ContainerRestart(context.Background(), WorkspaceContext{}, "nope")
	if err == nil {
		t.Fatal("expected an error")
	}
}
