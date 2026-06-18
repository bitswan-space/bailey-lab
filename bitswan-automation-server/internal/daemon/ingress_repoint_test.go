package daemon

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The repoint primitive's happy path rewrites the Traefik/protected-route
// upstream via addRouteTraefik (exercised by add-route integration tests) and
// saveProtectedRoute (TestStore_ProtectedRouteCRUD). Here we cover the handler
// guards that need no docker/traefik: method + required fields.
func TestHandleIngressRepointRoute_Guards(t *testing.T) {
	srv := &Server{}

	// Wrong method → 405.
	w := httptest.NewRecorder()
	srv.handleIngressRepointRoute(w, httptest.NewRequest(http.MethodGet, "/ingress/repoint-route", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET: want 405, got %d", w.Code)
	}

	// Missing hostname/upstream → 400.
	for _, body := range []string{`{}`, `{"hostname":"app.example.com"}`, `{"upstream":"ws-app-prod-b:80"}`} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, "/ingress/repoint-route", strings.NewReader(body))
		srv.handleIngressRepointRoute(w, r)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("body %s: want 400, got %d", body, w.Code)
		}
	}

	// Malformed JSON → 400.
	w = httptest.NewRecorder()
	srv.handleIngressRepointRoute(w, httptest.NewRequest(http.MethodPost, "/ingress/repoint-route", strings.NewReader("not json")))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad json: want 400, got %d", w.Code)
	}
}
