// Command shim is the frontend's edge process. The frontend is the only
// container in a business process exposed through Bailey; the backend is a
// private worker reachable only on the workspace's Docker network. The shim
// merges the two behind one origin on :8080:
//
//	/api/...  → reverse-proxied to the "backend" worker (the /api prefix is
//	            stripped, so /api/internal/x reaches the backend as
//	            /internal/x). Bailey's forwarded identity headers and the
//	            caller's Authorization ride along unchanged.
//	everything else → reverse-proxied to the local vite server (the React
//	            app, with hot reload in live-dev), including the HMR websocket.
//
// So the browser only ever talks to this origin (same-origin, through
// Bailey); the real backend is never exposed. Worker discovery is explicit:
// gitops injects BITSWAN_WORKER_HOSTS (name=host:port,...); the shim proxies
// /api to the worker named by BITSWAN_BACKEND (default "backend").
package main

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
)

func main() {
	port := envOr("PORT", "8080")
	viteURL, _ := url.Parse("http://127.0.0.1:" + envOr("VITE_PORT", "5173"))
	backendName := envOr("BITSWAN_BACKEND", "backend")
	workers := parseWorkerHosts(os.Getenv("BITSWAN_WORKER_HOSTS"))

	mux := http.NewServeMux()

	// /api → the backend worker, with the /api prefix stripped. Absent worker
	// → 503 (clearer than a vite 404), so a misconfigured BP is obvious.
	if target, ok := workers[backendName]; ok {
		proxy := httputil.NewSingleHostReverseProxy(target)
		mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
			r.URL.Path = strings.TrimPrefix(r.URL.Path, "/api")
			if r.URL.Path == "" {
				r.URL.Path = "/"
			}
			proxy.ServeHTTP(w, r)
		})
		log.Printf("shim: /api/ → %s (worker %q)", target, backendName)
	} else {
		mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "no backend worker configured", http.StatusServiceUnavailable)
		})
		log.Printf("shim: no worker named %q in BITSWAN_WORKER_HOSTS=%q; /api/ disabled",
			backendName, os.Getenv("BITSWAN_WORKER_HOSTS"))
	}

	// Everything else → vite. ReverseProxy passes through the HMR websocket
	// upgrade, so hot reload works behind the shim.
	mux.Handle("/", httputil.NewSingleHostReverseProxy(viteURL))

	log.Printf("shim listening on :%s, UI → %s", port, viteURL)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatalf("shim: %v", err)
	}
}

// parseWorkerHosts parses BITSWAN_WORKER_HOSTS ("name=host:port,...") into a
// name → URL map. Malformed entries are skipped.
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
