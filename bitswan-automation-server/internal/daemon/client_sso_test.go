package daemon

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// ssoSocketClient serves handler over a unix socket and returns a Client whose
// ordinary timeout is far too short for it, so a call that survives is one that
// asked for the long-running transport.
func ssoSocketClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	// Not t.TempDir(): it embeds the test's name, and a socket path over ~104
	// bytes is rejected outright on macOS.
	dir, err := os.MkdirTemp("", "bsy")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "s")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen on %s (%d bytes): %v", sock, len(sock), err)
	}
	srv := &http.Server{Handler: handler}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })

	return &Client{
		socketPath: sock,
		token:      "test-token",
		httpClient: &http.Client{
			Transport: &http.Transport{
				DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
					return net.Dial("unix", sock)
				},
			},
			Timeout: 50 * time.Millisecond,
		},
	}
}

func TestDisableSSO_WaitsOutTheTopologyRebuild(t *testing.T) {
	c := ssoSocketClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bailey/sso/disable" {
			http.NotFound(w, r)
			return
		}
		// Turning single sign-on off stops the broker and re-provisions the
		// proxy — docker work that comfortably outlives the ordinary deadline.
		time.Sleep(300 * time.Millisecond)
		_ = json.NewEncoder(w).Encode(map[string]any{"changed": true})
	})

	changed, err := c.DisableSSO()
	if err != nil {
		t.Fatalf("DisableSSO: %v — the escape hatch must outlast the rebuild it triggers, "+
			"or an operator locked out by their own provider sees a timeout instead of a recovery", err)
	}
	if !changed {
		t.Error("changed = false")
	}
}

func TestSSOStatus_StaysOnTheOrdinaryDeadline(t *testing.T) {
	c := ssoSocketClient(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"enabled": true, "sso_only": true, "display_name": "Acme SSO"})
	})

	st, err := c.SSOStatus()
	if err != nil {
		t.Fatalf("SSOStatus: %v", err)
	}
	if !st.Enabled || !st.SSOOnly || st.DisplayName != "Acme SSO" {
		t.Errorf("status = %+v", st)
	}
}
