package dockerdriver

import (
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

func TestContentSHA(t *testing.T) {
	cases := []struct {
		name string
		req  infradriver.BuildRequest
		want string
	}{
		{
			name: "prefers SourceSHA",
			req:  infradriver.BuildRequest{SourceSHA: "abc123", Tag: "internal/ws-bp-frontend:shaZZZ"},
			want: "abc123",
		},
		{
			name: "falls back to tag suffix",
			req:  infradriver.BuildRequest{Tag: "internal/ws-bp-frontend:shadfc599c973"},
			want: "dfc599c973",
		},
		{
			name: "no sha anywhere",
			req:  infradriver.BuildRequest{Tag: "internal/ws-bp-frontend:latest"},
			want: "",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := contentSHA(c.req); got != c.want {
				t.Errorf("contentSHA() = %q, want %q", got, c.want)
			}
		})
	}
}
