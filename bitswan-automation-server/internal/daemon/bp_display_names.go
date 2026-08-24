package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Business-process display names for the endpoints listing (#319).
//
// A gitops-deployed endpoint's row only records the BP *slug* (source_bp) —
// the human-readable name lives in the BP's process.toml inside the
// workspace's gitops, and is renameable there at any time. Rather than
// mirroring that state into bailey.db (and going stale on every rename), the
// daemon asks each workspace's gitops for its slug → display-name map when
// the endpoints listing needs one, over the same internal-address + shared-
// secret channel as evictViaGitops / desiredGroupsForWorkspace.
//
// Best-effort by design: a stopped or pre-#319 gitops just means no names,
// and clients fall back to the hostname exactly as before.

// gitopsProcessesURL / bpDisplayNamesForWorkspace are package vars so tests
// can point them at an httptest server + stub secret (mirrors evictViaGitops).
var gitopsProcessesURL = func(ws string) string {
	return fmt.Sprintf("http://%s-gitops:8079/processes/", ws)
}

var bpDisplayNamesForWorkspace = func(ctx context.Context, ws string) (map[string]string, error) {
	secret, err := gitopsSecretForWorkspace(ws)
	if err != nil || secret == "" {
		return nil, fmt.Errorf("gitops secret for %q: %v", ws, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, gitopsProcessesURL(ws), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("processes %s: HTTP %d", ws, resp.StatusCode)
	}
	var out struct {
		Processes []struct {
			Name        string `json:"name"`
			DisplayName string `json:"display_name"`
		} `json:"processes"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	names := make(map[string]string, len(out.Processes))
	for _, p := range out.Processes {
		if p.Name != "" && p.DisplayName != "" && p.DisplayName != p.Name {
			names[p.Name] = p.DisplayName
		}
	}
	return names, nil
}

// bpNamesCache caches one slug → display-name map per workspace so the
// per-request gitops round-trip amortises to nothing. Failures are cached
// too (as an empty map): an unreachable gitops must not re-add its dial
// timeout to every endpoints-page load. A rename therefore takes up to
// bpNamesTTL to show in the console — the dashboard reads gitops directly
// and stays instant.
const bpNamesTTL = 60 * time.Second

var (
	bpNamesMu    sync.Mutex
	bpNamesCache = map[string]bpNamesEntry{}
)

type bpNamesEntry struct {
	names     map[string]string
	fetchedAt time.Time
}

// resetBPNamesCache clears the cache (tests).
func resetBPNamesCache() {
	bpNamesMu.Lock()
	defer bpNamesMu.Unlock()
	bpNamesCache = map[string]bpNamesEntry{}
}

// cachedBPDisplayNames returns the workspace's slug → display-name map,
// fetching from gitops on a cache miss. Never returns an error — no names
// is a valid answer the listing renders around.
func cachedBPDisplayNames(ctx context.Context, ws string) map[string]string {
	bpNamesMu.Lock()
	if e, ok := bpNamesCache[ws]; ok && time.Since(e.fetchedAt) < bpNamesTTL {
		bpNamesMu.Unlock()
		return e.names
	}
	bpNamesMu.Unlock()

	names, err := bpDisplayNamesForWorkspace(ctx, ws)
	if err != nil || names == nil {
		names = map[string]string{}
	}
	bpNamesMu.Lock()
	bpNamesCache[ws] = bpNamesEntry{names: names, fetchedAt: time.Now()}
	bpNamesMu.Unlock()
	return names
}

// annotateBPDisplayNames fills business_process_display_name on every entry
// whose (workspace, business_process) resolves to a known display name. The
// distinct workspaces are fetched concurrently so one slow gitops doesn't
// serialise behind another.
func annotateBPDisplayNames(ctx context.Context, entries []endpointListEntry) {
	workspaces := map[string]bool{}
	for i := range entries {
		if entries[i].BusinessProcess != "" && entries[i].Workspace != "" {
			workspaces[entries[i].Workspace] = true
		}
	}
	if len(workspaces) == 0 {
		return
	}
	namesByWS := make(map[string]map[string]string, len(workspaces))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for ws := range workspaces {
		wg.Add(1)
		go func(ws string) {
			defer wg.Done()
			names := cachedBPDisplayNames(ctx, ws)
			mu.Lock()
			namesByWS[ws] = names
			mu.Unlock()
		}(ws)
	}
	wg.Wait()
	for i := range entries {
		e := &entries[i]
		if e.BusinessProcess == "" || e.Workspace == "" {
			continue
		}
		e.BusinessProcessDisplayName = namesByWS[e.Workspace][e.BusinessProcess]
	}
}
