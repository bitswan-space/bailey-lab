package daemon

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
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

// isDehydratableHost reports whether host is an EPHEMERAL app host — dev or
// live-dev, the stages the cap evicts. Both end in "-dev" (`…-dev` /
// `…-live-dev`); staging (`…-staging`) and production (`…-production[-slot]`) do
// NOT, so they are protected and never woken here.
func isDehydratableHost(host string) bool {
	label := strings.ToLower(host)
	if i := strings.IndexByte(label, '.'); i >= 0 {
		label = label[:i]
	}
	label = strings.Replace(label, innerHostSuffix, "", 1) // drop the --inner segment
	if strings.HasSuffix(label, "-dev") {
		return true // dev / live-dev — always on-demand
	}
	// On-demand staging/production have no "-dev" suffix; the memory sweep records
	// the hosts it shuts down so the gate can wake them on access too.
	return isHostDehydrated(host) || isHostDehydrated(label)
}

var liveDevWakeDebounce sync.Map // outer host -> time.Time of last wake POST

// triggerLiveDevWake asks the host's workspace gitops to rehydrate the live-dev
// instance, at most once per debounce window per host (the loading page retries
// every few seconds, so we must not spam start calls). Fire-and-forget.
func triggerLiveDevWake(host string) {
	outer := toOuterHost(strings.ToLower(host))
	now := time.Now()
	if last, ok := liveDevWakeDebounce.Load(outer); ok {
		if now.Sub(last.(time.Time)) < 8*time.Second {
			return
		}
	}
	liveDevWakeDebounce.Store(outer, now)

	label, _, _ := strings.Cut(outer, ".")
	ws := workspaceFromLabel(label)
	if ws == "" {
		return
	}
	go func() {
		home, err := os.UserHomeDir()
		if err != nil {
			return
		}
		workspacesDir := filepath.Join(home, ".config", "bitswan", "workspaces")
		secret, err := getGitOpsSecret(ws, workspacesDir)
		if err != nil || secret == "" {
			return
		}
		// Internal address on bitswan_network (not the external gitops-url).
		url := fmt.Sprintf("http://%s-gitops:8079/automations/wake-by-host", ws)
		body := []byte(fmt.Sprintf(`{"host":%q}`, outer))
		req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
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
