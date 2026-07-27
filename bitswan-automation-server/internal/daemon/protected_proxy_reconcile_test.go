package daemon

import "testing"

func TestProxyConfigNeedsUpdate(t *testing.T) {
	cases := []struct {
		name string
		env  string
		want bool
	}{
		{
			name: "capped proxy is current",
			env: "OAUTH2_PROXY_PROVIDER=oidc\n" +
				"OAUTH2_PROXY_COOKIE_CSRF_PER_REQUEST=true\n" +
				"OAUTH2_PROXY_COOKIE_CSRF_PER_REQUEST_LIMIT=5\n",
			want: false,
		},
		{
			name: "proxy without the cap is stale",
			env: "OAUTH2_PROXY_PROVIDER=oidc\n" +
				"OAUTH2_PROXY_COOKIE_CSRF_PER_REQUEST=true\n",
			want: true,
		},
		{
			name: "empty env is stale",
			env:  "",
			want: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := proxyConfigNeedsUpdate(tc.env); got != tc.want {
				t.Fatalf("proxyConfigNeedsUpdate = %v, want %v", got, tc.want)
			}
		})
	}
}
