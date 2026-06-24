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
	applyProgress []Progress
	applyRoutes   []Route
	applyErr      error
	statusStates  []DeploymentState
}

func (f *fakeDriver) Apply(_ context.Context, _ ApplyRequest, prog func(Progress)) ([]Route, error) {
	for _, p := range f.applyProgress {
		prog(p)
	}
	if f.applyErr != nil {
		return nil, f.applyErr
	}
	return f.applyRoutes, nil
}
func (f *fakeDriver) BuildImage(_ context.Context, _ BuildRequest, _ func(string)) (ImageRef, error) {
	return ImageRef{}, nil
}
func (f *fakeDriver) Snapshot(_ context.Context, _ SnapshotRequest, _ func(Progress)) error {
	return nil
}
func (f *fakeDriver) Restore(_ context.Context, _ RestoreRequest, _ func(Progress)) error { return nil }
func (f *fakeDriver) Status(_ context.Context, _ WorkspaceContext, _ []string) ([]DeploymentState, error) {
	return f.statusStates, nil
}
func (f *fakeDriver) Logs(_ context.Context, _ WorkspaceContext, _ string, _ int, _ bool, _ func(LogLine)) error {
	return nil
}
func (f *fakeDriver) WatchEvents(_ context.Context, _ WorkspaceContext, _ func(Event)) error {
	return nil
}

func newTestPair(d Driver) (*Client, func()) {
	ts := httptest.NewServer(NewServer(d).Handler())
	return newClientFor(ts.Client(), ts.URL), ts.Close
}

func TestApplyStreamsProgressAndRoutes(t *testing.T) {
	fd := &fakeDriver{
		applyProgress: []Progress{
			{Step: "generating_compose", Message: "Generating…"},
			{Step: "reconciling_ingress", Message: "Routing…"},
		},
		applyRoutes: []Route{{Hostname: "a.example", Upstream: "a:8080", Stage: "dev"}},
	}
	client, closeFn := newTestPair(fd)
	defer closeFn()

	var got []Progress
	routes, err := client.Apply(context.Background(),
		ApplyRequest{Ctx: WorkspaceContext{WorkspaceName: "acme"}, BitswanYAML: "deployments: {}"},
		func(p Progress) { got = append(got, p) })
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if !reflect.DeepEqual(got, fd.applyProgress) {
		t.Errorf("progress = %v, want %v", got, fd.applyProgress)
	}
	if !reflect.DeepEqual(routes, fd.applyRoutes) {
		t.Errorf("routes = %v, want %v", routes, fd.applyRoutes)
	}
}

func TestApplyPropagatesError(t *testing.T) {
	fd := &fakeDriver{
		applyProgress: []Progress{{Step: "generating_compose", Message: "Generating…"}},
		applyErr:      errors.New("boom while reconciling"),
	}
	client, closeFn := newTestPair(fd)
	defer closeFn()

	var got []Progress
	_, err := client.Apply(context.Background(), ApplyRequest{}, func(p Progress) { got = append(got, p) })
	if err == nil {
		t.Fatal("expected an error from the terminal error frame")
	}
	if len(got) != 1 {
		t.Errorf("progress before error = %d, want 1", len(got))
	}
	if want := "boom while reconciling"; !strings.Contains(err.Error(), want) {
		t.Errorf("error = %q, want it to contain %q", err.Error(), want)
	}
}

func TestStatusRoundTrip(t *testing.T) {
	fd := &fakeDriver{statusStates: []DeploymentState{
		{DeploymentID: "frontend-dev", Stage: "dev", Replicas: 2, Health: "healthy"},
	}}
	client, closeFn := newTestPair(fd)
	defer closeFn()

	states, err := client.Status(context.Background(), WorkspaceContext{WorkspaceName: "acme"}, nil)
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if !reflect.DeepEqual(states, fd.statusStates) {
		t.Errorf("states = %v, want %v", states, fd.statusStates)
	}
}
