package infradriver

import (
	"encoding/json"
	"fmt"
	"net/http"
)

// Server adapts a Driver to the HTTP/SSE wire contract in api.go. It is a thin
// translation layer: unmarshal the request, call the Driver method with a
// callback that writes SSE frames, and emit exactly one terminal frame. The
// caller wires it onto a net.Listener on the private UNIX socket.
type Server struct {
	driver Driver
}

func NewServer(d Driver) *Server { return &Server{driver: d} }

// Handler returns the mux for all driver endpoints.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(PathApply, s.handleApply)
	mux.HandleFunc(PathBuildImage, s.handleBuildImage)
	mux.HandleFunc(PathSnapshot, s.handleSnapshot)
	mux.HandleFunc(PathRestore, s.handleRestore)
	mux.HandleFunc(PathStatus, s.handleStatus)
	mux.HandleFunc(PathLogs, s.handleLogs)
	mux.HandleFunc(PathEvents, s.handleEvents)
	return mux
}

// sseWriter writes Server-Sent Events frames and flushes each one so the client
// sees progress live.
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

// send writes one `event:`/`data:` frame. A marshal failure is reported as an
// error frame rather than silently dropped.
func (s *sseWriter) send(event string, payload any) {
	b, err := json.Marshal(payload)
	if err != nil {
		b, _ = json.Marshal(ErrorResult{Error: "marshal " + event + ": " + err.Error()})
		event = EventError
	}
	fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", event, b)
	s.fl.Flush()
}

// decode reads the JSON request body into v; on failure it writes a 400 and
// returns false.
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

func (s *Server) handleApply(w http.ResponseWriter, r *http.Request) {
	var req ApplyRequest
	if !decode(w, r, &req) {
		return
	}
	sse, ok := newSSE(w)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	routes, err := s.driver.Apply(r.Context(), req, func(p Progress) { sse.send(EventProgress, p) })
	if err != nil {
		sse.send(EventError, ErrorResult{Error: err.Error()})
		return
	}
	sse.send(EventDone, ApplyResult{Routes: routes})
}

func (s *Server) handleBuildImage(w http.ResponseWriter, r *http.Request) {
	var req BuildRequest
	if !decode(w, r, &req) {
		return
	}
	sse, ok := newSSE(w)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	img, err := s.driver.BuildImage(r.Context(), req, func(line string) { sse.send(EventLog, LogLine{Line: line}) })
	if err != nil {
		sse.send(EventError, ErrorResult{Error: err.Error()})
		return
	}
	sse.send(EventImage, img)
}

func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	var req SnapshotRequest
	if !decode(w, r, &req) {
		return
	}
	s.streamProgress(w, r, func(prog func(Progress)) error {
		return s.driver.Snapshot(r.Context(), req, prog)
	})
}

func (s *Server) handleRestore(w http.ResponseWriter, r *http.Request) {
	var req RestoreRequest
	if !decode(w, r, &req) {
		return
	}
	s.streamProgress(w, r, func(prog func(Progress)) error {
		return s.driver.Restore(r.Context(), req, prog)
	})
}

// streamProgress runs a progress-streaming op (snapshot/restore) and emits the
// done/error terminal frame.
func (s *Server) streamProgress(w http.ResponseWriter, r *http.Request, run func(prog func(Progress)) error) {
	sse, ok := newSSE(w)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	if err := run(func(p Progress) { sse.send(EventProgress, p) }); err != nil {
		sse.send(EventError, ErrorResult{Error: err.Error()})
		return
	}
	sse.send(EventDone, ApplyResult{})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	var body StatusBody
	if !decode(w, r, &body) {
		return
	}
	states, err := s.driver.Status(r.Context(), body.Ctx, body.DeploymentIDs)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(DeploymentStatus{States: states})
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
	if err := s.driver.Logs(r.Context(), body.Ctx, body.Container, body.Tail, body.Follow,
		func(l LogLine) { sse.send(EventLog, l) }); err != nil {
		sse.send(EventError, ErrorResult{Error: err.Error()})
	}
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	var ctx WorkspaceContext
	if !decode(w, r, &ctx) {
		return
	}
	sse, ok := newSSE(w)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	if err := s.driver.WatchEvents(r.Context(), ctx, func(e Event) { sse.send(EventEvent, e) }); err != nil {
		sse.send(EventError, ErrorResult{Error: err.Error()})
	}
}
