package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The endpoints listing labels gitops-deployed endpoints with their BP's
// human-readable name, fetched from the workspace's gitops (#319). Endpoints
// without a BP (or in a workspace gitops knows no name for) stay unlabelled
// so clients keep their hostname fallback.
func TestEndpoints_CarriesBPDisplayName(t *testing.T) {
	domain := writeTestConfig(t)
	owner := "bpname-owner@example.com"
	const wsName = "bpnamews"
	wsDir := filepath.Join(os.Getenv("HOME"), ".config", "bitswan", "workspaces", wsName)
	if err := os.MkdirAll(wsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(wsDir) })

	dashHost := wsName + "-dashboard." + domain
	appHost := wsName + "-fio-frontend." + domain
	otherHost := wsName + "-manual-app." + domain
	if _, err := registerEndpoint(dashHost, owner, wsName+" (dashboard)", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint(appHost, owner, appHost, dashHost, endpointKindFrontend, "live-dev"); err != nil {
		t.Fatal(err)
	}
	if err := setEndpointSourceBP(appHost, "gitops", "fio"); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint(otherHost, owner, "Manual app", dashHost, endpointKindFrontend, ""); err != nil {
		t.Fatal(err)
	}

	prev := bpDisplayNamesForWorkspace
	t.Cleanup(func() { bpDisplayNamesForWorkspace = prev; resetBPNamesCache() })
	resetBPNamesCache()
	bpDisplayNamesForWorkspace = func(_ context.Context, ws string) (map[string]string, error) {
		if ws != wsName {
			t.Errorf("fetched names for workspace %q, want %q", ws, wsName)
		}
		return map[string]string{"fio": "Fio Invoicing"}, nil
	}

	listing, err := buildEndpointListing(owner, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	byHost := map[string]endpointListEntry{}
	for _, e := range listing.Endpoints {
		byHost[strings.ToLower(e.Hostname)] = e
	}
	app := byHost[strings.ToLower(appHost)]
	if app.BusinessProcessDisplayName != "Fio Invoicing" {
		t.Errorf("business_process_display_name = %q, want %q", app.BusinessProcessDisplayName, "Fio Invoicing")
	}
	if got := byHost[strings.ToLower(otherHost)].BusinessProcessDisplayName; got != "" {
		t.Errorf("endpoint without a BP got display name %q", got)
	}
	if got := byHost[strings.ToLower(dashHost)].BusinessProcessDisplayName; got != "" {
		t.Errorf("dashboard endpoint got display name %q", got)
	}
}

// bpDisplayNamesForWorkspace speaks gitops's GET /processes/ shape and drops
// entries whose display name just repeats the slug (nothing to gain over the
// hostname fallback).
func TestBPDisplayNamesForWorkspace_FetchesAndFilters(t *testing.T) {
	prevURL, prevSec := gitopsProcessesURL, gitopsSecretForWorkspace
	t.Cleanup(func() { gitopsProcessesURL, gitopsSecretForWorkspace = prevURL, prevSec })

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sekret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"processes": []map[string]any{
			{"name": "fio", "display_name": "Fio Invoicing", "in_main": true},
			{"name": "plain", "display_name": "plain", "in_main": true},
			{"name": "", "display_name": "nameless"},
		}})
	}))
	defer srv.Close()
	gitopsProcessesURL = func(string) string { return srv.URL }
	gitopsSecretForWorkspace = func(string) (string, error) { return "sekret", nil }

	names, err := bpDisplayNamesForWorkspace(context.Background(), "ws")
	if err != nil {
		t.Fatal(err)
	}
	if names["fio"] != "Fio Invoicing" {
		t.Errorf("names[fio] = %q, want Fio Invoicing", names["fio"])
	}
	if _, ok := names["plain"]; ok {
		t.Error("slug-equal display name should be dropped")
	}
	if len(names) != 1 {
		t.Errorf("names = %v, want exactly one entry", names)
	}
}

// A failed fetch is cached as "no names" for the TTL, so an unreachable
// gitops doesn't re-add its timeout to every endpoints-page load.
func TestCachedBPDisplayNames_CachesFailures(t *testing.T) {
	prev := bpDisplayNamesForWorkspace
	t.Cleanup(func() { bpDisplayNamesForWorkspace = prev; resetBPNamesCache() })
	resetBPNamesCache()

	calls := 0
	bpDisplayNamesForWorkspace = func(context.Context, string) (map[string]string, error) {
		calls++
		return nil, context.DeadlineExceeded
	}
	if got := cachedBPDisplayNames(context.Background(), "downws"); len(got) != 0 {
		t.Errorf("names on failure = %v, want empty", got)
	}
	if got := cachedBPDisplayNames(context.Background(), "downws"); len(got) != 0 {
		t.Errorf("names on cached failure = %v, want empty", got)
	}
	if calls != 1 {
		t.Errorf("fetch calls = %d, want 1 (failure cached)", calls)
	}
}
