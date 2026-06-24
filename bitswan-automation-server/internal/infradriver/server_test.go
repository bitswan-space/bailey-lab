package infradriver

import (
	"context"
	"errors"
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
}

func (f *fakeDriver) Apply(_ context.Context, _ ApplyRequest, _ func(Progress)) ([]Route, error) {
	f.applyCalled = true
	return nil, nil
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

func newTestPair(d Driver) (*Client, func()) {
	ts := httptest.NewServer(NewServer(d).Handler())
	return newClientFor(ts.Client(), ts.URL), ts.Close
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

func TestContainerRestartError(t *testing.T) {
	fd := &fakeDriver{restartErr: errors.New("no such container")}
	client, closeFn := newTestPair(fd)
	defer closeFn()

	err := client.ContainerRestart(context.Background(), WorkspaceContext{}, "nope")
	if err == nil {
		t.Fatal("expected an error")
	}
}
