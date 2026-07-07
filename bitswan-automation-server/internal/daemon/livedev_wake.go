package daemon

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Scale-from-zero for dehydrated live-dev previews.
//
// The live-dev pool caps the number of RUNNING (copy×BP) instances and evicts
// the oldest (gitops enforce_live_dev_cap): an evicted instance's WORKER
// containers are stopped, but its deploy entry + DB + ingress route survive.
// When a user then hits such a host, the workspace sub-traefik has no live
// upstream and returns 5xx. We catch that in the gate, ask the workspace's
// gitops to rehydrate the instance, and serve a self-refreshing loading page so
// the request resolves normally once the container is healthy. Production is
// never dehydrated, so its hosts never take this path.

// isDehydratableHost reports whether host is a wakeable on-demand app host, i.e.
// the gate should serve the loading page + rehydrate on a 5xx rather than pass
// the hard error through.
//
//   - dev / live-dev (both end in "-dev") are ALWAYS on-demand, so the suffix
//     alone decides — no I/O, survives restarts.
//   - staging / production carry no policy in their name and may be on-demand OR
//     always-on. Their asleep/awake truth lives in the workspace's bitswan.yaml
//     (active + memory_reservation_policy), the single source of truth. We ask
//     gitops (host_is_on_demand — reads yaml, starts nothing) on the rare 5xx,
//     caching a positive in dehydratedOnDemandHosts so the loading page's 3s
//     reloads don't re-ask. On any doubt — not workspace-owned, gitops
//     unreachable, or always-on — we return false and the gate surfaces the real
//     upstream error instead of a perpetual "waking" page.
func isDehydratableHost(host string) bool {
	label := strings.ToLower(host)
	if i := strings.IndexByte(label, '.'); i >= 0 {
		label = label[:i]
	}
	label = strings.Replace(label, innerHostSuffix, "", 1) // drop the --inner segment
	if strings.HasSuffix(label, "-dev") {
		return true // dev / live-dev — always on-demand
	}
	// Positive cache: recorded at eviction (sweep / Sleep button) or by a prior
	// on-demand confirmation below.
	if isHostDehydrated(host) || isHostDehydrated(label) {
		return true
	}
	if hostIsOnDemand(host) {
		dehydratedOnDemandHosts.Store(toOuterHost(strings.ToLower(host)), time.Now())
		return true
	}
	return false
}

// workspaceGitOpsEndpoint returns the internal gitops base URL and bearer secret
// for the workspace owning host, or ok=false if host isn't workspace-owned or
// the secret can't be read.
func workspaceGitOpsEndpoint(host string) (baseURL, secret string, ok bool) {
	outer := toOuterHost(strings.ToLower(host))
	label, _, _ := strings.Cut(outer, ".")
	ws := workspaceFromLabel(label)
	if ws == "" {
		return "", "", false
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", false
	}
	secret, err = getGitOpsSecret(ws, filepath.Join(home, ".config", "bitswan", "workspaces"))
	if err != nil || secret == "" {
		return "", "", false
	}
	// Internal address on bitswan_network (not the external gitops-url).
	return fmt.Sprintf("http://%s-gitops:8079", ws), secret, true
}

// hostIsOnDemand asks the host's workspace gitops whether host resolves to an
// on-demand deployment (reads bitswan.yaml; starts nothing). Synchronous —
// called only on a 5xx for a non-"-dev" host not already cached, so at most once
// per wake. Returns false (and logs) when the workspace can't be resolved or
// gitops is unreachable: an unconfirmable host must show the real error, not a
// fake loading page.
func hostIsOnDemand(host string) bool {
	baseURL, secret, ok := workspaceGitOpsEndpoint(host)
	if !ok {
		return false
	}
	outer := toOuterHost(strings.ToLower(host))
	u := fmt.Sprintf("%s/automations/on-demand-host?host=%s", baseURL, url.QueryEscape(outer))
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		log.Printf("wake-on-access: on-demand check for %q failed: %v", outer, err)
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("wake-on-access: on-demand check for %q returned %d", outer, resp.StatusCode)
		return false
	}
	var out struct {
		OnDemand bool `json:"on_demand"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		log.Printf("wake-on-access: on-demand check for %q decode failed: %v", outer, err)
		return false
	}
	return out.OnDemand
}

var liveDevWakeDebounce sync.Map // outer host -> time.Time of last wake POST

// triggerLiveDevWake asks the host's workspace gitops to rehydrate the instance,
// at most once per debounce window per host (the loading page retries every few
// seconds, so we must not spam start calls). Fire-and-forget.
func triggerLiveDevWake(host string) {
	outer := toOuterHost(strings.ToLower(host))
	now := time.Now()
	if last, ok := liveDevWakeDebounce.Load(outer); ok {
		if now.Sub(last.(time.Time)) < 8*time.Second {
			return
		}
	}
	liveDevWakeDebounce.Store(outer, now)

	baseURL, secret, ok := workspaceGitOpsEndpoint(host)
	if !ok {
		return
	}
	go func() {
		wakeURL := baseURL + "/automations/wake-by-host"
		body := []byte(fmt.Sprintf(`{"host":%q}`, outer))
		req, err := http.NewRequest(http.MethodPost, wakeURL, bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("Authorization", "Bearer "+secret)
		req.Header.Set("Content-Type", "application/json")
		resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
		if err != nil {
			return
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()
}

// serveLiveDevLoadingResponse rewrites a 5xx response from a dehydrated live-dev
// host into a self-refreshing loading page. Uses meta-refresh (no JS) so it
// works under any CSP; returns 503 with Retry-After so bots/caches behave.
func serveLiveDevLoadingResponse(resp *http.Response) error {
	page := liveDevLoadingPage
	resp.StatusCode = http.StatusServiceUnavailable
	resp.Status = "503 Service Unavailable"
	// Drop upstream headers that would fight our page (encoding/length/CSP/frame).
	resp.Header = http.Header{}
	resp.Header.Set("Content-Type", "text/html; charset=utf-8")
	resp.Header.Set("Cache-Control", "no-store")
	resp.Header.Set("Retry-After", "3")
	resp.Body = io.NopCloser(bytes.NewReader(page))
	resp.ContentLength = int64(len(page))
	resp.Header.Set("Content-Length", fmt.Sprintf("%d", len(page)))
	return nil
}

// liveDevLoadingPage is the static "starting your preview" page. Self-contained,
// no external assets, meta-refresh every 3s until the woken container answers.
var liveDevLoadingPage = []byte(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3">
<title>Starting preview…</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;
    font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    background:#0f1115;color:#e6e8eb}
  .card{text-align:center;max-width:28rem;padding:2rem}
  .spinner{width:40px;height:40px;margin:0 auto 1.25rem;border-radius:50%;
    border:3px solid #2a2f3a;border-top-color:#5b8cff;animation:spin 0.9s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{font-size:1.15rem;font-weight:600;margin:0 0 .5rem}
  p{margin:0;color:#9aa3b2;font-size:.9rem;line-height:1.5}
</style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h1>Waking your live-dev preview…</h1>
    <p>This instance was paused to free resources. It's starting back up and
       will load automatically in a few seconds.</p>
  </div>
</body>
</html>`)
