package daemon

import (
	"bytes"
	"io"
	"log"
	"net/http"
	"strings"
	"testing"
)

func TestIsDehydratableHost(t *testing.T) {
	cases := []struct {
		host string
		want bool
	}{
		{"wraptest-frontend-4c4b-live-dev.timssandbox2.bswn.io", true},        // live-dev
		{"wraptest-frontend-4c4b-live-dev--inner.timssandbox2.bswn.io", true}, // live-dev (inner)
		{"wraptest-frontend-02e3-dev.timssandbox2.bswn.io", true},             // dev — also ephemeral
		{"wraptest-frontend-02e3-dev--inner.timssandbox2.bswn.io", true},      // dev (inner)
		{"wraptest-frontend-02e3-staging.timssandbox2.bswn.io", false},        // staging — PROTECTED
		{"wraptest-frontend-1155-production-a.timssandbox2.bswn.io", false},   // production — PROTECTED
		{"wraptest-frontend-1155-production.timssandbox2.bswn.io", false},     // production — PROTECTED
		{"bailey.timssandbox2.bswn.io", false},                                // management host
	}
	for _, c := range cases {
		if got := isDehydratableHost(c.host); got != c.want {
			t.Errorf("isDehydratableHost(%q) = %v, want %v", c.host, got, c.want)
		}
	}
}

// The gate used to discard gitops' wake reply, so every way a wake can decline
// to act looked exactly like success and a stuck coldstart left no trace at all
// (#281). logWakeOutcome is that trace — each branch must name what happened.
func TestLogWakeOutcome(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   []string // substrings the log line must carry
	}{
		{
			name:   "unknown or always-on host is called out as unwakeable",
			status: 200,
			body:   `{"on_demand":false,"context":null,"deployment_ids":[]}`,
			want:   []string{"declined to wake", "will not resolve"},
		},
		{
			name:   "redeploy failure names the error",
			status: 200,
			body: `{"on_demand":true,"context":"copy-a-bp","stage":"live-dev",` +
				`"deployment_ids":["fe-a"],"redeploy_error":"driver push rejected"}`,
			want: []string{"FAILED to redeploy", "driver push rejected", "copy-a-bp"},
		},
		{
			name:   "a real wake reports which members are being recreated",
			status: 200,
			body: `{"on_demand":true,"context":"copy-a-bp","stage":"live-dev",` +
				`"deployment_ids":["be-a","fe-a"],"woke":["fe-a"]}`,
			want: []string{"woke", "2 member(s)", "fe-a"},
		},
		{
			name:   "already-up is distinguishable from having done work",
			status: 200,
			body:   `{"on_demand":true,"context":"copy-a-bp","stage":"live-dev","already_running":true}`,
			want:   []string{"already up", "no action"},
		},
		{
			name:   "stale-mount recycle is named",
			status: 200,
			body: `{"on_demand":true,"context":"copy-a-bp","stage":"live-dev",` +
				`"deployment_ids":["fe-a"],"recycled":["fe-a"]}`,
			want: []string{"recycled", "stale source mount"},
		},
		{
			name:   "non-200 surfaces status and body",
			status: 500,
			body:   `{"detail":"boom"}`,
			want:   []string{"returned 500", "boom"},
		},
		{
			name:   "undecodable body is reported rather than swallowed",
			status: 200,
			body:   `not json {`,
			want:   []string{"undecodable"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := captureLog(t, func() {
				logWakeOutcome("host.example.io", &http.Response{
					StatusCode: c.status,
					Body:       io.NopCloser(strings.NewReader(c.body)),
				})
			})
			for _, w := range c.want {
				if !strings.Contains(got, w) {
					t.Errorf("log %q does not contain %q", got, w)
				}
			}
			if !strings.Contains(got, "host.example.io") {
				t.Errorf("log %q does not name the host", got)
			}
		})
	}
}

// captureLog redirects the standard logger for the duration of fn.
func captureLog(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	orig := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(orig)
	fn()
	return buf.String()
}
