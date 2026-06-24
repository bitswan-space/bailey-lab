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

// startEgressProbes makes real outbound HTTPS connections to the external
// services this invoice-processing automation legitimately talks to (vendor
// portals, the Czech business register, the payment gateway). It runs on
// startup and on a loop so the workspace's egress firewall observes each
// destination and surfaces it for review — the connection a default-deny
// firewall must see before it can be recorded (GDPR Art. 30) and allowed.
//
// The host list is BITSWAN_EGRESS_PROBES (comma-separated) with a sensible
// default matching the Meridian Foods scenario. These are GETs against the
// real internet; failures are expected when the firewall is in enforce mode
// and are logged, never fatal.
func startEgressProbes() {
	raw := envOr(
		"BITSWAN_EGRESS_PROBES",
		"ares.gov.cz,moravia-produkty.cz,api.gopay.com",
	)
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
	preseedLogo(mc, db)

	// In AOC mode KEYCLOAK_ISSUER_URL is injected and the backend validates JWTs
	// itself. In simple/no-AOC mode it's absent — the Bailey gate authenticates
	// upstream — so run without a JWKS provider rather than refusing to start.
	var jwks *JWKSProvider
	if issuerURL := os.Getenv("KEYCLOAK_ISSUER_URL"); issuerURL != "" {
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
	mux.Handle("GET /internal/count", app.requireAuth(http.HandlerFunc(app.handleGetCount)))
	mux.Handle("POST /internal/count", app.requireAuth(http.HandlerFunc(app.handleIncrementCount)))
	mux.Handle("GET /internal/gallery", app.requireAuth(http.HandlerFunc(app.handleListGallery)))
	mux.Handle("GET /internal/gallery/{filename...}", app.requireAuth(http.HandlerFunc(app.handleGetGalleryImage)))
	mux.Handle("POST /internal/gallery/upload", app.requireAuth(http.HandlerFunc(app.handleUploadGalleryImage)))
	mux.Handle("DELETE /internal/gallery/{filename...}", app.requireAuth(http.HandlerFunc(app.handleDeleteGalleryImage)))

	handler := corsMiddleware(mux)

	// Reach out to the external services this invoice flow integrates with so
	// the egress firewall can observe (and the operator can review) them.
	startEgressProbes()

	log.Println("listening on :8080")
	if err := http.ListenAndServe(":8080", handler); err != nil {
		log.Fatal(err)
	}
}
