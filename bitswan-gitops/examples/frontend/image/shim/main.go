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
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

func main() {
	port := envOr("PORT", "8080")
	viteURL, _ := url.Parse("http://127.0.0.1:" + envOr("VITE_PORT", "5173"))
	backendName := envOr("BITSWAN_BACKEND", "backend")
	workers := parseWorkerHosts(os.Getenv("BITSWAN_WORKER_HOSTS"))

	mux := http.NewServeMux()

	// Backend-readiness gate. This process is the only thing Bailey exposes, so
	// the platform's scale-from-zero loading screen clears the moment WE answer
	// 200 — even if the private backend is still starting, leaving the user on a
	// live UI whose /api calls 503. So while the backend isn't yet reachable we
	// answer the app shell with 503 too, keeping the loading screen up until the
	// WHOLE app is ready (the backend loads before the frontend is served). A
	// startup deadline is the escape hatch: if the backend never comes up we stop
	// gating and serve anyway, so a crashed backend shows the app's own error
	// rather than an eternal spinner. No backend worker → nothing to wait for.
	var ready atomic.Bool
	backend, hasBackend := workers[backendName]
	if !hasBackend {
		ready.Store(true)
	} else {
		go awaitBackend(backend, &ready)
	}

	// /api → the backend worker, with the /api prefix stripped. Absent worker
	// → 503 (clearer than a vite 404), so a misconfigured BP is obvious.
	if hasBackend {
		proxy := httputil.NewSingleHostReverseProxy(backend)
		mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
			r.URL.Path = strings.TrimPrefix(r.URL.Path, "/api")
			if r.URL.Path == "" {
				r.URL.Path = "/"
			}
			proxy.ServeHTTP(w, r)
		})
		log.Printf("shim: /api/ → %s (worker %q)", backend, backendName)
	} else {
		mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "no backend worker configured", http.StatusServiceUnavailable)
		})
		log.Printf("shim: no worker named %q in BITSWAN_WORKER_HOSTS=%q; /api/ disabled",
			backendName, os.Getenv("BITSWAN_WORKER_HOSTS"))
	}

	// Everything else → vite. ReverseProxy passes through the HMR websocket
	// upgrade, so hot reload works behind the shim. Gated on backend readiness
	// (above) so the app shell isn't served before its backend can answer.
	vite := httputil.NewSingleHostReverseProxy(viteURL)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if !ready.Load() {
			w.Header().Set("Retry-After", "3")
			http.Error(w, "starting: waiting for the backend", http.StatusServiceUnavailable)
			return
		}
		vite.ServeHTTP(w, r)
	})

	log.Printf("shim listening on :%s, UI → %s", port, viteURL)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatalf("shim: %v", err)
	}
}

// awaitBackend flips ready once the backend accepts a TCP connection (it is
// listening), or once a startup deadline passes (escape hatch: never hide the
// app forever behind a dead backend). A plain TCP dial is image-agnostic — it
// needs nothing installed in the backend container.
func awaitBackend(backend *url.URL, ready *atomic.Bool) {
	host := backend.Host
	if host == "" {
		ready.Store(true)
		return
	}
	deadline := time.Now().Add(gateDeadline())
	for {
		conn, err := net.DialTimeout("tcp", host, 2*time.Second)
		if err == nil {
			_ = conn.Close()
			ready.Store(true)
			log.Printf("shim: backend %s is up — serving the app", host)
			return
		}
		if time.Now().After(deadline) {
			ready.Store(true)
			log.Printf("shim: backend %s still down after startup window — serving anyway", host)
			return
		}
		time.Sleep(time.Second)
	}
}

// gateDeadline is how long the shim keeps the loading screen up waiting for the
// backend before giving up and serving anyway. Overridable for slow backends.
func gateDeadline() time.Duration {
	if v := os.Getenv("BITSWAN_BACKEND_WAIT_SECONDS"); v != "" {
		if d, err := time.ParseDuration(v + "s"); err == nil && d > 0 {
			return d
		}
	}
	return 150 * time.Second
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
