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

func TestParseTestingConfig(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    testingConfig
	}{
		{
			name:    "no section",
			content: "process-id = \"abc\"\n",
			want:    testingConfig{},
		},
		{
			name:    "automation and runner",
			content: "process-id = \"abc\"\n\n[testing]\nautomation = \"backend\"\nrunner = \"go test -run {id} ./...\"\n",
			want:    testingConfig{Automation: "backend", Runner: "go test -run {id} ./..."},
		},
		{
			name:    "section ends at next table",
			content: "[testing]\nautomation = \"backend\"\n\n[other]\nautomation = \"frontend\"\n",
			want:    testingConfig{Automation: "backend"},
		},
		{
			name:    "section at end of file without trailing newline",
			content: "process-id = \"abc\"\n[testing]\nautomation = \"api\"",
			want:    testingConfig{Automation: "api"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseTestingConfig(tc.content); got != tc.want {
				t.Errorf("parseTestingConfig = %+v; want %+v", got, tc.want)
			}
		})
	}
}

// TestPickLiveDevDeployment pins the deployment-selection rules for
// `requirements test`: an automation from [testing] selects exactly, a single
// suffix match wins on its own, and anything ambiguous errors.
func TestPickLiveDevDeployment(t *testing.T) {
	multi := []string{
		"backend-copy-dev1-shop-live-dev",
		"frontend-copy-dev1-shop-live-dev",
		"backend-copy-dev1-blog-live-dev",
	}
	cases := []struct {
		name       string
		ids        []string
		bp         string
		automation string
		want       string
		wantErr    bool
	}{
		{name: "single match", ids: multi, bp: "blog", want: "backend-copy-dev1-blog-live-dev"},
		{name: "multi-automation without config errors", ids: multi, bp: "shop", wantErr: true},
		{name: "multi-automation with config", ids: multi, bp: "shop", automation: "frontend", want: "frontend-copy-dev1-shop-live-dev"},
		{name: "config names missing automation", ids: multi, bp: "shop", automation: "worker", wantErr: true},
		{name: "no match", ids: multi, bp: "wiki", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := pickLiveDevDeployment(tc.ids, "dev1", tc.bp, tc.automation)
			if tc.wantErr != (err != nil) {
				t.Fatalf("err = %v; wantErr = %v", err, tc.wantErr)
			}
			if got != tc.want {
				t.Errorf("picked %q; want %q", got, tc.want)
			}
		})
	}
}
