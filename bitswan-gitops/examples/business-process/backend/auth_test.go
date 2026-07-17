package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	jwtv5 "github.com/golang-jwt/jwt/v5"
)

func TestResolveAuthStartup(t *testing.T) {
	cases := []struct {
		name                    string
		issuer, authMode, stage string
		wantFatal, wantWarning  bool
	}{
		{"aoc mode healthy", "https://kc.example/realms/r", "aoc", "staging", false, false},
		{"issuer without stamp still fine", "https://kc.example/realms/r", "", "dev", false, false},
		{"aoc platform failed to inject issuer", "", "aoc", "staging", true, false},
		{"aoc platform failed to inject issuer, no stage", "", "aoc", "", true, false},
		{"deployed without identity provider warns", "", "", "production", false, true},
		{"local development is quiet", "", "", "", false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fatal, warning := resolveAuthStartup(c.issuer, c.authMode, c.stage)
			if (fatal != "") != c.wantFatal {
				t.Errorf("fatal = %q, want fatal=%v", fatal, c.wantFatal)
			}
			if (warning != "") != c.wantWarning {
				t.Errorf("warning = %q, want warning=%v", warning, c.wantWarning)
			}
			if c.wantWarning && !strings.Contains(warning, c.stage) {
				t.Errorf("warning %q should name the stage %q", warning, c.stage)
			}
		})
	}
}

func TestDeriveAdminGroup(t *testing.T) {
	cases := []struct {
		explicit, allowed, want string
	}{
		{"", "/Example Org", "/Example Org/admin"},                           // platform-convention default
		{"/Example Org/operators", "/Example Org", "/Example Org/operators"}, // explicit override wins
		{"", "", ""}, // nothing configured → fail closed
	}
	for _, c := range cases {
		if got := deriveAdminGroup(c.explicit, c.allowed); got != c.want {
			t.Errorf("deriveAdminGroup(%q, %q) = %q, want %q", c.explicit, c.allowed, got, c.want)
		}
	}
}

// Admin is NEVER implicit: an authenticated identity without the admin
// group — or a worker with no admin group configured at all — is not admin.
func TestIsAdminFailsClosed(t *testing.T) {
	origAdmin := adminGroup
	defer func() { adminGroup = origAdmin }()

	memberClaims := jwtv5.MapClaims{
		"preferred_username": "alice",
		"group_membership":   []interface{}{"/Example Org"},
	}
	adminClaims := jwtv5.MapClaims{
		"preferred_username": "bob",
		"group_membership":   []interface{}{"/Example Org", "/Example Org/admin"},
	}

	adminGroup = "/Example Org/admin"
	if isAdmin(memberClaims) {
		t.Error("plain org member must not be admin")
	}
	if !isAdmin(adminClaims) {
		t.Error("admin-group member must be admin")
	}
	if isAdmin(nil) {
		t.Error("nil claims must not be admin")
	}
	if isAdmin(jwtv5.MapClaims{"preferred_username": "eve"}) {
		t.Error("claims without group_membership must not be admin")
	}

	adminGroup = ""
	if isAdmin(adminClaims) {
		t.Error("without a configured admin group, nobody is admin (fail closed)")
	}
}

func TestClaimGroups(t *testing.T) {
	claims := jwtv5.MapClaims{
		"group_membership": []interface{}{"/Example Org", "/Example Org/admin", 42},
	}
	got := claimGroups(claims)
	want := []string{"/Example Org", "/Example Org/admin"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("claimGroups = %v, want %v", got, want)
	}
	if g := claimGroups(nil); len(g) != 0 {
		t.Errorf("claimGroups(nil) = %v, want empty", g)
	}
}

// getUsername reads identity from the verified token claims that requireAuth
// stored on the request — and from nowhere else. In particular the forwarded
// identity headers (X-Forwarded-Email, X-Auth-Request-Email) must never be
// trusted: the gate strips them for user-deployed apps by design, so any
// value that does arrive is client-supplied and spoofable (#102, #178).

func TestGetUsernameReadsVerifiedClaims(t *testing.T) {
	claims := jwtv5.MapClaims{"preferred_username": "carol"}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r = r.WithContext(context.WithValue(r.Context(), claimsKey, claims))
	if got := getUsername(r); got != "carol" {
		t.Errorf("getUsername = %q, want %q", got, "carol")
	}
}

func TestGetUsernameAnonymousWithoutClaims(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if got := getUsername(r); got != "anonymous" {
		t.Errorf("getUsername = %q, want %q", got, "anonymous")
	}
}

func TestGetUsernameNeverTrustsForwardedHeaders(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("X-Forwarded-Email", "spoofed@evil.example")
	r.Header.Set("X-Auth-Request-Email", "spoofed@evil.example")
	if got := getUsername(r); got != "anonymous" {
		t.Errorf("getUsername = %q, want %q (forwarded headers are untrusted)", got, "anonymous")
	}
}

func TestGetUsernameEmptyClaimDoesNotFallBackToHeaders(t *testing.T) {
	claims := jwtv5.MapClaims{"preferred_username": ""}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("X-Forwarded-Email", "spoofed@evil.example")
	r = r.WithContext(context.WithValue(r.Context(), claimsKey, claims))
	if got := getUsername(r); got != "anonymous" {
		t.Errorf("getUsername = %q, want %q (no cross-source fallback)", got, "anonymous")
	}
}
