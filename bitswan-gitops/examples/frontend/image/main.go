// Command frontend is the Bitswan frontend shim.
//
// A frontend automation is the only thing in a business process that is
// exposed to the internet (through Bailey's protected ingress). It serves
// the app's static assets and reverse-proxies API calls to a worker
// container over the workspace's private Docker network — so the real
// backend is never directly reachable from outside.
//
// Routing:
//
//	/api/...  → reverse-proxied to the "backend" worker container
//	everything else → served from ./static (SPA fallback to index.html)
//
// The browser only ever talks to this frontend, same-origin, so requests
// pass cleanly through Bailey's proxy and CSP. Bailey authenticates the
// user upstream and forwards the identity as X-Forwarded-* headers; this
// shim passes those through to the worker, which can trust them because it
// is only reachable via the frontend.
//
// Worker discovery is explicit, not guessed: gitops injects
// BITSWAN_WORKER_HOSTS, a comma-separated list of `name=host:port` entries
// for every worker container in the business process. The shim proxies
// /api to the worker named "backend" (BITSWAN_BACKEND defaults to that).
package main

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	port := envOr("PORT", "8080")
	staticDir := envOr("BITSWAN_STATIC_DIR", "/app/static")
	backendName := envOr("BITSWAN_BACKEND", "backend")

	workers := parseWorkerHosts(os.Getenv("BITSWAN_WORKER_HOSTS"))

	mux := http.NewServeMux()

	// /api → the backend worker. Absent worker → 503 (rather than a
	// confusing static 404), so a misconfigured BP is obvious.
	if target, ok := workers[backendName]; ok {
		mux.Handle("/api/", apiProxy(target))
		log.Printf("frontend: /api/ → %s (worker %q)", target, backendName)
	} else {
		mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "no backend worker configured", http.StatusServiceUnavailable)
		})
		log.Printf("frontend: no worker named %q in BITSWAN_WORKER_HOSTS=%q; /api/ disabled",
			backendName, os.Getenv("BITSWAN_WORKER_HOSTS"))
	}

	mux.Handle("/", spaHandler(staticDir))

	log.Printf("frontend listening on :%s, serving %s", port, staticDir)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatalf("frontend: %v", err)
	}
}

// apiProxy reverse-proxies to a worker. httputil.ReverseProxy handles
// WebSocket upgrades transparently. The Bailey identity headers ride along
// with the request unchanged; we only fix up the forwarding metadata.
func apiProxy(target *url.URL) http.Handler {
	rp := httputil.NewSingleHostReverseProxy(target)
	director := rp.Director
	rp.Director = func(r *http.Request) {
		director(r)
		// Preserve the original host for the worker's own logging/links,
		// and make X-Forwarded-Host reflect what the browser asked for.
		if r.Header.Get("X-Forwarded-Host") == "" {
			r.Header.Set("X-Forwarded-Host", r.Host)
		}
		r.Host = target.Host
	}
	return rp
}

// spaHandler serves files from dir, falling back to index.html for unknown
// paths so client-side routes resolve. Path traversal is blocked.
func spaHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	index := filepath.Join(dir, "index.html")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := filepath.Clean(r.URL.Path)
		full := filepath.Join(dir, clean)
		if !strings.HasPrefix(full, filepath.Clean(dir)+string(os.PathSeparator)) && clean != "/" {
			http.NotFound(w, r)
			return
		}
		if clean != "/" {
			if info, err := os.Stat(full); err == nil && !info.IsDir() {
				fs.ServeHTTP(w, r)
				return
			}
		}
		http.ServeFile(w, r, index)
	})
}

// parseWorkerHosts parses BITSWAN_WORKER_HOSTS ("name=host:port,name2=...")
// into a name → URL map. Malformed entries are skipped.
func parseWorkerHosts(raw string) map[string]*url.URL {
	out := map[string]*url.URL{}
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		name, addr, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		name, addr = strings.TrimSpace(name), strings.TrimSpace(addr)
		if !strings.Contains(addr, "://") {
			addr = "http://" + addr
		}
		u, err := url.Parse(addr)
		if err != nil || u.Host == "" {
			continue
		}
		out[name] = u
	}
	return out
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
