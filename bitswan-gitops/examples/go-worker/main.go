package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode"

	"github.com/minio/minio-go/v7"
	"gorm.io/gorm"
)

// startEgressProbes exercises the external hosts this automation integrates
// with — BITSWAN_EGRESS_PROBES, comma-separated; unset means no probes. Each
// host gets a real outbound HTTPS GET on startup and on a loop, so the
// workspace's egress firewall observes the destination and surfaces it under
// "Needs review", where it can be recorded (GDPR Art. 30) and allowed before
// the firewall moves to enforce mode. Failures are expected while a host is
// unapproved in enforce mode; they are logged, never fatal.
func startEgressProbes() {
	raw := os.Getenv("BITSWAN_EGRESS_PROBES")
	var hosts []string
	for _, h := range strings.Split(raw, ",") {
		if h = strings.TrimSpace(h); h != "" {
			hosts = append(hosts, h)
		}
	}
	if len(hosts) == 0 {
		return
	}
	client := &http.Client{Timeout: 8 * time.Second}
	probe := func() {
		for _, h := range hosts {
			url := "https://" + h + "/"
			req, err := http.NewRequestWithContext(
				context.Background(), http.MethodGet, url, nil,
			)
			if err != nil {
				continue
			}
			resp, err := client.Do(req)
			if err != nil {
				log.Printf("egress probe %s: blocked/failed (firewall): %v", h, err)
				continue
			}
			resp.Body.Close()
			log.Printf("egress probe %s: reached (status %d)", h, resp.StatusCode)
		}
	}
	go func() {
		probe() // immediately on startup
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			probe()
		}
	}()
}

// App holds shared dependencies.
type App struct {
	db   *gorm.DB
	mc   *minio.Client
	jwks *JWKSProvider
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("required environment variable %s is not set", key)
	}
	return v
}

// capitalizeWords uppercases the first letter of each space-separated word.
func capitalizeWords(s string) string {
	words := strings.Fields(s)
	for i, w := range words {
		if len(w) > 0 {
			runes := []rune(w)
			runes[0] = unicode.ToUpper(runes[0])
			words[i] = string(runes)
		}
	}
	return strings.Join(words, " ")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"detail": msg})
}

// corsMiddleware wraps an http.Handler with permissive CORS headers.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	db := mustInitDB()
	sqlDB, _ := db.DB()
	defer sqlDB.Close()

	mc := mustInitMinio()
	ensureBucket(mc)

	// Auth posture (see README.md, "Identity & admin contract"): with
	// KEYCLOAK_ISSUER_URL injected (AOC mode) the backend validates Bearer
	// JWTs itself. Without it the worker only continues when the platform
	// genuinely has no identity provider — an AOC-connected platform that
	// failed to inject the issuer is a misconfiguration and refusing to
	// start beats silently trusting every request.
	issuerURL := os.Getenv("KEYCLOAK_ISSUER_URL")
	fatal, warning := resolveAuthStartup(
		issuerURL,
		os.Getenv("BITSWAN_AUTH_MODE"),
		os.Getenv("BITSWAN_AUTOMATION_STAGE"),
	)
	if fatal != "" {
		log.Fatal(fatal)
	}
	if warning != "" {
		log.Println("WARNING: " + warning)
	}
	var jwks *JWKSProvider
	if issuerURL != "" {
		jwks = NewJWKSProvider(issuerURL)
	} else {
		log.Println("KEYCLOAK_ISSUER_URL not set — simple mode: the Bailey gate authenticates upstream; backend does not validate JWTs itself.")
	}

	app := &App{db: db, mc: mc, jwks: jwks}

	mux := http.NewServeMux()

	// Health (no auth)
	mux.HandleFunc("GET /health", app.handleHealth)

	// Public routes (no auth)
	mux.HandleFunc("GET /public/", app.handlePublicRoot)
	mux.HandleFunc("GET /public/gallery", app.handleListGallery)
	mux.HandleFunc("GET /public/gallery/{filename...}", app.handleGetGalleryImage)

	// Internal routes (auth required)
	mux.Handle("GET /internal/", app.requireAuth(http.HandlerFunc(app.handleInternalRoot)))
	mux.Handle("GET /internal/me", app.requireAuth(http.HandlerFunc(app.handleWhoAmI)))
	mux.Handle("GET /internal/count", app.requireAuth(http.HandlerFunc(app.handleGetCount)))
	mux.Handle("POST /internal/count", app.requireAuth(http.HandlerFunc(app.handleIncrementCount)))
	mux.Handle("GET /internal/gallery", app.requireAuth(http.HandlerFunc(app.handleListGallery)))
	mux.Handle("GET /internal/gallery/{filename...}", app.requireAuth(http.HandlerFunc(app.handleGetGalleryImage)))
	mux.Handle("POST /internal/gallery/upload", app.requireAuth(http.HandlerFunc(app.handleUploadGalleryImage)))
	// Destructive op → admin-gated (BITSWAN_ADMIN_GROUP membership; see
	// README.md). The reference for role-gating an endpoint.
	mux.Handle("DELETE /internal/gallery/{filename...}", app.requireAdmin(http.HandlerFunc(app.handleDeleteGalleryImage)))

	handler := corsMiddleware(mux)

	// If BITSWAN_EGRESS_PROBES is configured, exercise those external hosts so
	// the egress firewall can observe (and the operator can review) them.
	startEgressProbes()

	// Listen on $PORT so gitops can place several workers in one shared
	// firewall-gateway netns without :8080 collisions; defaults to 8080.
	addr := ":" + envOr("PORT", "8080")
	log.Println("listening on " + addr)
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatal(err)
	}
}
