package cmd

import (
	"reflect"
	"testing"
)

// TestTestCommand pins the test-discovery convention the "Write tests" agent
// flow and the requirements-test runner share: a requirement ID's hyphens
// become underscores (so REQ-003 can name a test function), and {id} in the
// runner template is replaced with that token. The result is always exec'd via
// `sh -c` so arbitrary runner strings work.
func TestTestCommand(t *testing.T) {
	cases := []struct {
		name   string
		runner string
		reqID  string
		want   []string
	}{
		{
			name:   "default pytest with id token",
			runner: "pytest -k {id} -v",
			reqID:  "REQ-003",
			want:   []string{"sh", "-c", "pytest -k REQ_003 -v"},
		},
		{
			name:   "AI-prefixed id",
			runner: "pytest -k {id}",
			reqID:  "AI-012",
			want:   []string{"sh", "-c", "pytest -k AI_012"},
		},
		{
			name:   "go runner template",
			runner: "go test -run {id} ./...",
			reqID:  "REQ-1",
			want:   []string{"sh", "-c", "go test -run REQ_1 ./..."},
		},
		{
			name:   "template without placeholder runs unchanged",
			runner: "pytest",
			reqID:  "REQ-9",
			want:   []string{"sh", "-c", "pytest"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := testCommand(tc.runner, tc.reqID)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("testCommand(%q, %q) = %v; want %v", tc.runner, tc.reqID, got, tc.want)
			}
		})
	}
}

// TestLiveDevSuffix pins the deployment-ID suffix used to auto-resolve a BP's
// per-copy live-dev container ({automation}-copy-{copy}-{bp}-live-dev).
func TestLiveDevSuffix(t *testing.T) {
	if got, want := liveDevSuffix("dev1", "shop"), "-copy-dev1-shop-live-dev"; got != want {
		t.Errorf("liveDevSuffix = %q; want %q", got, want)
	}
}
