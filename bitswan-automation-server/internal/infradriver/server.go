package infradriver

import (
	"encoding/json"
	"fmt"
	"net/http"
)

// Server adapts a Driver's container primitives to the HTTP/SSE contract in
// api.go. Apply is NOT served here — it is the driver's git post-receive hook
// (see README). The caller wires this onto a listener on the private UNIX
// socket.
type Server struct {
	driver Driver
}

func NewServer(d Driver) *Server { return &Server{driver: d} }

// Handler returns the mux for the container-primitive endpoints.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(PathContainersList, s.handleList)
	mux.HandleFunc(PathContainersLogs, s.handleLogs)
	mux.HandleFunc(PathContainersStop, s.handleStop)
	mux.HandleFunc(PathContainersRestart, s.handleRestart)
	return mux
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	var body ListBody
	if !decode(w, r, &body) {
		return
	}
	containers, err := s.driver.ContainerList(r.Context(), body.Ctx, body.Filter)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, ContainerListResult{Containers: containers})
}

func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	var body LogsBody
	if !decode(w, r, &body) {
		return
	}
	sse, ok := newSSE(w)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	if err := s.driver.ContainerLogs(r.Context(), body.Ctx, body.Container, body.Tail, body.Follow,
		func(l LogLine) { sse.send(EventLog, l) }); err != nil {
		sse.send(EventError, ErrorResult{Error: err.Error()})
	}
}

func (s *Server) handleStop(w http.ResponseWriter, r *http.Request) {
	s.containerAction(w, r, func(ctx WorkspaceContext, name string) error {
		return s.driver.ContainerStop(r.Context(), ctx, name)
	})
}

func (s *Server) handleRestart(w http.ResponseWriter, r *http.Request) {
	s.containerAction(w, r, func(ctx WorkspaceContext, name string) error {
		return s.driver.ContainerRestart(r.Context(), ctx, name)
	})
}

func (s *Server) containerAction(w http.ResponseWriter, r *http.Request, run func(WorkspaceContext, string) error) {
	var body ContainerBody
	if !decode(w, r, &body) {
		return
	}
	if err := run(body.Ctx, body.Container); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, OKResult{OK: true})
}

// --- helpers ---

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		http.Error(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// sseWriter writes Server-Sent Events frames and flushes each one.
type sseWriter struct {
	w  http.ResponseWriter
	fl http.Flusher
}

func newSSE(w http.ResponseWriter) (*sseWriter, bool) {
	fl, ok := w.(http.Flusher)
	if !ok {
		return nil, false
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	fl.Flush()
	return &sseWriter{w: w, fl: fl}, true
}

func (s *sseWriter) send(event string, payload any) {
	b, err := json.Marshal(payload)
	if err != nil {
		b, _ = json.Marshal(ErrorResult{Error: "marshal " + event + ": " + err.Error()})
		event = EventError
	}
	fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", event, b)
	s.fl.Flush()
}
