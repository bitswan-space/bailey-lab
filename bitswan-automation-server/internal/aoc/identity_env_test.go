package aoc

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// clearIdentityEnv blanks the ambient identity vars for the test's duration
// (empty == unset for workerIdentityEnv, and t.Setenv restores the originals).
func clearIdentityEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{"KEYCLOAK_URL", "BITSWAN_ALLOWED_GROUP", "BITSWAN_ADMIN_GROUP"} {
		t.Setenv(k, "")
	}
}

func identityTestClient(t *testing.T, handler http.HandlerFunc) *AOCClient {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return &AOCClient{
		settings: &config.AutomationOperationsCenterSettings{
			AOCUrl:      srv.URL,
			AccessToken: "test-token",
			Domain:      "acme.bswn.io",
		},
	}
}

func TestWorkerIdentityEnvFromAOC(t *testing.T) {
	clearIdentityEnv(t)
	c := identityTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/automation_server/keycloak/oauth-client" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"client_id":     "cid",
			"client_secret": "sec",
			"issuer_url":    "https://kc.example.com/realms/master",
			"group_path":    "/Example Org",
		})
	})

	got := c.workerIdentityEnv()
	want := []string{
		"BITSWAN_AUTH_MODE=aoc",
		"KEYCLOAK_URL=https://kc.example.com/realms/master",
		"BITSWAN_ALLOWED_GROUP=/Example Org",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("workerIdentityEnv = %v, want %v", got, want)
	}
}

func TestWorkerIdentityEnvAmbientOverrideWins(t *testing.T) {
	clearIdentityEnv(t)
	t.Setenv("KEYCLOAK_URL", "https://own-kc.example.com/realms/custom")
	t.Setenv("BITSWAN_ALLOWED_GROUP", "/Own Org")
	t.Setenv("BITSWAN_ADMIN_GROUP", "/Own Org/operators")
	c := identityTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("AOC must not be called when ambient env provides both values")
	})

	got := c.workerIdentityEnv()
	want := []string{
		"BITSWAN_AUTH_MODE=aoc",
		"KEYCLOAK_URL=https://own-kc.example.com/realms/custom",
		"BITSWAN_ALLOWED_GROUP=/Own Org",
		"BITSWAN_ADMIN_GROUP=/Own Org/operators",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("workerIdentityEnv = %v, want %v", got, want)
	}
}

func TestWorkerIdentityEnvOldAOCWithoutGroupPath(t *testing.T) {
	clearIdentityEnv(t)
	c := identityTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"client_id":     "cid",
			"client_secret": "sec",
			"issuer_url":    "https://kc.example.com/realms/master",
		})
	})

	got := c.workerIdentityEnv()
	want := []string{
		"BITSWAN_AUTH_MODE=aoc",
		"KEYCLOAK_URL=https://kc.example.com/realms/master",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("workerIdentityEnv = %v, want %v", got, want)
	}
}

// Even when no identity can be resolved (no domain → no AOC call), the
// auth-mode stamp must still be emitted: it is exactly the signal workers
// use to detect "AOC platform failed to provide identity env".
func TestWorkerIdentityEnvNoDomainStillStampsAuthMode(t *testing.T) {
	clearIdentityEnv(t)
	c := &AOCClient{
		settings: &config.AutomationOperationsCenterSettings{
			AOCUrl:      "http://unreachable.invalid",
			AccessToken: "test-token",
		},
	}
	got := c.workerIdentityEnv()
	want := []string{"BITSWAN_AUTH_MODE=aoc"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("workerIdentityEnv = %v, want %v", got, want)
	}
}

func TestWorkerIdentityEnvPrefersTheBrokerWhenOneFrontsSignIn(t *testing.T) {
	clearIdentityEnv(t)
	WorkerIssuerOverride = func() string { return "https://auth.acme.bswn.io" }
	t.Cleanup(func() { WorkerIssuerOverride = nil })

	c := identityTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"client_id": "cid", "client_secret": "sec",
			"issuer_url": "https://kc.example.com/realms/master",
			"group_path": "/Example Org",
		})
	})

	got := c.workerIdentityEnv()
	want := []string{
		"BITSWAN_AUTH_MODE=aoc",
		"KEYCLOAK_URL=https://auth.acme.bswn.io",
		"BITSWAN_ALLOWED_GROUP=/Example Org",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("workerIdentityEnv = %v, want %v — workers must verify tokens against whatever "+
			"actually issued them, and behind a broker that is the broker", got, want)
	}
}

func TestWorkerIdentityEnvAmbientBeatsTheBroker(t *testing.T) {
	clearIdentityEnv(t)
	t.Setenv("KEYCLOAK_URL", "https://own-kc.example.com/realms/custom")
	WorkerIssuerOverride = func() string { return "https://auth.acme.bswn.io" }
	t.Cleanup(func() { WorkerIssuerOverride = nil })

	c := identityTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"client_id": "cid", "client_secret": "sec",
			"issuer_url": "https://kc.example.com/realms/master",
			"group_path": "/Example Org",
		})
	})

	for _, kv := range c.workerIdentityEnv() {
		if kv == "KEYCLOAK_URL=https://own-kc.example.com/realms/custom" {
			return
		}
	}
	t.Errorf("an operator's explicit KEYCLOAK_URL must still win: %v", c.workerIdentityEnv())
}
